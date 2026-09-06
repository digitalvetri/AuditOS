import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import { writeAudit } from '../../platform/audit.js'
import { notifyEmployee } from '../../platform/notify.js'
import type { Session } from '../../platform/auth.js'
import { chatMessageToApi, type ChatSummary } from '../../api/serialize.js'
import { publishChatEvent } from './events.js'

/**
 * MESSAGES (§8.7).
 *
 * Internal organisation communication only. There is no client-facing surface
 * here and no route that could reach one: Chat.subjectType / subjectId are
 * modelled and left null, reserved for the Workstation.
 *
 * Membership is the authorization boundary — every read and write asserts it.
 */

export const SEEDED_GROUPS = [
  { code: 'GENERAL', name: 'Audit OS General', description: 'Everyone at Audit OS' },
  { code: 'MANAGEMENT', name: 'Management', description: 'Partners and managers' },
  { code: 'HR_TEAM', name: 'HR Team', description: 'Human resources' },
  { code: 'FINANCE_TEAM', name: 'Finance Team', description: 'Finance and accounts' },
  { code: 'OPERATIONS', name: 'Operations', description: 'Audit and office operations' },
]

function requireEmployee(session: Session): string {
  if (!session.employeeId) {
    throw ApiError.unprocessable('no_employee', 'This account has no employee record.')
  }
  return session.employeeId
}

async function requireMembership(chatId: string, employeeId: string) {
  const member = await prisma.chatMember.findFirst({
    where: { chatId, employeeId, deletedAt: null },
  })
  if (!member) throw ApiError.forbidden('You are not a member of this conversation.')
  return member
}

export async function listChats(session: Session): Promise<ChatSummary[]> {
  const employeeId = requireEmployee(session)
  const memberships = await prisma.chatMember.findMany({
    where: { employeeId, deletedAt: null },
    include: {
      chat: {
        include: {
          members: { where: { deletedAt: null }, include: { employee: true } },
          messages: {
            where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 1,
            include: { sender: true },
          },
        },
      },
    },
  })

  const out: ChatSummary[] = []
  for (const m of memberships) {
    if (m.chat.deletedAt) continue
    const unread = await prisma.chatMessage.count({
      where: {
        chatId: m.chatId,
        deletedAt: null,
        senderEmployeeId: { not: employeeId },
        ...(m.lastReadAt ? { createdAt: { gt: m.lastReadAt } } : {}),
      },
    })
    const others = m.chat.members.filter((x) => x.employeeId !== employeeId)
    const last = m.chat.messages[0]
    out.push({
      id: m.chat.id,
      type: m.chat.type,
      name: m.chat.type === 'DIRECT'
        ? (others[0]?.employee.fullName ?? 'Direct message')
        : (m.chat.name ?? 'Conversation'),
      description: m.chat.description,
      is_system: m.chat.isSystem,
      member_count: m.chat.members.length,
      members: m.chat.members.map((x) => ({
        employee_id: x.employeeId,
        full_name: x.employee.fullName,
        employee_code: x.employee.employeeCode,
      })),
      unread_count: unread,
      last_message: last
        ? { body: last.body, at: last.createdAt.toISOString(), sender: last.sender.fullName }
        : null,
      last_activity_at: (last?.createdAt ?? m.chat.createdAt).toISOString(),
    })
  }
  return out.sort((a, b) => (a.last_activity_at < b.last_activity_at ? 1 : -1))
}

export async function totalUnread(employeeId: string): Promise<number> {
  const memberships = await prisma.chatMember.findMany({
    where: { employeeId, deletedAt: null }, select: { chatId: true, lastReadAt: true },
  })
  let total = 0
  for (const m of memberships) {
    total += await prisma.chatMessage.count({
      where: {
        chatId: m.chatId, deletedAt: null, senderEmployeeId: { not: employeeId },
        ...(m.lastReadAt ? { createdAt: { gt: m.lastReadAt } } : {}),
      },
    })
  }
  return total
}

