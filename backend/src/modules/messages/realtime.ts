import type { Server as HttpServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import jwt from 'jsonwebtoken'
import { env } from '../../lib/env.js'
import { loadSession } from '../../platform/auth.js'
import { setNotificationEmitter } from '../../platform/notify.js'
import { chatBus, type ChatEvent } from './events.js'

/**
 * Socket.IO transport (§8.7). It subscribes to the local event bus and nothing
 * more — no domain code imports socket.io, so the messaging service is
 * testable and the transport is replaceable.
 *
 * The handshake is authenticated with the same JWT the HTTP API uses. An
 * unauthenticated socket never joins a room.
 */
export function attachRealtime(http: HttpServer) {
  const io = new Server(http, { cors: { origin: env.webOrigins, credentials: true } })

  io.use(async (socket: Socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined
      if (!token) return next(new Error('unauthorized'))
      const payload = jwt.verify(token, env.jwtSecret) as jwt.JwtPayload
      const session = await loadSession(String(payload.sub))
      if (!session) return next(new Error('unauthorized'))
      socket.data.session = session
      next()
    } catch {
      next(new Error('unauthorized'))
    }
  })

  io.on('connection', (socket) => {
    const session = socket.data.session as { userId: string; employeeId: string | null }
    socket.join(`user:${session.userId}`)
    if (session.employeeId) socket.join(`employee:${session.employeeId}`)
    socket.on('chat:join', (chatId: string) => socket.join(`chat:${chatId}`))
    socket.on('chat:leave', (chatId: string) => socket.leave(`chat:${chatId}`))
  })

  chatBus.on('chat', (event: ChatEvent) => {
    io.to(`chat:${event.chatId}`).emit(event.type, event.payload)
    for (const employeeId of event.memberEmployeeIds) {
      io.to(`employee:${employeeId}`).emit('chat:activity', { chat_id: event.chatId, type: event.type })
    }
  })

  setNotificationEmitter((userId, payload) => {
    io.to(`user:${userId}`).emit('notification:new', payload)
  })

  return io
}
