import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requirePermission, requireSession } from '../../platform/auth.js'
import {
  createChat, deleteMessage, directory, listChats, listMessages,
  markRead, postMessage, reactToMessage, totalUnread,
} from './service.js'

/**
 * Messages routes. Every one sits behind `chat.participate`; membership is
 * then checked per conversation inside the service.
 */
export const messagesRouter = Router()

messagesRouter.use(requirePermission('chat.participate', 'organisation'))

messagesRouter.get('/chats', handler(async (req, res) => {
  ok(res, { items: await listChats(requireSession(req)) })
}))

messagesRouter.get('/unread-count', handler(async (req, res) => {
  const session = requireSession(req)
  ok(res, { unread_count: session.employeeId ? await totalUnread(session.employeeId) : 0 })
}))

messagesRouter.get('/directory', handler(async (req, res) => {
  ok(res, { items: await directory(requireSession(req)) })
}))

messagesRouter.post('/chats', handler(async (req, res) => {
  const b = z.object({
    type: z.enum(['GROUP', 'DIRECT']),
    name: z.string().max(120).optional(),
    member_employee_ids: z.array(z.string()).min(1, 'Choose at least one participant.'),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('Check the highlighted fields.', b.error.flatten().fieldErrors)
  ok(res, { chat: await createChat(requireSession(req), b.data) }, 201)
}))

messagesRouter.get('/chats/:id/messages', handler(async (req, res) => {
  const q = z.object({
    search: z.string().optional(),
    before: z.coerce.date().optional(),
    take: z.coerce.number().int().min(1).max(500).optional(),
  }).parse(req.query)
  ok(res, { items: await listMessages(req.params.id, requireSession(req), q) })
}))

messagesRouter.post('/chats/:id/messages', handler(async (req, res) => {
  const b = z.object({
    body: z.string().max(4000),
    reply_to_id: z.string().optional(),
    attachment_name: z.string().max(200).nullable().optional(),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('Check the message.', b.error.flatten().fieldErrors)
  ok(res, { message: await postMessage(req.params.id, requireSession(req), b.data) }, 201)
}))

messagesRouter.post('/chats/:id/read', handler(async (req, res) => {
  ok(res, await markRead(req.params.id, requireSession(req)))
}))

messagesRouter.post('/messages/:messageId/react', handler(async (req, res) => {
  const emoji = z.string().min(1).max(8).safeParse(req.body?.emoji)
  if (!emoji.success) throw ApiError.badRequest('Choose a reaction.')
  ok(res, await reactToMessage(req.params.messageId, requireSession(req), emoji.data))
}))

messagesRouter.delete('/messages/:messageId', handler(async (req, res) => {
  ok(res, await deleteMessage(req.params.messageId, requireSession(req)))
}))