/** A direct message reuses the existing thread rather than opening a second one. */
export async function createChat(
  session: Session,
  input: { type: 'GROUP' | 'DIRECT'; name?: string; member_employee_ids: string[] },
) {
  const employeeId = requireEmployee(session)
  const members = Array.from(new Set([employeeId, ...input.member_employee_ids]))

  if (input.type === 'DIRECT') {
    if (members.length !== 2) {
      throw ApiError.unprocessable('direct_participants', 'A direct message has exactly two participants.')
    }
    const existing = await prisma.chat.findFirst({
      where: {
        type: 'DIRECT', deletedAt: null,
        AND: members.map((id) => ({ members: { some: { employeeId: id, deletedAt: null } } })),
      },
    })
    if (existing) return { id: existing.id, existing: true }
  } else if (!input.name?.trim()) {
    throw ApiError.unprocessable('name_required', 'Give the group a name.')
  }

  const found = await prisma.employee.findMany({
    where: { id: { in: members }, deletedAt: null }, select: { id: true },
  })
  if (found.length !== members.length) {
    throw ApiError.unprocessable('unknown_participant', 'One or more participants could not be found.')
  }

  const chat = await prisma.chat.create({
    data: {
      type: input.type,
      name: input.type === 'GROUP' ? input.name!.trim() : null,
      createdBy: session.userId,
      updatedBy: session.userId,
      members: {
        create: members.map((id) => ({
          employeeId: id,
          role: id === employeeId ? 'OWNER' : 'MEMBER',
          createdBy: session.userId,
        })),
      },
    },
  })
  return { id: chat.id, existing: false }
}

