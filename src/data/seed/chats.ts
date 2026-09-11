/**
 * Chats seed per §13:
 *   - 6 group chats (Audit OS General, Management, HR Team, Finance Team,
 *     GST Team, Operations)
 *   - 2 DM threads
 *   - a few messages each
 *
 * Membership derived from department + role AT SEED TIME. Not re-derived on
 * every request — that would auto-add someone when their department changes,
 * which is spec-silent and usually wrong (chat history predates them).
 */

import type { Chat, ChatMember, ChatMessage, MessageRead } from '@/data/models';
import { organisation, employees } from './index';
import { extraEmployees } from './extraEmployees';

const now = new Date().toISOString();
const audit = () => ({
  created_at: now,
  updated_at: now,
  created_by: null,
  updated_by: null,
  deleted_at: null,
});

const activeEmployees = [...employees, ...extraEmployees].filter(
  (e) => e.status !== 'inactive',
);

function membersFrom(empIds: string[], adminIds: string[] = []): Omit<ChatMember, 'chat_id'>[] {
  return empIds.map((id) => ({
    id: `cm-${id}-placeholder`, // rewritten with chat_id below
    employee_id: id,
    role: adminIds.includes(id) ? ('admin' as const) : ('member' as const),
    joined_at: now,
    left_at: null,
  }));
}

interface SeedGroup {
  id: string;
  name: string;
  description: string;
  memberFilter: (empIds: string[]) => string[];
  admin: string[];
}

const seedGroups: SeedGroup[] = [
  {
    id: 'chat-general',
    name: 'JNS Accounting Solutions General',
    description: 'Firm-wide announcements and general chatter.',
    memberFilter: (all) => all,
    admin: ['emp-md'],
  },
  {
    id: 'chat-mgmt',
    name: 'Management',
    description: 'Partners + managers.',
    memberFilter: () => activeEmployees.filter((e) => e.type === 'partner' || e.type === 'manager').map((e) => e.id),
    admin: ['emp-md'],
  },
  {
    id: 'chat-hr',
    name: 'HR Team',
    description: 'HR department + MD.',
    memberFilter: () => activeEmployees.filter((e) => e.department_id === 'dep-hr' || e.id === 'emp-md').map((e) => e.id),
    admin: ['emp-hr'],
  },
  {
    id: 'chat-finance',
    name: 'Finance Team',
    description: 'Finance department + MD.',
    memberFilter: () => activeEmployees.filter((e) => e.department_id === 'dep-fin' || e.id === 'emp-md').map((e) => e.id),
    admin: ['emp-fin'],
  },
  {
    id: 'chat-gst',
    name: 'GST Team',
    description: 'GST filings work.',
    // No dep-gst in seed; represent as Ops + MD (spec sample list; adjust when GST dept lands).
    memberFilter: () => activeEmployees.filter((e) => e.department_id === 'dep-ops' || e.id === 'emp-md').map((e) => e.id),
    admin: ['emp-md'],
  },
  {
    id: 'chat-ops',
    name: 'Operations',
    description: 'Audit + field operations.',
    memberFilter: () => activeEmployees.filter((e) => e.department_id === 'dep-ops').map((e) => e.id),
    admin: ['emp-mgr'],
  },
];

// ── DMs ──────────────────────────────────────────────────────────────────
const seedDMs: { id: string; between: [string, string] }[] = [
  { id: 'chat-dm-meera-vikram', between: ['emp-exec', 'emp-mgr'] },
  { id: 'chat-dm-priya-md', between: ['emp-hr', 'emp-md'] },
];

// ── Build ────────────────────────────────────────────────────────────────
export const chats: Chat[] = [];
export const chatMembers: ChatMember[] = [];
export const chatMessages: ChatMessage[] = [];
export const messageReads: MessageRead[] = [];

let msgSeq = 1;
function msg(chatId: string, authorId: string, body: string, parentId: string | null = null): ChatMessage {
  const id = `msg-${String(msgSeq).padStart(4, '0')}`;
  msgSeq += 1;
  // Space message timestamps a few minutes apart so ordering is deterministic.
  const at = new Date(Date.now() - (200 - msgSeq) * 60_000).toISOString();
  return {
    id,
    chat_id: chatId,
    author_employee_id: authorId,
    body,
    parent_id: parentId,
    mentions: [],
    created_at: at,
    updated_at: at,
    deleted_at: null,
  };
}

