import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requirePermission, requireSession } from '../../platform/auth.js'
import {
  addMembers, chatInfo, chatPeople, clearChat, createChat, deleteChatForMe, deleteGroup, deleteMessage,
  leaveGroup, listChats, listMessages, markRead, messageInfo, postMessage, readAttachment, removeMember, setMemberRole, setMyPhoto, updateGroup,
} from './service.js'
import { MAX_DOCUMENT_MB, MAX_DOCUMENTS_PER_MESSAGE, MAX_IMAGE_MB, MAX_IMAGES_PER_MESSAGE, MAX_VOICE_MB } from './attachments.js'

/**
 * Chats / Messages (§8.7 + §9)
 *
 *   GET  /api/chats                    caller's chats + unread + total
 *   GET  /api/chats/people             colleagues a chat can be started with
 *   POST /api/chats                    DM (idempotent per pair) or group (anyone; creator is admin)
 *   GET  /api/chats/:id/info           members + roles (group info panel)
 *   PUT  /api/chats/profile-photo      set / remove your own profile photo
 *   PATCH /api/chats/:id               rename / describe / picture a group (admin)
 *   POST|DELETE|PATCH /api/chats/:id/members[/:employeeId]   add / remove / make admin (admin)
 *   POST /api/chats/:id/leave          exit a group
 *   DELETE /api/chats/:id              delete a group for everyone (admin)
 *   POST /api/chats/:id/clear          clear chat (for me)
 *   POST /api/chats/:id/hide           delete chat (for me)
 *   DELETE /api/chats/:id/messages/:messageId?scope=me|everyone
 *   GET  /api/chats/:id/messages/:messageId/info   read by / not read yet (own messages)
 *   GET  /api/chats/:id/messages       membership required (MD may read any)
 *   POST /api/chats/:id/messages       membership required, no MD override;
 *                                      JSON, or multipart with `images` / `documents`, or one `voice`
 *   POST /api/chats/:id/read           marks everything up to a message read
 *   GET  /api/chat-attachments/:id     image bytes, membership checked
 *
 * Every route sits behind `chat.participate`; membership is then checked per
 * conversation inside the service.
 */
export const chatsRouter = Router()
export const chatAttachmentsRouter = Router()

chatsRouter.use(requirePermission('chat.participate', 'organisation'))
chatAttachmentsRouter.use(requirePermission('chat.participate', 'organisation'))

/**
 * Images are held in memory only long enough to be sniffed and handed to the
 * storage adapter. Multer ignores a request that is not multipart, so the same
 * route still serves the plain JSON send path untouched.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  // The larger of the two ceilings; images are held to their own below.
  limits: { fileSize: Math.max(MAX_IMAGE_MB, MAX_VOICE_MB, MAX_DOCUMENT_MB) * 1024 * 1024, files: MAX_IMAGES_PER_MESSAGE + MAX_DOCUMENTS_PER_MESSAGE + 1 },
})

chatsRouter.get('/', handler(async (req, res) => {
  ok(res, await listChats(requireSession(req)))
}))

chatsRouter.get('/people', handler(async (req, res) => {
  ok(res, await chatPeople(requireSession(req)))
}))

chatsRouter.put('/profile-photo', handler(async (req, res) => {
  const b = z.object({ photo_url: z.string().nullable() }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('Send a picture or null.')
  ok(res, await setMyPhoto(requireSession(req), b.data.photo_url))
}))

chatsRouter.get('/:id/info', handler(async (req, res) => {
  ok(res, await chatInfo(req.params.id, requireSession(req)))
}))

chatsRouter.patch('/:id', handler(async (req, res) => {
  const b = z.object({ name: z.string().max(120).optional(), description: z.string().max(400).nullable().optional(), photo_url: z.string().nullable().optional() }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('Check the group name.')
  ok(res, await updateGroup(req.params.id, requireSession(req), b.data))
}))

chatsRouter.post('/:id/members', handler(async (req, res) => {
  const b = z.object({ employee_ids: z.array(z.string()).min(1).max(200) }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('Choose people to add.')
  ok(res, await addMembers(req.params.id, requireSession(req), b.data.employee_ids))
}))

chatsRouter.delete('/:id/members/:employeeId', handler(async (req, res) => {
  ok(res, await removeMember(req.params.id, requireSession(req), req.params.employeeId))
}))

chatsRouter.patch('/:id/members/:employeeId', handler(async (req, res) => {
  const b = z.object({ role: z.enum(['admin', 'member']) }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('Role must be admin or member.')
  ok(res, await setMemberRole(req.params.id, requireSession(req), req.params.employeeId, b.data.role))
}))

chatsRouter.post('/:id/leave', handler(async (req, res) => {
  ok(res, await leaveGroup(req.params.id, requireSession(req)))
}))

chatsRouter.delete('/:id', handler(async (req, res) => {
  ok(res, await deleteGroup(req.params.id, requireSession(req)))
}))

chatsRouter.post('/:id/clear', handler(async (req, res) => {
  ok(res, await clearChat(req.params.id, requireSession(req)))
}))

chatsRouter.post('/:id/hide', handler(async (req, res) => {
  ok(res, await deleteChatForMe(req.params.id, requireSession(req)))
}))

chatsRouter.get('/:id/messages/:messageId/info', handler(async (req, res) => {
  ok(res, await messageInfo(req.params.id, req.params.messageId, requireSession(req)))
}))

chatsRouter.delete('/:id/messages/:messageId', handler(async (req, res) => {
  const scope = req.query.scope === 'everyone' ? 'everyone' : 'me'
  ok(res, await deleteMessage(req.params.id, req.params.messageId, requireSession(req), scope))
}))

chatsRouter.post('/', handler(async (req, res) => {
  const b = z.object({
    type: z.enum(['group', 'dm']).optional(),
    name: z.string().max(120).optional(),
    description: z.string().max(400).optional(),
    member_ids: z.array(z.string()).optional(),
    other_employee_id: z.string().optional(),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('Check the highlighted fields.', b.error.flatten().fieldErrors)
  ok(res, await createChat(requireSession(req), b.data))
}))

chatsRouter.get('/:id/messages', handler(async (req, res) => {
  ok(res, await listMessages(req.params.id, requireSession(req)))
}))

/**
 * Multer rejects an oversized or over-count upload by throwing, which would
 * surface as a bare 500. Translate its codes into the same field-level errors
 * the rest of the API speaks, so the composer can tell the user what to fix.
 */
