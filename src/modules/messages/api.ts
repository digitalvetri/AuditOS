import { api } from '@/services/api';
import type { Chat, ChatMessage } from '@/data/models';

export interface ChatListItem extends Chat {
  display_name: string;
  last_message: { id: string; body: string; created_at: string; author_id: string } | null;
  unread: number;
  member_count: number;
}

export interface ChatMessageWithAuthor extends ChatMessage {
  author: { id: string; full_name: string; employee_code: string } | null;
  parent_preview: { id: string; body: string; author_full_name: string | null } | null;
  read_by_me: boolean;
}

export interface ChatDetail {
  chat: Chat & { display_name: string };
  items: ChatMessageWithAuthor[];
}

export const messagesApi = {
  listChats: () => api.get<{ items: ChatListItem[]; total_unread: number }>('/api/chats'),
  messages: (chatId: string) => api.get<ChatDetail>(`/api/chats/${chatId}/messages`),
  send: (chatId: string, body: string, parent_id?: string) =>
    api.post<{ message: ChatMessageWithAuthor }>(`/api/chats/${chatId}/messages`, { body, parent_id }),
  read: (chatId: string, message_id?: string) =>
    api.post<{ marked: number }>(`/api/chats/${chatId}/read`, { message_id }),
  createDM: (other_employee_id: string) =>
    api.post<{ chat: Chat; created: boolean }>('/api/chats', { type: 'dm', other_employee_id }),
};