// Groups.
for (const g of seedGroups) {
  const memberIds = g.memberFilter(activeEmployees.map((e) => e.id));
  chats.push({
    id: g.id,
    organisation_id: organisation.id,
    type: 'group',
    name: g.name,
    description: g.description,
    subject_type: null,
    subject_id: null,
    last_message_at: null,
    ...audit(),
  });
  for (const m of membersFrom(memberIds, g.admin)) {
    chatMembers.push({ ...m, id: `cm-${g.id}-${m.employee_id}`, chat_id: g.id });
  }
}

// DMs — auditable with the pair as members, no name.
for (const d of seedDMs) {
  chats.push({
    id: d.id,
    organisation_id: organisation.id,
    type: 'dm',
    name: null,
    description: null,
    subject_type: null,
    subject_id: null,
    last_message_at: null,
    ...audit(),
  });
  for (const eId of d.between) {
    chatMembers.push({
      id: `cm-${d.id}-${eId}`,
      chat_id: d.id,
      employee_id: eId,
      role: 'member',
      joined_at: now,
      left_at: null,
    });
  }
}

// A handful of messages in each so the UI has something on first load.
const seedConversations: [string, [string, string][]][] = [
  ['chat-general', [
    ['emp-md', 'Welcome to JNS Accounting Solutions. New quarter starts Monday.'],
    ['emp-hr', 'Reminder: holiday calendar for the year is now live in Settings.'],
    ['emp-mgr', 'Sundar & Co audit closing this Friday — great work team.'],
  ]],
  ['chat-mgmt', [
    ['emp-md', 'Board update at 4pm today.'],
    ['emp-mgr', 'Will circulate the client roll-forward before then.'],
  ]],
  ['chat-hr', [
    ['emp-hr', 'Diwali holiday list published — check the Leave module.'],
    ['emp-md', 'Thanks Priya.'],
  ]],
  ['chat-finance', [
    ['emp-fin', 'September payroll goes to review by 25th.'],
    ['emp-md', 'Noted.'],
  ]],
  ['chat-ops', [
    ['emp-mgr', 'Field visit roster for next week going out tomorrow.'],
    ['emp-exec', 'Meera — I can take the Trichy visit.'],
    ['emp-articled', 'Happy to shadow on the Chennai audits.'],
  ]],
  ['chat-dm-meera-vikram', [
    ['emp-mgr', 'Meera — can you own the GST reconciliation for Sundar this month?'],
    ['emp-exec', 'On it. Draft by Thursday.'],
    ['emp-mgr', 'Great.'],
  ]],
  ['chat-dm-priya-md', [
    ['emp-hr', 'Ravi — Divya\'s probation ends in early January.'],
    ['emp-md', 'Let\'s discuss in the next 1:1.'],
  ]],
];

for (const [chatId, conv] of seedConversations) {
  for (const [authorId, body] of conv) {
    const m = msg(chatId, authorId, body);
    chatMessages.push(m);
    // The chat's last_message_at tracks the newest message.
    const chat = chats.find((c) => c.id === chatId)!;
    if (!chat.last_message_at || chat.last_message_at < m.created_at) {
      chat.last_message_at = m.created_at;
    }
    // Author reads their own message immediately.
    messageReads.push({
      id: `mr-${m.id}-${authorId}`,
      chat_id: chatId,
      message_id: m.id,
      employee_id: authorId,
      read_at: m.created_at,
    });
  }
}

// For the OTHER members of each seeded chat, mark ALL EXCEPT the LAST message
// read. That way each caller lands with exactly 1 unread per chat on first
// load — a demo-friendly starting state.
for (const chat of chats) {
  const members = chatMembers.filter((m) => m.chat_id === chat.id && !m.left_at);
  const messages = chatMessages
    .filter((m) => m.chat_id === chat.id && !m.deleted_at)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  if (messages.length === 0) continue;
  const readable = messages.slice(0, -1); // everyone reads all but the last
  for (const member of members) {
    for (const m of readable) {
      if (m.author_employee_id === member.employee_id) continue; // already added above
      messageReads.push({
        id: `mr-${m.id}-${member.employee_id}`,
        chat_id: chat.id,
        message_id: m.id,
        employee_id: member.employee_id,
        read_at: m.created_at,
      });
    }
  }
}
