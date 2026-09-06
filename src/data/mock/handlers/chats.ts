/**
 * Chats / Messages handlers per §8.7 + §9.
 *
 *   GET  /api/chats                   caller's joined chats + unread + total
 *   POST /api/chats                   create a DM (idempotent for same pair)
 *                                     or a group (chat.manage — MD only)
 *   GET  /api/chats/:id/messages      caller must be a member (or MD)
 *   POST /api/chats/:id/messages      writes MessageRead for author,
 *                                     notifies other members, updates last_message_at
 *   POST /api/chats/:id/read          marks all messages up to a given id read
 *
 * Membership is authoritative for BOTH read and write. UI hiding is not
 * a security control. `chat.manage` (MD) overrides the membership check.
 */

import { http } from 'msw';
import type { Chat, ChatMessage, Employee, MessageRead, RoleCode } from '@/data/models';
import { db } from '../db';
import { audit, err, ok, withAuth } from '../middleware';
import { hasPermission } from '@/platform/rbac/matrix';

const nowISO = () => new Date().toISOString();

function roleOf(userId: string): RoleCode | null {
  const u = db.read().users.find((x) => x.id === userId);
  if (!u) return null;
  return db.read().roles.find((x) => x.id === u.role_id)?.code ?? null;
}
function canManageChats(role: RoleCode): boolean {
  return hasPermission(role, 'chat.manage', 'organisation');
}
function isMember(chatId: string, employeeId: string): boolean {
  return db.read().chatMembers.some(
    (m) => m.chat_id === chatId && m.employee_id === employeeId && !m.left_at,
  );
}

function dmDisplayName(chat: Chat, callerEmployeeId: string): string {
  if (chat.type !== 'dm') return chat.name ?? 'Chat';
  const other = db.read().chatMembers.find(
    (m) => m.chat_id === chat.id && m.employee_id !== callerEmployeeId,
  );
  if (!other) return 'Direct message';
  const emp = db.read().employees.find((e) => e.id === other.employee_id);
  return emp?.full_name ?? 'Direct message';
}

function unreadForChat(chatId: string, employeeId: string): number {
  const msgs = db.read().chatMessages.filter(
    (m) => m.chat_id === chatId && !m.deleted_at && m.author_employee_id !== employeeId,
  );
  const reads = new Set(
    db
      .read()
      .messageReads.filter((r) => r.chat_id === chatId && r.employee_id === employeeId)
      .map((r) => r.message_id),
  );
  return msgs.filter((m) => !reads.has(m.id)).length;
}

function notify(userId: string, n: {
  type: string; title: string; body: string; entity_id?: string | null; action_url?: string | null;
}): void {
  db.write((d) => {
    d.notifications.push({
      id: `ntf-${crypto.randomUUID()}`,
      user_id: userId,
      type: n.type,
      module: 'message',
      entity_type: 'ChatMessage',
      entity_id: n.entity_id ?? null,
      title: n.title,
      body: n.body,
      action_url: n.action_url ?? null,
      is_read: false,
      created_at: nowISO(),
    });
  });
}

