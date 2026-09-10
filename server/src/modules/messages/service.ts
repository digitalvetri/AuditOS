import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import { writeAudit } from '../../platform/audit.js'
import { notifyEmployee } from '../../platform/notify.js'
import { can, type Session } from '../../platform/auth.js'
import {
  chatToApi, chatMessageToApi, chatPreviewText,
  type ChatListItem, type ChatMessageWithAuthor,
} from '../../api/serialize.js'
import { publishChatEvent } from './events.js'
import { sanitizeFilename } from '../tools/lib/files.js'
import {
  chatStorage, sniffImage, storageKeyFor, MAX_IMAGES_PER_MESSAGE, type ImageMime,
} from './attachments.js'

/**
 * MESSAGES (§8.7).
 *
 * Internal organisation communication only. There is no client-facing surface
 * and no route that could reach one: Chat.subjectType / subjectId are modelled
 * and left null, reserved for the Workstation.
 *
 * MEMBERSHIP IS THE AUTHORIZATION BOUNDARY for both read and write.
 * `chat.manage` (MD) overrides it for READS only — writing as a non-member
 * would fake group presence, so the override deliberately stops at GET.
 */

export const SEEDED_GROUPS = [
  { code: 'GENERAL', name: 'Audit OS General', description: 'Everyone at Audit OS' },
  { code: 'MANAGEMENT', name: 'Management', description: 'Partners and managers' },
  { code: 'HR_TEAM', name: 'HR Team', description: 'Human resources' },
  { code: 'FINANCE_TEAM', name: 'Finance Team', description: 'Finance and accounts' },
  { code: 'GST_TEAM', name: 'GST Team', description: 'Indirect tax practice' },
  { code: 'OPERATIONS', name: 'Operations', description: 'Office operations' },
]

function requireEmployee(session: Session): string {
  if (!session.employeeId) {
    throw ApiError.unprocessable('no_employee', 'This account has no employee record.')
  }
  return session.employeeId
}

const canManageChats = (session: Session) => can(session, 'chat.manage', 'organisation')

async function isMember(chatId: string, employeeId: string): Promise<boolean> {
  const row = await prisma.chatMember.findFirst({
    where: { chatId, employeeId, leftAt: null },
    select: { id: true },
  })
  return !!row
}

/** A DM has no name of its own — it is named after the other participant. */
async function displayName(
  chat: { id: string; type: string; name: string | null },
  viewerEmployeeId: string,
): Promise<string> {
  if (chat.type !== 'dm') return chat.name ?? 'Chat'
  const other = await prisma.chatMember.findFirst({
    where: { chatId: chat.id, employeeId: { not: viewerEmployeeId } },
    include: { employee: { select: { fullName: true } } },
  })
  return other?.employee.fullName ?? 'Direct message'
}

/** Unread = messages by others in this chat with no read receipt for me. */
async function unreadForChat(chatId: string, employeeId: string): Promise<number> {
  return prisma.chatMessage.count({
    where: {
      chatId,
      deletedAt: null,
      authorEmployeeId: { not: employeeId },
      reads: { none: { employeeId } },
    },
  })
}

export async function listChats(session: Session): Promise<{ items: ChatListItem[]; total_unread: number }> {
  const employeeId = requireEmployee(session)
  const memberships = await prisma.chatMember.findMany({
    where: { employeeId, leftAt: null },
    select: { chatId: true },
  })
  const memberChatIds = new Set(memberships.map((m) => m.chatId))

  // Everyone sees their own chats; `chat.manage` (MD) additionally sees all.
  const chats = await prisma.chat.findMany({
    where: {
      deletedAt: null,
      ...(canManageChats(session) ? {} : { id: { in: [...memberChatIds] } }),
    },
    include: {
      messages: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { attachments: { select: { id: true } } },
      },
      _count: { select: { members: true } },
    },
  })

  const items: ChatListItem[] = []
  for (const c of chats) {
    const last = c.messages[0]
    items.push({
      ...chatToApi(c),
      display_name: await displayName(c, employeeId),
      last_message: last
        ? {
            id: last.id,
            // An image-only message has no body; the preview says "Photo"
            // rather than rendering an empty row in the sidebar.
            body: chatPreviewText(last.body, last.attachments.length),
            created_at: last.createdAt.toISOString(),
            author_id: last.authorEmployeeId,
            attachment_count: last.attachments.length,
          }
        : null,
      // A chat visible only through the MD override has no unread for you.
      unread: memberChatIds.has(c.id) ? await unreadForChat(c.id, employeeId) : 0,
      member_count: c._count.members,
    })
  }

  // Newest activity first; chats with no messages fall to the bottom.
  items.sort((a, b) => {
    const at = a.last_message_at ?? ''
    const bt = b.last_message_at ?? ''
    return at === bt ? 0 : at < bt ? 1 : -1
  })
  return { items, total_unread: items.reduce((s, c) => s + c.unread, 0) }
}

