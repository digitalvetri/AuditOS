import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requirePermission, requireSession } from '../../platform/auth.js'
import {
  createChat, listChats, listMessages, markRead, postMessage, readAttachment,
} from './service.js'
import { MAX_IMAGE_MB, MAX_IMAGES_PER_MESSAGE } from './attachments.js'

/**
 * Chats / Messages (§8.7 + §9)
 *
 *   GET  /api/chats                    caller's chats + unread + total
 *   POST /api/chats                    DM (idempotent per pair) or group (MD only)
 *   GET  /api/chats/:id/messages       membership required (MD may read any)
 *   POST /api/chats/:id/messages       membership required, no MD override;
 *                                      JSON, or multipart with `images`
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
  limits: { fileSize: MAX_IMAGE_MB * 1024 * 1024, files: MAX_IMAGES_PER_MESSAGE },
})

chatsRouter.get('/', handler(async (req, res) => {
  ok(res, await listChats(requireSession(req)))
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
  upload.array('images', MAX_IMAGES_PER_MESSAGE)(req, res, (err: unknown) => {
    if (!err) return next()
    const code = (err as { code?: string }).code
    if (code === 'LIMIT_FILE_SIZE') {
      return next(ApiError.unprocessable('too_large', `An image is larger than the ${MAX_IMAGE_MB} MB limit.`))
    }
    if (code === 'LIMIT_FILE_COUNT') {
      return next(ApiError.unprocessable('too_many_images', `A message carries at most ${MAX_IMAGES_PER_MESSAGE} images.`))
    }
    if (code === 'LIMIT_UNEXPECTED_FILE') {
      return next(ApiError.badRequest('Attach images on the `images` field.'))
    }
    next(ApiError.badRequest('Upload could not be read.'))
  })
}, handler(async (req, res) => {
  const b = z.object({
    body: z.string().optional(),
    // Multipart carries every field as a string, so an absent parent arrives
    // as '' rather than undefined — normalise it away before validation.
    parent_id: z.string().optional(),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('Check the message.')
  const images = (req.files as { originalname: string; buffer: Buffer }[] | undefined) ?? []
  ok(res, {
    message: await postMessage(req.params.id, requireSession(req), {
      body: b.data.body,
      parent_id: b.data.parent_id || undefined,
      images,
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
  const { bytes, mimeType, filename } = await readAttachment(req.params.id, requireSession(req))
  res.setHeader('Content-Type', mimeType)
  // `inline` so the browser renders it; `nosniff` so it can never be treated
  // as anything but the image type we sniffed on the way in.
  res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // Immutable: an attachment's bytes never change, only its access can.
  res.setHeader('Cache-Control', 'private, max-age=300')
  res.send(bytes)
}))
