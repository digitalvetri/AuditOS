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
}

/** An image sent in a chat. `url` is the membership-checked byte route. */
export interface ChatAttachment {
  id: string;
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
}

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
  send: (chatId: string, body: string, parent_id?: string, images: File[] = []) => {
    const path = `/api/chats/${chatId}/messages`;
    if (images.length === 0) {
      return api.post<{ message: ChatMessageWithAuthor }>(path, { body, parent_id });
    }
    const form = new FormData();
    form.set('body', body);
    if (parent_id) form.set('parent_id', parent_id);
    for (const f of images) form.append('images', f);
    return api.postForm<{ message: ChatMessageWithAuthor }>(path, form);
  },
  read: (chatId: string, message_id?: string) =>
    api.post<{ marked: number }>(`/api/chats/${chatId}/read`, { message_id }),
  createDM: (other_employee_id: string) =>
    api.post<{ chat: Chat; created: boolean }>('/api/chats', { type: 'dm', other_employee_id }),
};