export async function totalUnread(employeeId: string): Promise<number> {
  const memberships = await prisma.chatMember.findMany({
    where: { employeeId, leftAt: null },
    select: { chatId: true },
  })
  let total = 0
  for (const m of memberships) total += await unreadForChat(m.chatId, employeeId)
  return total
}

/** Create a DM (idempotent per pair) or a group (`chat.manage` only). */
export async function createChat(
  session: Session,
  input: { type?: 'group' | 'dm'; name?: string; description?: string; member_ids?: string[]; other_employee_id?: string },
) {
  const employeeId = requireEmployee(session)
  const type = input.type ?? 'dm'
  const org = await prisma.organisation.findFirstOrThrow({ where: { deletedAt: null } })

  if (type === 'dm') {
    const other = input.other_employee_id
    if (!other) throw ApiError.badRequest('other_employee_id required for a DM.')
    if (other === employeeId) throw ApiError.unprocessable('self_dm', 'You cannot DM yourself.')
    const target = await prisma.employee.findFirst({ where: { id: other, deletedAt: null } })
    if (!target) throw ApiError.unprocessable('invalid_target', 'Unknown or inactive employee.')

    // Uniqueness per pair — return the existing thread rather than a second one.
    const existing = await prisma.chat.findFirst({
      where: {
        type: 'dm',
        deletedAt: null,
        AND: [
          { members: { some: { employeeId, leftAt: null } } },
          { members: { some: { employeeId: other, leftAt: null } } },
        ],
      },
    })
    if (existing) return { chat: chatToApi(existing), created: false }

    const chat = await prisma.chat.create({
      data: {
        organisationId: org.id,
        type: 'dm',
        createdBy: session.userId,
        updatedBy: session.userId,
        members: {
          create: [employeeId, other].map((id) => ({ employeeId: id, role: 'member' })),
        },
      },
    })
    await writeAudit({
      actorUserId: session.userId, action: 'chat.dm_created',
      entityType: 'Chat', entityId: chat.id, after: { with: other },
    })
    return { chat: chatToApi(chat), created: true }
  }

  if (!canManageChats(session)) throw ApiError.forbidden('Only MD can create group chats.')
  if (!input.name?.trim()) throw ApiError.badRequest('name required for a group.')
  const memberIds = (input.member_ids ?? []).filter(Boolean)
  if (memberIds.length < 2) {
    throw ApiError.unprocessable('too_few_members', 'A group needs at least 2 members.')
  }
  const found = await prisma.employee.findMany({
    where: { id: { in: memberIds }, deletedAt: null }, select: { id: true },
  })
  if (found.length !== memberIds.length) {
    const known = new Set(found.map((f) => f.id))
    const missing = memberIds.find((id) => !known.has(id))
    throw ApiError.unprocessable('invalid_target', `Unknown/inactive employee: ${missing}`)
  }

  const chat = await prisma.chat.create({
    data: {
      organisationId: org.id,
      type: 'group',
      name: input.name.trim(),
      description: input.description ?? null,
      createdBy: session.userId,
      updatedBy: session.userId,
      members: {
        create: memberIds.map((id) => ({
          employeeId: id,
          role: id === employeeId ? 'admin' : 'member',
        })),
      },
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'chat.group_created',
    entityType: 'Chat', entityId: chat.id,
    after: { name: chat.name, members: memberIds.length },
  })
  return { chat: chatToApi(chat), created: true }
}

/**
 * The include shape every message read shares, so the thread, the optimistic
 * POST response and the realtime payload can never disagree about a message.
 */
const MESSAGE_INCLUDE = (employeeId: string) => ({
  author: { select: { id: true, fullName: true, employeeCode: true } },
  parent: {
    include: {
      author: { select: { fullName: true } },
      attachments: { select: { id: true } },
    },
  },
  reads: { where: { employeeId }, select: { id: true } },
  attachments: {
    select: { id: true, originalFilename: true, mimeType: true, fileSize: true },
    orderBy: { createdAt: 'asc' },
  },
}) as const

export async function listMessages(chatId: string, session: Session) {
  const employeeId = requireEmployee(session)
  const chat = await prisma.chat.findFirst({ where: { id: chatId, deletedAt: null } })
  if (!chat) throw ApiError.notFound('Chat not found.')
  if (!(await isMember(chatId, employeeId)) && !canManageChats(session)) {
    throw ApiError.forbidden('You are not a member of this chat.')
  }

  const rows = await prisma.chatMessage.findMany({
    where: { chatId, deletedAt: null },
    include: MESSAGE_INCLUDE(employeeId),
    orderBy: { createdAt: 'asc' },
  })

  return {
    chat: { ...chatToApi(chat), display_name: await displayName(chat, employeeId) },
    items: rows.map(chatMessageToApi),
  }
}

/** One uploaded file as multer hands it over, before any of it is trusted. */
export interface IncomingImage {
  originalname: string
  buffer: Buffer
}

/**
 * Validate every upload before a byte is written: the magic bytes decide the
 * type, so a .png extension on a PDF (or an SVG full of script) is rejected
 * here rather than being served back to the chat later.
 */
function validateImages(images: IncomingImage[]): { bytes: Buffer; mime: ImageMime; filename: string }[] {
  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    throw ApiError.unprocessable(
      'too_many_images',
      `A message carries at most ${MAX_IMAGES_PER_MESSAGE} images.`,
    )
  }
  return images.map((f) => {
    const mime = sniffImage(f.buffer)
    if (!mime) {
      throw ApiError.unprocessable(
        'unsupported_image',
        `"${f.originalname}" is not a PNG, JPEG, WebP or GIF image.`,
      )
    }
    return { bytes: f.buffer, mime, filename: sanitizeFilename(f.originalname, 'image') }
  })
}

