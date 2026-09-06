import { api } from '@/services/api';

export interface DepartmentRow {
  id: string;
  name: string;
  headcount: number;
  present: number;
  absent: number;
  on_leave: number;
}

export interface PendingActionItem {
  kind: 'leave' | 'correction' | 'document_expiring';
  id: string;
  title: string;
  subtitle: string;
  action_url: string;
  created_at: string;
}

export interface ActivityItem {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  created_at: string;
  actor_label: string;
}

export const dashboardApi = {
  departments: () => api.get<{ items: DepartmentRow[] }>('/api/dashboard/departments'),
  pendingActions: () =>
    api.get<{ items: PendingActionItem[]; count: number }>('/api/dashboard/pending-actions'),
  activity: () => api.get<{ items: ActivityItem[] }>('/api/dashboard/activity'),
};
