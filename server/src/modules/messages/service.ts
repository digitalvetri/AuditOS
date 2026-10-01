import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import { writeAudit } from '../../platform/audit.js'
import { notifyEmployee } from '../../platform/notify.js'
import { can, type Session } from '../../platform/auth.js'
import {
  chatToApi, chatMessageToApi, chatPreviewText,
  type ChatListItem, type ChatMessageWithAuthor,
} from '../../api/serialize.js'
import { publishChatEvent, type ChatEvent } from './events.js'
import { sanitizeFilename } from '../tools/lib/files.js'
import {
  chatStorage, sniffImage, storageKeyFor, MAX_IMAGES_PER_MESSAGE, type ImageMime,
  sniffAudio, audioStorageKeyFor, MAX_VOICE_MB, MAX_VOICE_SECONDS,
  sniffDocument, documentStorageKeyFor, MAX_DOCUMENT_MB, MAX_DOCUMENTS_PER_MESSAGE, ACCEPTED_DOCUMENT_EXTENSIONS,
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

/**
 * A DM has no name or picture of its own — it shows the other participant's
 * name and profile photo. A group shows its own.
 */
async function displayIdentity(
  chat: { id: string; type: string; name: string | null; photoUrl: string | null },
  viewerEmployeeId: string,
): Promise<{ display_name: string; photo_url: string | null }> {
  if (chat.type !== 'dm') return { display_name: chat.name ?? 'Chat', photo_url: chat.photoUrl }
  const other = await prisma.chatMember.findFirst({
    where: { chatId: chat.id, employeeId: { not: viewerEmployeeId } },
    include: { employee: { select: { fullName: true, photoUrl: true } } },
  })
  return { display_name: other?.employee.fullName ?? 'Direct message', photo_url: other?.employee.photoUrl ?? null }
}

/** A profile / group photo: a small image data: URL, or null to remove it. */
const PHOTO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/
const MAX_PHOTO_CHARS = 400_000
export function checkPhoto(photo: string | null): string | null {
  if (photo === null) return null
  if (photo.length > MAX_PHOTO_CHARS || !PHOTO_RE.test(photo)) {
    throw ApiError.badRequest('Use a PNG, JPEG or WebP picture under 300 KB.')
  }
  return photo
}

/** Set (or remove) the signed-in person's own profile photo. */
export async function setMyPhoto(session: Session, photo: string | null) {
  const employeeId = requireEmployee(session)
  const saved = await prisma.employee.update({
    where: { id: employeeId },
    data: { photoUrl: checkPhoto(photo), updatedBy: session.userId },
    select: { photoUrl: true },
  })
  await writeAudit({ actorUserId: session.userId, action: 'employee.photo_updated', entityType: 'Employee', entityId: employeeId, after: { has_photo: !!saved.photoUrl } })
  return { photo_url: saved.photoUrl }
}

/** Unread = messages by others in this chat with no read receipt for me. */
async function unreadForChat(chatId: string, employeeId: string, clearedAt: Date | null = null): Promise<number> {
  return prisma.chatMessage.count({
    where: {
      chatId,
      deletedAt: null,
      authorEmployeeId: { not: employeeId },
      reads: { none: { employeeId } },
      hiddenFor: { none: { employeeId } },
      ...(clearedAt ? { createdAt: { gt: clearedAt } } : {}),
    },
  })
}

export async function listChats(session: Session): Promise<{ items: ChatListItem[]; total_unread: number }> {
  const employeeId = requireEmployee(session)
  const memberships = await prisma.chatMember.findMany({
    where: { employeeId, leftAt: null },
    select: { chatId: true, role: true, clearedAt: true, hiddenAt: true },
  })
  const memberChatIds = new Set(memberships.map((m) => m.chatId))
  const mine = new Map(memberships.map((m) => [m.chatId, m]))

  // Everyone sees their own chats; `chat.manage` (MD) additionally sees all.
  const chats = await prisma.chat.findMany({
    where: {
      deletedAt: null,
      ...(canManageChats(session) ? {} : { id: { in: [...memberChatIds] } }),
    },
    include: {
      messages: {
        where: { deletedAt: null, hiddenFor: { none: { employeeId } } },
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { attachments: { select: { id: true, kind: true } } },
      },
      _count: { select: { members: { where: { leftAt: null } } } },
    },
  })

  const items: ChatListItem[] = []
  for (const c of chats) {
    const me = mine.get(c.id)
    // "Delete chat" hides it until someone writes again.
    if (me?.hiddenAt && (!c.lastMessageAt || c.lastMessageAt <= me.hiddenAt)) continue
    const lastRaw = c.messages[0]
    // A cleared chat shows no preview of what was cleared.
    const last = lastRaw && (!me?.clearedAt || lastRaw.createdAt > me.clearedAt) ? lastRaw : undefined
    items.push({
      ...chatToApi(c),
      ...(await displayIdentity(c, employeeId)),
      last_message: last
        ? {
            id: last.id,
            // An image-only message has no body; the preview says "Photo"
            // rather than rendering an empty row in the sidebar.
            body: chatPreviewText(last.body, last.attachments.length, last.attachments.some((a) => a.kind === 'audio'), last.attachments.filter((a) => a.kind === 'document').length),
            created_at: last.createdAt.toISOString(),
            author_id: last.authorEmployeeId,
            attachment_count: last.attachments.length,
          }
        : null,
      // A chat visible only through the MD override has no unread for you.
      unread: memberChatIds.has(c.id) ? await unreadForChat(c.id, employeeId, me?.clearedAt ?? null) : 0,
      member_count: c._count.members,
      my_role: me ? (me.role === 'admin' ? 'admin' : 'member') : null,
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
    if (existing) {
      // Starting a chat you had deleted brings it back.
      await prisma.chatMember.updateMany({ where: { chatId: existing.id, employeeId }, data: { hiddenAt: null } })
      return { chat: chatToApi(existing), created: false }
    }

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

  // Anyone who can chat can start a group, as in WhatsApp; the creator is its admin.
  if (!input.name?.trim()) throw ApiError.badRequest('Give the group a name.')
  const memberIds = [...new Set([employeeId, ...(input.member_ids ?? []).filter(Boolean)])]
  if (memberIds.length < 2) {
    throw ApiError.unprocessable('too_few_members', 'Add at least one other person to the group.')
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
      attachments: { select: { id: true, kind: true } },
    },
  },
  reads: { where: { employeeId }, select: { id: true } },
  attachments: {
    select: { id: true, originalFilename: true, mimeType: true, fileSize: true, kind: true, durationMs: true },
    orderBy: { createdAt: 'asc' },
  },
}) as const

export async function listMessages(chatId: string, session: Session) {
  const employeeId = requireEmployee(session)
  const chat = await prisma.chat.findFirst({ where: { id: chatId, deletedAt: null } })
  if (!chat) throw ApiError.notFound('Chat not found.')
  const wasMember = await prisma.chatMember.findFirst({ where: { chatId, employeeId }, select: { id: true } })
  if (!wasMember && !canManageChats(session)) {
    throw ApiError.forbidden('You are not a member of this chat.')
  }

  const me = await prisma.chatMember.findFirst({ where: { chatId, employeeId }, select: { clearedAt: true, leftAt: true } })
  const rows = await prisma.chatMessage.findMany({
    where: {
      chatId,
      // Deleted-for-everyone rows stay, shown as "This message was deleted".
      hiddenFor: { none: { employeeId } },
      ...(me?.clearedAt ? { createdAt: { gt: me.clearedAt } } : {}),
      // Someone who left sees the group only up to when they left.
      ...(me?.leftAt ? { createdAt: { lte: me.leftAt, ...(me.clearedAt ? { gt: me.clearedAt } : {}) } } : {}),
    },
    include: MESSAGE_INCLUDE(employeeId),
    orderBy: { createdAt: 'asc' },
  })

  return {
    chat: { ...chatToApi(chat), ...(await displayIdentity(chat, employeeId)) },
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

function validateDocuments(files: IncomingImage[]) {
  if (files.length > MAX_DOCUMENTS_PER_MESSAGE) {
    throw ApiError.unprocessable('too_many_documents', `A message carries at most ${MAX_DOCUMENTS_PER_MESSAGE} documents.`)
  }
  return files.map((f) => {
    if (f.buffer.length > MAX_DOCUMENT_MB * 1024 * 1024) throw ApiError.unprocessable('too_large', `"${f.originalname}" is larger than ${MAX_DOCUMENT_MB} MB.`)
    const found = sniffDocument(f.buffer, f.originalname)
    if (!found) {
      throw ApiError.unprocessable('unsupported_document', `"${f.originalname}" is not an accepted document (${ACCEPTED_DOCUMENT_EXTENSIONS.map((e) => e.toUpperCase()).join(', ')}), or its content does not match its type.`)
    }
    return { bytes: f.buffer, ...found, filename: sanitizeFilename(f.originalname, `document.${found.ext}`) }
  })
}

function validateVoice(f: IncomingImage, durationMs: number | undefined) {
  const mime = sniffAudio(f.buffer)
  if (!mime) throw ApiError.unprocessable('unsupported_audio', 'That recording is not an audio format we accept.')
  if (f.buffer.length > MAX_VOICE_MB * 1024 * 1024) throw ApiError.unprocessable('too_large', `A voice message is limited to ${MAX_VOICE_MB} MB.`)
  const ms = Number.isFinite(durationMs) && durationMs! > 0 ? Math.round(durationMs!) : null
  if (ms !== null && ms > MAX_VOICE_SECONDS * 1000) throw ApiError.unprocessable('too_long', `A voice message is limited to ${MAX_VOICE_SECONDS / 60} minutes.`)
  return { bytes: f.buffer, mime, filename: sanitizeFilename(f.originalname || 'voice-message', 'voice-message'), durationMs: ms }
}

export async function postMessage(
  chatId: string, session: Session,
  input: { body?: string; parent_id?: string; images?: IncomingImage[]; documents?: IncomingImage[]; voice?: IncomingImage | null; voice_duration_ms?: number },
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
  const voice = input.voice ? validateVoice(input.voice, input.voice_duration_ms) : null
  const docs = validateDocuments(input.documents ?? [])
  if (voice && (validated.length || docs.length || text)) {
    throw ApiError.badRequest('Send a voice message on its own.')
  }
  // An image, a document or a voice note is content in its own right, so a
  // caption is optional — but a message with none of these is not a message.
  if (!text && validated.length === 0 && docs.length === 0 && !voice) {
    throw ApiError.badRequest('Type a message, attach a file or record a voice message.')
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
  const stored: { key: string; mime: string; filename: string; size: number; kind: 'image' | 'audio' | 'document'; durationMs: number | null }[] = []
  try {
    for (const v of validated) {
      const key = storageKeyFor(chatId, v.mime)
      const { size } = await chatStorage.put(key, v.bytes)
      stored.push({ key, mime: v.mime, filename: v.filename, size, kind: 'image', durationMs: null })
    }
    for (const d of docs) {
      const key = documentStorageKeyFor(chatId, d.ext)
      const { size } = await chatStorage.put(key, d.bytes)
      stored.push({ key, mime: d.mime, filename: d.filename, size, kind: 'document', durationMs: null })
    }
    if (voice) {
      const key = audioStorageKeyFor(chatId, voice.mime)
      const { size } = await chatStorage.put(key, voice.bytes)
      stored.push({ key, mime: voice.mime, filename: voice.filename, size, kind: 'audio', durationMs: voice.durationMs })
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
              kind: o.kind,
              durationMs: o.durationMs,
            })),
          },
        },
        include: MESSAGE_INCLUDE(employeeId),
      })
      await tx.chat.update({ where: { id: chatId }, data: { lastMessageAt: now } })
      // A new message brings a deleted chat back for everyone who hid it.
      await tx.chatMember.updateMany({ where: { chatId, hiddenAt: { not: null } }, data: { hiddenAt: null } })
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
        body: chatPreviewText(text, stored.length, !!voice, docs.length),
        entityType: 'ChatMessage', entityId: message.id,
        actionUrl: `/hrms/messages?chat=${chatId}`,
      })
    }
  }

  await writeAudit({
    actorUserId: session.userId, action: 'chat.message_sent',
    entityType: 'ChatMessage', entityId: message.id,
    after: { chat_id: chatId, has_parent: !!message.parentId, images: validated.length, documents: docs.length, voice: !!voice },
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
  const everMember = await prisma.chatMember.findFirst({ where: { chatId: row.message.chatId, employeeId }, select: { id: true } })
  if (!everMember && !canManageChats(session)) {
    throw ApiError.forbidden('You are not a member of this chat.')
  }
  if (!(await chatStorage.exists(row.storagePath))) {
    throw ApiError.notFound('Attachment bytes are no longer stored.')
  }
  return {
    bytes: await chatStorage.get(row.storagePath),
    mimeType: row.mimeType,
    filename: row.originalFilename,
    kind: row.kind,
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

// ── WhatsApp-style chat management ─────────────────────────────────────────

/** How long after sending a message its author can still delete it for everyone. */
export const DELETE_FOR_EVERYONE_HOURS = 48

async function requireGroup(chatId: string) {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, deletedAt: null } })
  if (!chat) throw ApiError.notFound('Chat not found.')
  if (chat.type !== 'group') throw ApiError.unprocessable('not_group', 'This is a direct message, not a group.')
  return chat
}