export async function postMessage(
  chatId: string, session: Session,
  input: { body?: string; parent_id?: string; images?: IncomingImage[] },
) {
  const employeeId = requireEmployee(session)
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, deletedAt: null },
    include: { members: { where: { leftAt: null } } },
  })
  if (!chat) throw ApiError.notFound('Chat not found.')
  // The MD read override does NOT extend to writing.
  if (!(await isMember(chatId, employeeId))) {
    throw ApiError.forbidden('You are not a member of this chat.')
  }

  const text = input.body?.trim() ?? ''
  const validated = validateImages(input.images ?? [])
  // An image is content in its own right, so a caption is optional — but a
  // message with neither text nor an image is not a message.
  if (!text && validated.length === 0) {
    throw ApiError.badRequest('Type a message or attach an image.')
  }
  if (text.length > 4000) throw ApiError.unprocessable('too_long', 'Message exceeds 4000 characters.')
  if (input.parent_id) {
    const parent = await prisma.chatMessage.findFirst({
      where: { id: input.parent_id, chatId }, select: { id: true },
    })
    if (!parent) throw ApiError.unprocessable('invalid_parent', 'Parent message not in this chat.')
  }

  // Bytes are written before the row, because a storage failure must not leave
  // a message pointing at an image that does not exist. The reverse — an
  // orphaned object with no row — is harmless and swept up below.
  const stored: { key: string; mime: ImageMime; filename: string; size: number }[] = []
  try {
    for (const v of validated) {
      const key = storageKeyFor(chatId, v.mime)
      const { size } = await chatStorage.put(key, v.bytes)
      stored.push({ key, mime: v.mime, filename: v.filename, size })
    }
  } catch (err) {
    await Promise.all(stored.map((o) => chatStorage.delete(o.key).catch(() => {})))
    throw err
  }

  const now = new Date()
  let message
  try {
    message = await prisma.$transaction(async (tx) => {
      const created = await tx.chatMessage.create({
        data: {
          chatId,
          authorEmployeeId: employeeId,
          body: text,
          parentId: input.parent_id ?? null,
          // The author has read their own message by definition.
          reads: { create: { chatId, employeeId, readAt: now } },
          attachments: {
            create: stored.map((o) => ({
              storagePath: o.key,
              originalFilename: o.filename,
              mimeType: o.mime,
              fileSize: o.size,
            })),
          },
        },
        include: MESSAGE_INCLUDE(employeeId),
      })
      await tx.chat.update({ where: { id: chatId }, data: { lastMessageAt: now } })
      return created
    })
  } catch (err) {
    // No row means nothing will ever read these objects — do not leave them.
    await Promise.all(stored.map((o) => chatStorage.delete(o.key).catch(() => {})))
    throw err
  }

  const serialized = chatMessageToApi(message)
  publishChatEvent({
    chatId,
    memberEmployeeIds: chat.members.map((m) => m.employeeId),
    type: 'message:new',
    payload: serialized,
  })

  // §8.9: a DM notifies the other side. Group traffic is a UI badge only —
  // notifying every member of every group message is noise, not signal.
  if (chat.type === 'dm') {
    const author = message.author.fullName
    for (const m of chat.members) {
      if (m.employeeId === employeeId) continue
      await notifyEmployee(m.employeeId, {
        type: 'chat.dm_new', module: 'message',
        title: `New message from ${author}`,
        // An image-only message still needs a readable notification line.
        body: chatPreviewText(text, stored.length),
        entityType: 'ChatMessage', entityId: message.id,
        actionUrl: `/hrms/messages?chat=${chatId}`,
      })
    }
  }

  await writeAudit({
    actorUserId: session.userId, action: 'chat.message_sent',
    entityType: 'ChatMessage', entityId: message.id,
    after: { chat_id: chatId, has_parent: !!message.parentId, images: stored.length },
  })
  return serialized
}

