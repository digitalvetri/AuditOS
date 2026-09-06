import { EventEmitter } from 'node:events'

/**
 * Local event bus — HRMS-Part-2.md §8.7 "Realtime via Socket.IO (mock-mode:
 * local event bus)". The service layer only ever publishes here; the socket
 * transport subscribes. Nothing in the domain imports socket.io.
 */
export const chatBus = new EventEmitter()
chatBus.setMaxListeners(200)

export interface ChatEvent {
  chatId: string
  memberEmployeeIds: string[]
  type: 'message:new' | 'message:updated' | 'message:deleted' | 'chat:read'
  payload: unknown
}

export function publishChatEvent(event: ChatEvent) {
  chatBus.emit('chat', event)
}
