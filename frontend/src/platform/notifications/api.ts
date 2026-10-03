import { api } from '@/services/api';
import type { Notification } from '@/data/models';

export interface NotificationList {
  items: Notification[];
  unread: number;
  total: number;
  snoozed: number;
}

export const notificationsApi = {
  list: (limit = 20, includeSnoozed = false) =>
    api.get<NotificationList>(`/api/notifications?limit=${limit}${includeSnoozed ? '&include_snoozed=1' : ''}`),
  markRead: (id: string) => api.patch<{ notification: Notification }>(`/api/notifications/${id}/read`),
  markAllRead: () => api.post<{ ok: true }>('/api/notifications/read-all'),
  snooze: (id: string, until: Date) =>
    api.post<{ notification: Notification }>(`/api/notifications/${id}/snooze`, { until: until.toISOString() }),
  unsnooze: (id: string) =>
    api.post<{ notification: Notification }>(`/api/notifications/${id}/unsnooze`),
};

/** The five snooze presets. Keep them short — the menu is one click deep. */
export function snoozePresets(now = new Date()): { label: string; until: Date }[] {
  const in1h = new Date(now.getTime() + 60 * 60 * 1000);
  const in4h = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const tomorrow9am = new Date(now);
  tomorrow9am.setDate(tomorrow9am.getDate() + 1);
  tomorrow9am.setHours(9, 0, 0, 0);
  // Next Monday 9am. If today is Sun, "next Monday" is tomorrow — which can
  // overlap "Tomorrow 9am"; the UI de-dupes by label match.
  const nextMonday = new Date(now);
  const daysToMonday = (8 - nextMonday.getDay()) % 7 || 7;
  nextMonday.setDate(nextMonday.getDate() + daysToMonday);
  nextMonday.setHours(9, 0, 0, 0);
  const in1w = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return [
    { label: '1 hour', until: in1h },
    { label: '4 hours', until: in4h },
    { label: 'Tomorrow 9am', until: tomorrow9am },
    { label: 'Next Monday', until: nextMonday },
    { label: '1 week', until: in1w },
  ];
}