async function requireAdmin(chatId: string, employeeId: string) {
  const me = await prisma.chatMember.findFirst({ where: { chatId, employeeId, leftAt: null } })
  if (!me) throw ApiError.forbidden('You are not in this group.')
  if (me.role !== 'admin') throw ApiError.forbidden('Only a group admin can do that.')
  return me
}

function notifyMembers(chatId: string, type: ChatEvent['type'], payload: unknown, extra: string[] = []) {
  return prisma.chatMember.findMany({ where: { chatId, leftAt: null }, select: { employeeId: true } }).then((ms) => {
    publishChatEvent({ chatId, memberEmployeeIds: [...new Set([...ms.map((m) => m.employeeId), ...extra])], type, payload })
  })
}

/** Members, admins and the viewer's own standing — for the group info panel. */
export async function chatInfo(chatId: string, session: Session) {
  const employeeId = requireEmployee(session)
  const chat = await prisma.chat.findFirst({ where: { id: chatId, deletedAt: null } })
  if (!chat) throw ApiError.notFound('Chat not found.')
  const members = await prisma.chatMember.findMany({
    where: { chatId },
    include: { employee: { select: { id: true, fullName: true, employeeCode: true, designation: { select: { name: true } } } } },
    orderBy: { joinedAt: 'asc' },
  })
  const me = members.find((m) => m.employeeId === employeeId)
  if (!me && !canManageChats(session)) throw ApiError.forbidden('You are not a member of this chat.')
  return {
    chat: { ...chatToApi(chat), ...(await displayIdentity(chat, employeeId)) },
    my_role: me && !me.leftAt ? me.role : null,
    left: !!me?.leftAt,
    members: members.filter((m) => !m.leftAt).map((m) => ({
      employee_id: m.employeeId, full_name: m.employee.fullName, employee_code: m.employee.employeeCode,
      designation: m.employee.designation?.name ?? null, role: m.role, joined_at: m.joinedAt.toISOString(),
    })),
  }
}