/**
 * Read one attachment's bytes for a viewer.
 *
 * Membership is re-checked here rather than trusted from the URL: an
 * attachment id is a uuid, but an unguessable id is not an access control, and
 * ids travel (a forwarded link, a screenshot of the network tab). The MD read
 * override applies, exactly as it does to the thread the image sits in.
 */
export async function readAttachment(attachmentId: string, session: Session) {
  const employeeId = requireEmployee(session)
  const row = await prisma.chatAttachment.findUnique({
    where: { id: attachmentId },
    include: { message: { select: { chatId: true, deletedAt: true } } },
  })
  if (!row || row.message.deletedAt) throw ApiError.notFound('Attachment not found.')
  if (!(await isMember(row.message.chatId, employeeId)) && !canManageChats(session)) {
    throw ApiError.forbidden('You are not a member of this chat.')
  }
  if (!(await chatStorage.exists(row.storagePath))) {
    throw ApiError.notFound('Attachment bytes are no longer stored.')
  }
  return {
    bytes: await chatStorage.get(row.storagePath),
    mimeType: row.mimeType,
    filename: row.originalFilename,
  }
}

/** Mark everything up to `message_id` (or now) read. High frequency: no audit. */
export async function markRead(chatId: string, session: Session, messageId?: string) {
  const employeeId = requireEmployee(session)
  if (!(await isMember(chatId, employeeId))) {
    throw ApiError.forbidden('You are not a member of this chat.')
  }

  let cutoff = new Date()
  if (messageId) {
    const target = await prisma.chatMessage.findFirst({ where: { id: messageId, chatId } })
    if (!target) throw ApiError.unprocessable('invalid_message', 'Message not in this chat.')
    cutoff = target.createdAt
  }

  const unread = await prisma.chatMessage.findMany({
    where: {
      chatId, deletedAt: null,
      createdAt: { lte: cutoff },
      reads: { none: { employeeId } },
    },
    select: { id: true },
  })
  if (unread.length) {
    await prisma.messageRead.createMany({
      data: unread.map((m) => ({ chatId, messageId: m.id, employeeId })),
    })
    publishChatEvent({
      chatId, memberEmployeeIds: [employeeId], type: 'chat:read',
      payload: { chat_id: chatId, marked: unread.length },
    })
  }
  return { marked: unread.length }
}