export async function listMessages(
  chatId: string, session: Session, opts: { search?: string; before?: Date; take?: number },
) {
  const employeeId = requireEmployee(session)
  await requireMembership(chatId, employeeId)
  const rows = await prisma.chatMessage.findMany({
    where: {
      chatId,
      deletedAt: null,
      ...(opts.search ? { body: { contains: opts.search } } : {}),
      ...(opts.before ? { createdAt: { lt: opts.before } } : {}),
    },
    include: {
      sender: true,
      replyTo: { include: { sender: true } },
      reads: { select: { employeeId: true, readAt: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: opts.take ?? 200,
  })
  return rows.map(chatMessageToApi)
}

/** Detect @mentions against the members of this conversation only. */
async function detectMentions(chatId: string, body: string, senderEmployeeId: string) {
  if (!body.includes('@')) return []
  const members = await prisma.chatMember.findMany({
    where: { chatId, deletedAt: null }, include: { employee: true },
  })
  const lower = body.toLowerCase()
  return members
    .filter((m) => m.employeeId !== senderEmployeeId)
    .filter((m) => {
      const e = m.employee
      return lower.includes(`@${e.firstName.toLowerCase()}`)
        || lower.includes(`@${e.employeeCode.toLowerCase()}`)
        || lower.includes(`@${e.firstName.toLowerCase()}.${e.lastName.toLowerCase()}`)
    })
    .map((m) => m.employeeId)
}

export async function postMessage(
  chatId: string, session: Session,
  input: { body: string; reply_to_id?: string; attachment_name?: string | null },
) {
  const employeeId = requireEmployee(session)
  await requireMembership(chatId, employeeId)
  if (!input.body.trim()) {
    throw ApiError.unprocessable('empty_message', 'Write a message before sending.')
  }

  const chat = await prisma.chat.findFirst({
    where: { id: chatId, deletedAt: null },
    include: { members: { where: { deletedAt: null } } },
  })
  if (!chat) throw ApiError.notFound('Conversation not found.')

  const mentions = await detectMentions(chatId, input.body, employeeId)
  const message = await prisma.chatMessage.create({
    data: {
      chatId,
      senderEmployeeId: employeeId,
      body: input.body.trim(),
      replyToId: input.reply_to_id ?? null,
      attachmentName: input.attachment_name ?? null,
      mentionsJson: JSON.stringify(mentions),
      createdBy: session.userId,
      updatedBy: session.userId,
    },
    include: {
      sender: true,
      replyTo: { include: { sender: true } },
      reads: { select: { employeeId: true, readAt: true } },
    },
  })

  const serialized = chatMessageToApi(message)
  publishChatEvent({
    chatId,
    memberEmployeeIds: chat.members.map((m) => m.employeeId),
    type: 'message:new',
    payload: serialized,
  })

  const senderName = message.sender.fullName
  for (const id of mentions) {
    await notifyEmployee(id, {
      type: 'message.mention', module: 'message',
      title: `${senderName} mentioned you`,
      body: message.body.slice(0, 160),
      entityType: 'Chat', entityId: chatId, actionUrl: `/hrms/messages/${chatId}`,
    })
  }
  if (chat.type === 'DIRECT') {
    for (const m of chat.members) {
      if (m.employeeId === employeeId || mentions.includes(m.employeeId)) continue
      await notifyEmployee(m.employeeId, {
        type: 'message.direct', module: 'message',
        title: `New message from ${senderName}`,
        body: message.body.slice(0, 160),
        entityType: 'Chat', entityId: chatId, actionUrl: `/hrms/messages/${chatId}`,
      })
    }
  }
  return serialized
}

export async function markRead(chatId: string, session: Session) {
  const employeeId = requireEmployee(session)
  await requireMembership(chatId, employeeId)
  const now = new Date()

  await prisma.chatMember.updateMany({ where: { chatId, employeeId }, data: { lastReadAt: now } })
  const unread = await prisma.chatMessage.findMany({
    where: {
      chatId, deletedAt: null, senderEmployeeId: { not: employeeId },
      reads: { none: { employeeId } },
    },
    select: { id: true },
  })
  if (unread.length) {
    await prisma.messageRead.createMany({
      data: unread.map((m) => ({ messageId: m.id, employeeId, readAt: now })),
    })
  }
  publishChatEvent({
    chatId, memberEmployeeIds: [employeeId], type: 'chat:read',
    payload: { chat_id: chatId, at: now.toISOString() },
  })
  return { chat_id: chatId, read_at: now.toISOString() }
}

export async function reactToMessage(messageId: string, session: Session, emoji: string) {
  const employeeId = requireEmployee(session)
  const message = await prisma.chatMessage.findFirst({ where: { id: messageId, deletedAt: null } })
  if (!message) throw ApiError.notFound('Message not found.')
  await requireMembership(message.chatId, employeeId)

  const reactions = JSON.parse(message.reactionsJson) as Record<string, string[]>
  const list = reactions[emoji] ?? []
  // Toggle: reacting twice removes the reaction.
  reactions[emoji] = list.includes(employeeId)
    ? list.filter((id) => id !== employeeId)
    : [...list, employeeId]
  if (reactions[emoji].length === 0) delete reactions[emoji]

  await prisma.chatMessage.update({
    where: { id: messageId },
    data: { reactionsJson: JSON.stringify(reactions), updatedBy: session.userId },
  })
  const members = await prisma.chatMember.findMany({
    where: { chatId: message.chatId, deletedAt: null }, select: { employeeId: true },
  })
  publishChatEvent({
    chatId: message.chatId,
    memberEmployeeIds: members.map((m) => m.employeeId),
    type: 'message:updated',
    payload: { id: messageId, reactions },
  })
  return { id: messageId, reactions }
}

/** Soft delete — messages are retained for audit (§8.7). */
export async function deleteMessage(messageId: string, session: Session) {
  const employeeId = requireEmployee(session)
  const message = await prisma.chatMessage.findFirst({ where: { id: messageId, deletedAt: null } })
  if (!message) throw ApiError.notFound('Message not found.')
  if (message.senderEmployeeId !== employeeId) {
    throw ApiError.forbidden('You can only delete your own message.')
  }
  const now = new Date()
  await prisma.chatMessage.update({
    where: { id: messageId }, data: { deletedAt: now, updatedBy: session.userId },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'message.deleted',
    entityType: 'ChatMessage', entityId: messageId,
    before: { body: message.body }, after: { deleted_at: now.toISOString() },
  })
  const members = await prisma.chatMember.findMany({
    where: { chatId: message.chatId, deletedAt: null }, select: { employeeId: true },
  })
  publishChatEvent({
    chatId: message.chatId,
    memberEmployeeIds: members.map((m) => m.employeeId),
    type: 'message:deleted',
    payload: { id: messageId },
  })
  return { id: messageId, deleted: true }
}

/** Colleagues a DM can be opened with. Internal directory only. */
export async function directory(session: Session) {
  const rows = await prisma.employee.findMany({
    where: {
      deletedAt: null, status: { not: 'inactive' },
      ...(session.employeeId ? { id: { not: session.employeeId } } : {}),
    },
    include: { department: true, designation: true },
    orderBy: { fullName: 'asc' },
  })
  return rows.map((e) => ({
    id: e.id,
    full_name: e.fullName,
    employee_code: e.employeeCode,
    department: e.department.name,
    designation: e.designation.name,
  }))
}