/** Everyone a chat can be started with — any active colleague. */
export async function chatPeople(session: Session) {
  const employeeId = requireEmployee(session)
  const people = await prisma.employee.findMany({
    where: { deletedAt: null, id: { not: employeeId } },
    select: { id: true, fullName: true, employeeCode: true, designation: { select: { name: true } } },
    orderBy: { fullName: 'asc' },
  })
  return { items: people.map((p) => ({ id: p.id, full_name: p.fullName, employee_code: p.employeeCode, designation: p.designation?.name ?? null })) }
}

export async function updateGroup(chatId: string, session: Session, input: { name?: string; description?: string | null; photo_url?: string | null }) {
  const employeeId = requireEmployee(session)
  const chat = await requireGroup(chatId)
  await requireAdmin(chatId, employeeId)
  const name = input.name?.trim()
  if (input.name !== undefined && !name) throw ApiError.badRequest('The group needs a name.')
  const saved = await prisma.chat.update({
    where: { id: chatId },
    data: {
      ...(name ? { name } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      ...(input.photo_url !== undefined ? { photoUrl: checkPhoto(input.photo_url) } : {}),
      updatedBy: session.userId,
    },
  })
  await writeAudit({ actorUserId: session.userId, action: 'chat.group_updated', entityType: 'Chat', entityId: chatId, before: { name: chat.name, description: chat.description }, after: { name: saved.name, description: saved.description } })
  await notifyMembers(chatId, 'chat:updated', { chat_id: chatId })
  return { chat: chatToApi(saved) }
}

export async function addMembers(chatId: string, session: Session, ids: string[]) {
  const employeeId = requireEmployee(session)
  await requireGroup(chatId)
  await requireAdmin(chatId, employeeId)
  const unique = [...new Set(ids.filter(Boolean))]
  if (!unique.length) throw ApiError.badRequest('Choose people to add.')
  const found = await prisma.employee.findMany({ where: { id: { in: unique }, deletedAt: null }, select: { id: true } })
  if (found.length !== unique.length) throw ApiError.unprocessable('invalid_target', 'Someone chosen is not an active employee.')
  for (const id of unique) {
    // Re-adding someone who left brings them back as a member, not a new row.
    await prisma.chatMember.upsert({
      where: { chatId_employeeId: { chatId, employeeId: id } },
      update: { leftAt: null, role: 'member', joinedAt: new Date(), hiddenAt: null },
      create: { chatId, employeeId: id, role: 'member' },
    })
  }
  await writeAudit({ actorUserId: session.userId, action: 'chat.members_added', entityType: 'Chat', entityId: chatId, after: { added: unique } })
  await notifyMembers(chatId, 'chat:updated', { chat_id: chatId })
  return chatInfo(chatId, session)
}

export async function removeMember(chatId: string, session: Session, targetId: string) {
  const employeeId = requireEmployee(session)
  await requireGroup(chatId)
  await requireAdmin(chatId, employeeId)
  if (targetId === employeeId) throw ApiError.badRequest('Use “Exit group” to leave it yourself.')
  const target = await prisma.chatMember.findFirst({ where: { chatId, employeeId: targetId, leftAt: null } })
  if (!target) throw ApiError.notFound('That person is not in the group.')
  await prisma.chatMember.update({ where: { id: target.id }, data: { leftAt: new Date(), role: 'member' } })
  await writeAudit({ actorUserId: session.userId, action: 'chat.member_removed', entityType: 'Chat', entityId: chatId, after: { removed: targetId } })
  await notifyMembers(chatId, 'chat:updated', { chat_id: chatId }, [targetId])
  return chatInfo(chatId, session)
}

export async function setMemberRole(chatId: string, session: Session, targetId: string, role: 'admin' | 'member') {
  const employeeId = requireEmployee(session)
  await requireGroup(chatId)
  await requireAdmin(chatId, employeeId)
  const target = await prisma.chatMember.findFirst({ where: { chatId, employeeId: targetId, leftAt: null } })
  if (!target) throw ApiError.notFound('That person is not in the group.')
  if (role === 'member') {
    const admins = await prisma.chatMember.count({ where: { chatId, leftAt: null, role: 'admin' } })
    if (admins <= 1 && target.role === 'admin') throw ApiError.unprocessable('last_admin', 'A group needs at least one admin.')
  }
  await prisma.chatMember.update({ where: { id: target.id }, data: { role } })
  await writeAudit({ actorUserId: session.userId, action: 'chat.member_role', entityType: 'Chat', entityId: chatId, after: { member: targetId, role } })
  await notifyMembers(chatId, 'chat:updated', { chat_id: chatId })
  return chatInfo(chatId, session)
}

/** Exit a group. If the last admin leaves, the longest-standing member becomes admin. */
export async function leaveGroup(chatId: string, session: Session) {
  const employeeId = requireEmployee(session)
  await requireGroup(chatId)
  const me = await prisma.chatMember.findFirst({ where: { chatId, employeeId, leftAt: null } })
  if (!me) throw ApiError.unprocessable('not_member', 'You are not in this group.')
  await prisma.$transaction(async (tx) => {
    await tx.chatMember.update({ where: { id: me.id }, data: { leftAt: new Date(), role: 'member' } })
    if (me.role === 'admin') {
      const admins = await tx.chatMember.count({ where: { chatId, leftAt: null, role: 'admin' } })
      if (!admins) {
        const next = await tx.chatMember.findFirst({ where: { chatId, leftAt: null }, orderBy: { joinedAt: 'asc' } })
        if (next) await tx.chatMember.update({ where: { id: next.id }, data: { role: 'admin' } })
      }
    }
  })
  await writeAudit({ actorUserId: session.userId, action: 'chat.group_left', entityType: 'Chat', entityId: chatId })
  await notifyMembers(chatId, 'chat:updated', { chat_id: chatId }, [employeeId])
  return { left: true }
}

/** Delete a group for everyone — admins only. The history is kept for audit. */
export async function deleteGroup(chatId: string, session: Session) {
  const employeeId = requireEmployee(session)
  const chat = await requireGroup(chatId)
  await requireAdmin(chatId, employeeId)
  const members = await prisma.chatMember.findMany({ where: { chatId, leftAt: null }, select: { employeeId: true } })
  await prisma.chat.update({ where: { id: chatId }, data: { deletedAt: new Date(), updatedBy: session.userId } })
  await writeAudit({ actorUserId: session.userId, action: 'chat.group_deleted', entityType: 'Chat', entityId: chatId, before: { name: chat.name, members: members.length } })
  publishChatEvent({ chatId, memberEmployeeIds: members.map((m) => m.employeeId), type: 'chat:updated', payload: { chat_id: chatId, deleted: true } })
  return { deleted: true }
}

/** "Clear chat" — empty the conversation for me only. */
export async function clearChat(chatId: string, session: Session) {
  const employeeId = requireEmployee(session)
  const me = await prisma.chatMember.findFirst({ where: { chatId, employeeId } })
  if (!me) throw ApiError.forbidden('You are not a member of this chat.')
  await prisma.chatMember.update({ where: { id: me.id }, data: { clearedAt: new Date() } })
  return { cleared: true }
}

/**
 * "Delete chat" — remove it from my list (and clear it). A group is exited
 * first, as in WhatsApp. It comes back if someone writes again.
 */
export async function deleteChatForMe(chatId: string, session: Session) {
  const employeeId = requireEmployee(session)
  const chat = await prisma.chat.findFirst({ where: { id: chatId } })
  if (!chat) throw ApiError.notFound('Chat not found.')
  const me = await prisma.chatMember.findFirst({ where: { chatId, employeeId } })
  if (!me) throw ApiError.forbidden('You are not a member of this chat.')
  if (chat.type === 'group' && !me.leftAt && !chat.deletedAt) await leaveGroup(chatId, session)
  const now = new Date()
  await prisma.chatMember.update({ where: { id: me.id }, data: { hiddenAt: now, clearedAt: now } })
  return { deleted: true }
}

/**
 * Delete one message. "me": hidden for the caller only. "everyone": the
 * author within DELETE_FOR_EVERYONE_HOURS, or a group admin at any time —
 * shown to all as "This message was deleted".
 */
export async function deleteMessage(chatId: string, messageId: string, session: Session, scope: 'me' | 'everyone') {
  const employeeId = requireEmployee(session)
  const msg = await prisma.chatMessage.findFirst({ where: { id: messageId, chatId } })
  if (!msg) throw ApiError.notFound('Message not found.')
  const member = await prisma.chatMember.findFirst({ where: { chatId, employeeId } })
  if (!member) throw ApiError.forbidden('You are not a member of this chat.')
  if (scope === 'me') {
    await prisma.chatMessageHidden.upsert({
      where: { messageId_employeeId: { messageId, employeeId } }, update: {}, create: { messageId, employeeId },
    })
    return { deleted: 'me' as const }
  }
  if (msg.deletedAt) return { deleted: 'everyone' as const }
  const chat = await prisma.chat.findFirstOrThrow({ where: { id: chatId } })
  const isAuthor = msg.authorEmployeeId === employeeId
  const isAdmin = chat.type === 'group' && member.role === 'admin' && !member.leftAt
  const withinWindow = Date.now() - msg.createdAt.getTime() <= DELETE_FOR_EVERYONE_HOURS * 3_600_000
  if (!(isAuthor && withinWindow) && !isAdmin) {
    throw ApiError.forbidden(isAuthor
      ? `Messages can be deleted for everyone within ${DELETE_FOR_EVERYONE_HOURS} hours of sending. Use “Delete for me”.`
      : 'You can only delete your own messages for everyone.')
  }
  await prisma.chatMessage.update({ where: { id: messageId }, data: { deletedAt: new Date(), deletedByEmployeeId: employeeId } })
  await writeAudit({ actorUserId: session.userId, action: 'chat.message_deleted', entityType: 'ChatMessage', entityId: messageId, after: { chat_id: chatId, by: isAuthor ? 'author' : 'admin' } })
  await notifyMembers(chatId, 'message:deleted', { chat_id: chatId, message_id: messageId })
  return { deleted: 'everyone' as const }
}

/**
 * "Message info" for one of your own messages, as in WhatsApp: who it was
 * delivered to (members at the time it was sent) and who has read it, when.
 */
export async function messageInfo(chatId: string, messageId: string, session: Session) {
  const employeeId = requireEmployee(session)
  const msg = await prisma.chatMessage.findFirst({
    where: { id: messageId, chatId },
    include: { reads: { select: { employeeId: true, readAt: true } } },
  })
  if (!msg) throw ApiError.notFound('Message not found.')
  if (msg.authorEmployeeId !== employeeId) throw ApiError.forbidden('Message info is available for your own messages.')
  const members = await prisma.chatMember.findMany({
    where: {
      chatId, employeeId: { not: employeeId },
      // Everyone who was in the chat when it was sent.
      joinedAt: { lte: msg.createdAt },
      OR: [{ leftAt: null }, { leftAt: { gt: msg.createdAt } }],
    },
    include: { employee: { select: { id: true, fullName: true } } },
  })
  const readAt = new Map(msg.reads.map((r) => [r.employeeId, r.readAt]))
  const recipients = members.map((m) => ({
    employee_id: m.employeeId, full_name: m.employee.fullName, read_at: readAt.get(m.employeeId)?.toISOString() ?? null,
  })).sort((a, b) => (a.read_at ?? '9').localeCompare(b.read_at ?? '9'))
  return {
    message_id: msg.id,
    sent_at: msg.createdAt.toISOString(),
    deleted: msg.deletedAt !== null,
    read_by: recipients.filter((r) => r.read_at),
    not_read: recipients.filter((r) => !r.read_at),
  }
}
