import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requirePermission, requireSession } from '../../platform/auth.js'
import { createChat, listChats, listMessages, markRead, postMessage } from './service.js'

/**
 * Chats / Messages (§8.7 + §9)
 *
 *   GET  /api/chats                caller's chats + unread + total
 *   POST /api/chats                DM (idempotent per pair) or group (MD only)
 *   GET  /api/chats/:id/messages   membership required (MD may read any)
 *   POST /api/chats/:id/messages   membership required, no MD override
 *   POST /api/chats/:id/read       marks everything up to a message read
 *
 * Every route sits behind `chat.participate`; membership is then checked per
 * conversation inside the service.
 */
export const chatsRouter = Router()

chatsRouter.use(requirePermission('chat.participate', 'organisation'))

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

chatsRouter.post('/:id/messages', handler(async (req, res) => {
  const b = z.object({
    body: z.string().optional(),
    parent_id: z.string().optional(),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('Check the message.')
  ok(res, { message: await postMessage(req.params.id, requireSession(req), b.data) })
}))

chatsRouter.post('/:id/read', handler(async (req, res) => {
  const b = z.object({ message_id: z.string().optional() }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('Check the request.')
  ok(res, await markRead(req.params.id, requireSession(req), b.data.message_id))
}))