chatsRouter.post('/:id/messages', (req, res, next) => {
  upload.fields([{ name: 'images', maxCount: MAX_IMAGES_PER_MESSAGE }, { name: 'documents', maxCount: MAX_DOCUMENTS_PER_MESSAGE }, { name: 'voice', maxCount: 1 }])(req, res, (err: unknown) => {
    if (!err) return next()
    const code = (err as { code?: string }).code
    if (code === 'LIMIT_FILE_SIZE') {
      return next(ApiError.unprocessable('too_large', `A file is larger than the ${Math.max(MAX_IMAGE_MB, MAX_VOICE_MB, MAX_DOCUMENT_MB)} MB limit.`))
    }
    if (code === 'LIMIT_FILE_COUNT') {
      return next(ApiError.unprocessable('too_many_images', `A message carries at most ${MAX_IMAGES_PER_MESSAGE} images.`))
    }
    if (code === 'LIMIT_UNEXPECTED_FILE') {
      return next(ApiError.badRequest('Attach images on the `images` field, or one recording on `voice`.'))
    }
    next(ApiError.badRequest('Upload could not be read.'))
  })
}, handler(async (req, res) => {
  const b = z.object({
    body: z.string().optional(),
    // Multipart carries every field as a string, so an absent parent arrives
    // as '' rather than undefined — normalise it away before validation.
    parent_id: z.string().optional(),
    voice_duration_ms: z.coerce.number().optional(),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('Check the message.')
  const files = (req.files as Record<string, { originalname: string; buffer: Buffer; size: number }[]> | undefined) ?? {}
  const images = files.images ?? []
  if (images.some((f) => f.size > MAX_IMAGE_MB * 1024 * 1024)) {
    throw ApiError.unprocessable('too_large', `An image is larger than the ${MAX_IMAGE_MB} MB limit.`)
  }
  ok(res, {
    message: await postMessage(req.params.id, requireSession(req), {
      body: b.data.body,
      parent_id: b.data.parent_id || undefined,
      images,
      documents: files.documents ?? [],
      voice: files.voice?.[0] ?? null,
      voice_duration_ms: b.data.voice_duration_ms,
    }),
  })
}))

chatsRouter.post('/:id/read', handler(async (req, res) => {
  const b = z.object({ message_id: z.string().optional() }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('Check the request.')
  ok(res, await markRead(req.params.id, requireSession(req), b.data.message_id))
}))

/**
 * Image bytes. A plain authenticated GET, so `<img src>` works with the
 * session cookie the app already sends — no signed URL is needed, and unlike
 * one, access is re-evaluated on every request instead of being frozen into a
 * token that keeps working after someone leaves the chat.
 */
chatAttachmentsRouter.get('/:id', handler(async (req, res) => {
  const { bytes, mimeType, filename, kind } = await readAttachment(req.params.id, requireSession(req))
  res.setHeader('Content-Type', mimeType)
  // Images and voice notes render inline; documents always download, so no
  // uploaded file is ever rendered by the browser on our origin. `nosniff`
  // pins the type we sniffed on the way in.
  res.setHeader('Content-Disposition', `${kind === 'document' ? 'attachment' : 'inline'}; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // Immutable: an attachment's bytes never change, only its access can.
  res.setHeader('Cache-Control', 'private, max-age=300')
  res.setHeader('Accept-Ranges', 'bytes')
  // Voice notes are seekable: answer a byte range as the audio element asks.
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
  if (range && (range[1] || range[2])) {
    const size = bytes.length
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start >= size || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`)
      return res.end()
    }
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    return res.send(bytes.subarray(start, end + 1))
  }
  res.send(bytes)
}))
