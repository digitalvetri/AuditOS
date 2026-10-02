import { api } from '@/services/api';
import type { Notification } from '@/data/models';

export interface NotificationList {
  items: Notification[];
  unread: number;
  total: number;
}

export const notificationsApi = {
  list: (limit = 20) => api.get<NotificationList>(`/api/notifications?limit=${limit}`),
  markRead: (id: string) => api.patch<{ notification: Notification }>(`/api/notifications/${id}/read`),
  markAllRead: () => api.post<{ ok: true }>('/api/notifications/read-all'),
};
