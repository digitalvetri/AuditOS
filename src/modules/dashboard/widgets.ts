/**
 * Dashboard's own registrations — cross-cutting widgets that don't belong to
 * a specific HR module (quick actions, department table, activity feed).
 */
import { registerWidget } from '@/platform/dashboard/registry';
import { QuickActionsWidget } from './QuickActionsWidget';
import { NotificationsFeedWidget } from './NotificationsFeedWidget';
import { AttendanceBreakdownWidget } from './AttendanceBreakdownWidget';
import { DepartmentTableWidget } from './DepartmentTableWidget';
import { PendingActionsWidget } from './PendingActionsWidget';
import { ActivityFeedWidget } from './ActivityFeedWidget';

// Employee — quick actions in secondary (before balances).
registerWidget({
  id: 'dash.quick-actions',
  slot: 'secondary',
  roles: ['employee', 'dept_manager', 'hr_admin', 'md'],
  scope: 'self',
  component: QuickActionsWidget,
  order: 5,
});

// Notifications feed for everyone (feed slot).
registerWidget({
  id: 'dash.notifications',
  slot: 'feed',
  roles: ['employee', 'dept_manager', 'hr_admin', 'finance_admin', 'md'],
  scope: 'self',
  component: NotificationsFeedWidget,
  order: 20,
});

// Attendance breakdown chart — primary slot, HR/MD.
registerWidget({
  id: 'dash.attendance-breakdown',
  slot: 'primary',
  roles: ['hr_admin', 'md'],
  scope: 'organisation',
  component: AttendanceBreakdownWidget,
  order: 20,
});

// Department table — primary slot for dept manager, HR, MD.
registerWidget({
  id: 'dash.department-table',
  slot: 'primary',
  roles: ['dept_manager', 'hr_admin', 'md'],
  scope: 'department',
  component: DepartmentTableWidget,
  order: 30,
});

// Aggregated pending actions — queue slot for approvers.
registerWidget({
  id: 'dash.pending-actions',
  slot: 'queue',
  roles: ['dept_manager', 'hr_admin', 'md'],
  scope: 'department',
  component: PendingActionsWidget,
  order: 5,
});

// Recent activity feed — HR/MD.
registerWidget({
  id: 'dash.activity',
  slot: 'feed',
  roles: ['hr_admin', 'md'],
  scope: 'organisation',
  component: ActivityFeedWidget,
  order: 10,
});