export const chatHandlers = [
  // GET /api/chats
  http.get(
    '/api/chats',
    withAuth(async ({ user, employee }) => {
      if (!employee) return ok({ items: [], total_unread: 0 });
      const role = roleOf(user.id)!;
      const canManage = canManageChats(role);

      // Everyone with `chat.participate` sees their own chats. `chat.manage`
      // (MD) sees all chats. Membership is derived, not from role.
      const memberChatIds = new Set(
        db
          .read()
          .chatMembers.filter((m) => m.employee_id === employee.id && !m.left_at)
          .map((m) => m.chat_id),
      );
      const chats = db
        .read()
        .chats.filter((c) => !c.deleted_at)
        .filter((c) => memberChatIds.has(c.id) || canManage);

      const items = chats.map((c) => {
        const lastMsg = c.last_message_at
          ? db.read().chatMessages
              .filter((m) => m.chat_id === c.id && !m.deleted_at)
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]
          : null;
        const memberCount = db.read().chatMembers.filter((m) => m.chat_id === c.id && !m.left_at).length;
        return {
          ...c,
          display_name: dmDisplayName(c, employee.id),
          last_message: lastMsg
            ? { id: lastMsg.id, body: lastMsg.body, created_at: lastMsg.created_at, author_id: lastMsg.author_employee_id }
            : null,
          unread: memberChatIds.has(c.id) ? unreadForChat(c.id, employee.id) : 0,
          member_count: memberCount,
        };
      });
      // Sort by last activity (newest first). Chats with no messages fall to the bottom.
      items.sort((a, b) => {
        const aT = a.last_message_at ?? '';
        const bT = b.last_message_at ?? '';
        return aT === bT ? 0 : aT < bT ? 1 : -1;
      });
      const total_unread = items.reduce((s, c) => s + c.unread, 0);
      return ok({ items, total_unread });
    }),
  ),

  // POST /api/chats — create DM (idempotent per pair) or group (MD only)
  http.post(
    '/api/chats',
    withAuth(async ({ user, employee, request }) => {
      if (!employee) return err(422, 'no_employee', 'This account has no employee record.');
      const body = (await request.json().catch(() => ({}))) as {
        type?: 'group' | 'dm';
        name?: string;
        description?: string;
        member_ids?: string[]; // for group
        other_employee_id?: string; // for dm
      };
      const type = body.type ?? 'dm';
      const role = roleOf(user.id)!;

      if (type === 'dm') {
        const other = body.other_employee_id;
        if (!other) return err(400, 'validation', 'other_employee_id required for a DM.');
        if (other === employee.id) return err(422, 'self_dm', 'You cannot DM yourself.');
        const target = db.read().employees.find((e) => e.id === other);
        if (!target || target.deleted_at) return err(422, 'invalid_target', 'Unknown or inactive employee.');

        // Uniqueness: return the existing DM chat if one exists between this pair.
        const existing = db.read().chats.find((c) => {
          if (c.type !== 'dm' || c.deleted_at) return false;
          const pair = db.read().chatMembers.filter((m) => m.chat_id === c.id && !m.left_at).map((m) => m.employee_id);
          return pair.length === 2 && pair.includes(employee.id) && pair.includes(other);
        });
        if (existing) return ok({ chat: existing, created: false });

        const now = nowISO();
        const chatId = `chat-dm-${crypto.randomUUID()}`;
        const chat: Chat = {
          id: chatId,
          organisation_id: db.read().organisation.id,
          type: 'dm',
          name: null,
          description: null,
          subject_type: null,
          subject_id: null,
          last_message_at: null,
          created_at: now,
          updated_at: now,
          created_by: user.id,
          updated_by: user.id,
          deleted_at: null,
        };
        db.write((d) => {
          d.chats.push(chat);
          for (const eId of [employee.id, other]) {
            d.chatMembers.push({
              id: `cm-${chatId}-${eId}`,
              chat_id: chatId,
              employee_id: eId,
              role: 'member',
              joined_at: now,
              left_at: null,
            });
          }
        });
        audit({ actor_user_id: user.id, action: 'chat.dm_created', entity_type: 'Chat', entity_id: chatId, after_json: { with: other }, request });
        return ok({ chat, created: true });
      }

      // Group.
      if (!canManageChats(role)) return err(403, 'forbidden', 'Only MD can create group chats.');
      if (!body.name?.trim()) return err(400, 'validation', 'name required for a group.');
      const memberIds = body.member_ids?.filter(Boolean) ?? [];
      if (memberIds.length < 2) return err(422, 'too_few_members', 'A group needs at least 2 members.');
      const invalidMember = memberIds.find(
        (id) => !db.read().employees.some((e) => e.id === id && !e.deleted_at),
      );
      if (invalidMember) return err(422, 'invalid_target', `Unknown/inactive employee: ${invalidMember}`);

      const now = nowISO();
      const chatId = `chat-${crypto.randomUUID()}`;
      const chat: Chat = {
        id: chatId,
        organisation_id: db.read().organisation.id,
        type: 'group',
        name: body.name.trim(),
        description: body.description ?? null,
        subject_type: null,
        subject_id: null,
        last_message_at: null,
        created_at: now,
        updated_at: now,
        created_by: user.id,
        updated_by: user.id,
        deleted_at: null,
      };
      db.write((d) => {
        d.chats.push(chat);
        for (const eId of memberIds) {
          d.chatMembers.push({
            id: `cm-${chatId}-${eId}`,
            chat_id: chatId,
            employee_id: eId,
            role: eId === employee.id ? 'admin' : 'member',
            joined_at: now,
            left_at: null,
          });
        }
      });
      audit({ actor_user_id: user.id, action: 'chat.group_created', entity_type: 'Chat', entity_id: chatId, after_json: { name: body.name, members: memberIds.length }, request });
      return ok({ chat, created: true });
    }),
  ),

  // GET /api/chats/:id/messages
  http.get(
    '/api/chats/:id/messages',
    withAuth(async ({ user, employee, params }) => {
      if (!employee) return err(403, 'forbidden', 'Access denied.');
      const chatId = String(params.id);
      const chat = db.read().chats.find((c) => c.id === chatId && !c.deleted_at);
      if (!chat) return err(404, 'not_found', 'Chat not found.');
      const role = roleOf(user.id)!;
      if (!isMember(chatId, employee.id) && !canManageChats(role)) {
        return err(403, 'forbidden', 'You are not a member of this chat.');
      }
      const rows = db.read().chatMessages
        .filter((m) => m.chat_id === chatId && !m.deleted_at)
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

      const readIds = new Set(
        db.read().messageReads
          .filter((r) => r.chat_id === chatId && r.employee_id === employee.id)
          .map((r) => r.message_id),
      );

      const items = rows.map((m) => {
        const author: Employee | undefined = db.read().employees.find((e) => e.id === m.author_employee_id);
        // Parent preview inline — resolve to body or "(deleted message)".
        let parent_preview: { id: string; body: string; author_full_name: string | null } | null = null;
        if (m.parent_id) {
          const p = db.read().chatMessages.find((x) => x.id === m.parent_id);
          if (p) {
            const pAuthor = db.read().employees.find((e) => e.id === p.author_employee_id);
            parent_preview = {
              id: p.id,
              body: p.deleted_at ? '(deleted message)' : p.body.length > 80 ? p.body.slice(0, 80) + '…' : p.body,
              author_full_name: pAuthor?.full_name ?? null,
            };
          }
        }
        return {
          ...m,
          author: author
            ? { id: author.id, full_name: author.full_name, employee_code: author.employee_code }
            : null,
          parent_preview,
          read_by_me: readIds.has(m.id),
        };
      });
      return ok({ chat: { ...chat, display_name: dmDisplayName(chat, employee.id) }, items });
    }),
  ),

  // POST /api/chats/:id/messages
  http.post(
    '/api/chats/:id/messages',
    withAuth(async ({ user, employee, params, request }) => {
      if (!employee) return err(403, 'forbidden', 'Access denied.');
      const chatId = String(params.id);
      const chat = db.read().chats.find((c) => c.id === chatId && !c.deleted_at);
      if (!chat) return err(404, 'not_found', 'Chat not found.');
      if (!isMember(chatId, employee.id)) {
        // MD override does NOT apply to POST — writing as a non-member would
        // impersonate group presence. Read-only override only.
        return err(403, 'forbidden', 'You are not a member of this chat.');
      }
      const body = (await request.json().catch(() => ({}))) as { body?: string; parent_id?: string };
      const text = body.body?.trim();
      if (!text) return err(400, 'validation', 'Message body is required.');
      if (text.length > 4000) return err(422, 'too_long', 'Message exceeds 4000 characters.');
      if (body.parent_id) {
        const parent = db.read().chatMessages.find((m) => m.id === body.parent_id && m.chat_id === chatId);
        if (!parent) return err(422, 'invalid_parent', 'Parent message not in this chat.');
      }

      const now = nowISO();
      const msg: ChatMessage = {
        id: `msg-${crypto.randomUUID()}`,
        chat_id: chatId,
        author_employee_id: employee.id,
        body: text,
        parent_id: body.parent_id ?? null,
        mentions: [],
        created_at: now,
        updated_at: now,
        deleted_at: null,
      };
      db.write((d) => {
        d.chatMessages.push(msg);
        // Author reads their own message immediately.
        d.messageReads.push({
          id: `mr-${msg.id}-${employee.id}`,
          chat_id: chatId,
          message_id: msg.id,
          employee_id: employee.id,
          read_at: now,
        });
        const c = d.chats.find((x) => x.id === chatId)!;
        c.last_message_at = now;
        c.updated_at = now;
      });

      // Notify other active members (only DMs per spec §8.9; groups get UI-only badge).
      // For DMs: single notification to the other member.
      if (chat.type === 'dm') {
        const others = db.read().chatMembers.filter((m) => m.chat_id === chatId && !m.left_at && m.employee_id !== employee.id);
        for (const om of others) {
          const otherUser = db.read().users.find((u) => u.employee_id === om.employee_id);
          if (otherUser) {
            notify(otherUser.id, {
              type: 'chat.dm_new',
              title: `New message from ${employee.full_name}`,
              body: text.length > 80 ? text.slice(0, 80) + '…' : text,
              entity_id: msg.id,
              action_url: `/hrms/messages?chat=${chatId}`,
            });
          }
        }
      }

      audit({
        actor_user_id: user.id,
        action: 'chat.message_sent',
        entity_type: 'ChatMessage',
        entity_id: msg.id,
        after_json: { chat_id: chatId, has_parent: !!msg.parent_id },
        request,
      });
      const author = db.read().employees.find((e) => e.id === employee.id);
      return ok({
        message: {
          ...msg,
          author: author
            ? { id: author.id, full_name: author.full_name, employee_code: author.employee_code }
            : null,
          parent_preview: null,
          read_by_me: true,
        },
      });
    }),
  ),

  // POST /api/chats/:id/read  — mark all up to message_id read
  http.post(
    '/api/chats/:id/read',
    withAuth(async ({ employee, params, request }) => {
      if (!employee) return err(403, 'forbidden', 'Access denied.');
      const chatId = String(params.id);
      if (!isMember(chatId, employee.id)) return err(403, 'forbidden', 'You are not a member of this chat.');
      const body = (await request.json().catch(() => ({}))) as { message_id?: string };
      const target = body.message_id ? db.read().chatMessages.find((m) => m.id === body.message_id) : null;
      if (body.message_id && (!target || target.chat_id !== chatId)) {
        return err(422, 'invalid_message', 'Message not in this chat.');
      }
      const cutoff = target?.created_at ?? nowISO();

      const existingReadIds = new Set(
        db.read().messageReads
          .filter((r) => r.chat_id === chatId && r.employee_id === employee.id)
          .map((r) => r.message_id),
      );
      const toRead = db.read().chatMessages.filter(
        (m) => m.chat_id === chatId && !m.deleted_at && m.created_at <= cutoff && !existingReadIds.has(m.id),
      );
      const now = nowISO();
      const newReads: MessageRead[] = toRead.map((m) => ({
        id: `mr-${m.id}-${employee.id}`,
        chat_id: chatId,
        message_id: m.id,
        employee_id: employee.id,
        read_at: now,
      }));
      db.write((d) => {
        d.messageReads.push(...newReads);
      });
      // No audit or notification on read — high frequency, low value.
      return ok({ marked: newReads.length });
    }),
  ),
];

/** Exposed for the TopBar messages badge. */
export function totalUnreadFor(employeeId: string): number {
  let total = 0;
  for (const m of db.read().chatMembers) {
    if (m.employee_id !== employeeId || m.left_at) continue;
    total += unreadForChat(m.chat_id, employeeId);
  }
  return total;
}
