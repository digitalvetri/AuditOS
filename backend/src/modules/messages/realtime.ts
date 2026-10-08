import type { Server as HttpServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import jwt from 'jsonwebtoken'
import { env } from '../../lib/env.js'
import { loadSession } from '../../platform/auth.js'
import { setNotificationEmitter } from '../../platform/notify.js'
import { notificationToApi } from '../../api/serialize.js'
import { chatBus, type ChatEvent } from './events.js'

/**
 * Socket.IO transport (§8.7). It subscribes to the local event bus and nothing
 * more — no domain code imports socket.io, so the messaging service is
 * testable and the transport is replaceable.
 *
 * The handshake is authenticated with the same JWT the HTTP API uses — read
 * from the httpOnly session cookie the browser sends with the upgrade request
 * (same origin through the proxy), or from `auth.token` for non-browser
 * clients. An unauthenticated socket never joins a room.
 */
function cookieToken(header: string | undefined): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === env.cookieName) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return undefined
}

export function attachRealtime(http: HttpServer) {
  const io = new Server(http, {
    cors: { origin: env.webOrigins, credentials: true },
    // The cookie rides along on any page's websocket, and CORS does not apply
    // to the websocket transport — so a browser connection must come from
    // this app's own origin (same host) or a configured web origin.
    allowRequest: (req, done) => {
      const origin = req.headers.origin
      if (!origin) return done(null, true) // non-browser client; auth still required
      try {
        // Hostname only: nginx forwards `Host: $host`, which drops the port.
        const sameHost = new URL(origin).hostname === String(req.headers.host ?? '').replace(/:\d+$/, '')
        done(null, sameHost || env.webOrigins.includes(origin))
      } catch {
        done(null, false)
      }
    },
  })

  io.use(async (socket: Socket, next) => {
    try {
      const token = (socket.handshake.auth?.token as string | undefined)
        ?? cookieToken(socket.request.headers.cookie)
      if (!token) return next(new Error('unauthorized'))
      const payload = jwt.verify(token, env.jwtSecret) as jwt.JwtPayload
      const session = await loadSession(String(payload.sub), typeof payload.v === 'number' ? payload.v : 0)
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
    // No client-chosen rooms: joining `chat:<id>` without a membership check
    // would let any signed-in user listen to any chat. Members hear about
    // chat events through their own `employee:` room (chat:activity).
  })

  chatBus.on('chat', (event: ChatEvent) => {
    io.to(`chat:${event.chatId}`).emit(event.type, event.payload)
    for (const employeeId of event.memberEmployeeIds) {
      io.to(`employee:${employeeId}`).emit('chat:activity', { chat_id: event.chatId, type: event.type })
    }
  })

  setNotificationEmitter((userId, row) => {
    io.to(`user:${userId}`).emit('notification:new', notificationToApi(row as Parameters<typeof notificationToApi>[0]))
  })

  return io
}
