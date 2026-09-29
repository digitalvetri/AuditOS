import { api } from '@/services/api';
import type { Chat, ChatMessage } from '@/data/models';

export interface ChatListItem extends Chat {
  display_name: string;
  last_message: {
    id: string; body: string; created_at: string; author_id: string;
    attachment_count: number;
  } | null;
  unread: number;
  member_count: number;
  /** Groups: admin / member; null once you've left (or a DM seen via MD override). */
  my_role: 'admin' | 'member' | null;
}

/** An image sent in a chat. `url` is the membership-checked byte route. */
export interface ChatAttachment {
  id: string;
  /** image | audio (voice message) | document */
  kind: 'image' | 'audio' | 'document';
  duration_ms: number | null;
  filename: string;
  mime_type: string;
  file_size: number;
  url: string;
}

export interface ChatMessageWithAuthor extends ChatMessage {
  author: { id: string; full_name: string; employee_code: string } | null;
  parent_preview: { id: string; body: string; author_full_name: string | null } | null;
  read_by_me: boolean;
  attachments: ChatAttachment[];
  /** Deleted for everyone — shown as "This message was deleted". */
  deleted: boolean;
}

export interface MessageInfo {
  message_id: string; sent_at: string; deleted: boolean;
  read_by: { employee_id: string; full_name: string; read_at: string | null }[];
  not_read: { employee_id: string; full_name: string; read_at: null }[];
}
export interface ChatPerson { id: string; full_name: string; employee_code: string; designation: string | null }
export interface ChatMemberInfo { employee_id: string; full_name: string; employee_code: string; designation: string | null; role: 'admin' | 'member'; joined_at: string }
export interface ChatInfo { chat: Chat & { display_name: string }; my_role: 'admin' | 'member' | null; left: boolean; members: ChatMemberInfo[] }

export interface ChatDetail {
  chat: Chat & { display_name: string };
  items: ChatMessageWithAuthor[];
}

export const messagesApi = {
  listChats: () => api.get<{ items: ChatListItem[]; total_unread: number }>('/api/chats'),
  messages: (chatId: string) => api.get<ChatDetail>(`/api/chats/${chatId}/messages`),
  /**
   * Send text, images, or both. Images force multipart; a text-only send stays
   * on the JSON path so the common case is unchanged.
   */
  send: (chatId: string, body: string, parent_id?: string, images: File[] = [], documents: File[] = []) => {
    const path = `/api/chats/${chatId}/messages`;
    if (images.length === 0 && documents.length === 0) {
      return api.post<{ message: ChatMessageWithAuthor }>(path, { body, parent_id });
    }
    const form = new FormData();
    form.set('body', body);
    if (parent_id) form.set('parent_id', parent_id);
    for (const f of images) form.append('images', f);
    for (const f of documents) form.append('documents', f);
    return api.postForm<{ message: ChatMessageWithAuthor }>(path, form);
  },
  read: (chatId: string, message_id?: string) =>
    api.post<{ marked: number }>(`/api/chats/${chatId}/read`, { message_id }),
  createDM: (other_employee_id: string) =>
    api.post<{ chat: Chat; created: boolean }>('/api/chats', { type: 'dm', other_employee_id }),
  createGroup: (name: string, member_ids: string[], description?: string) =>
    api.post<{ chat: Chat; created: boolean }>('/api/chats', { type: 'group', name, member_ids, description }),
  people: () => api.get<{ items: ChatPerson[] }>('/api/chats/people'),
  info: (chatId: string) => api.get<ChatInfo>(`/api/chats/${chatId}/info`),
  updateGroup: (chatId: string, input: { name?: string; description?: string | null }) => api.patch<{ chat: Chat }>(`/api/chats/${chatId}`, input),
  addMembers: (chatId: string, employee_ids: string[]) => api.post<ChatInfo>(`/api/chats/${chatId}/members`, { employee_ids }),
  removeMember: (chatId: string, employeeId: string) => api.delete<ChatInfo>(`/api/chats/${chatId}/members/${employeeId}`),
  setRole: (chatId: string, employeeId: string, role: 'admin' | 'member') => api.patch<ChatInfo>(`/api/chats/${chatId}/members/${employeeId}`, { role }),
  leave: (chatId: string) => api.post<{ left: true }>(`/api/chats/${chatId}/leave`, {}),
  deleteGroup: (chatId: string) => api.delete<{ deleted: true }>(`/api/chats/${chatId}`),
  clear: (chatId: string) => api.post<{ cleared: true }>(`/api/chats/${chatId}/clear`, {}),
  hide: (chatId: string) => api.post<{ deleted: true }>(`/api/chats/${chatId}/hide`, {}),
  deleteMessage: (chatId: string, messageId: string, scope: 'me' | 'everyone') =>
    api.delete<{ deleted: 'me' | 'everyone' }>(`/api/chats/${chatId}/messages/${messageId}?scope=${scope}`),
  messageInfo: (chatId: string, messageId: string) =>
    api.get<MessageInfo>(`/api/chats/${chatId}/messages/${messageId}/info`),
  /** Send one recorded voice note (no text or images alongside it). */
  sendVoice: (chatId: string, blob: Blob, durationMs: number, parent_id?: string) => {
    const form = new FormData();
    const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
    form.append('voice', blob, `voice-message.${ext}`);
    form.set('voice_duration_ms', String(Math.round(durationMs)));
    if (parent_id) form.set('parent_id', parent_id);
    return api.postForm<{ message: ChatMessageWithAuthor }>(`/api/chats/${chatId}/messages`, form);
  },
};
