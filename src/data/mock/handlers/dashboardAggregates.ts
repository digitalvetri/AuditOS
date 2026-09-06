/**
 * Dashboard aggregation endpoints.
 *
 *   GET /api/dashboard/departments       Department | Headcount | Present | Absent | Leave
 *   GET /api/dashboard/pending-actions   aggregated queue: leaves + corrections
 *   GET /api/dashboard/activity          org-wide recent audit log entries
 *
 * Scope:
 *   department scope     → own department only
 *   organisation scope   → all departments
 */

import { http } from 'msw';
import { db } from '../db';
import { err, ok, withAuth } from '../middleware';
import { hasPermission, type Scope } from '@/platform/rbac/matrix';
import { istToday } from '@/lib/dates';
import type { RoleCode } from '@/data/models';
import { expiringDocsForCaller } from './documents';

function roleOf(userId: string): RoleCode | null {
  const u = db.read().users.find((x) => x.id === userId);
  if (!u) return null;
  const r = db.read().roles.find((x) => x.id === u.role_id);
  return r?.code ?? null;
}

function dashboardScope(role: RoleCode): Scope {
  if (hasPermission(role, 'attendance.read', 'organisation')) return 'organisation';
  if (hasPermission(role, 'attendance.read', 'department')) return 'department';
  return 'self';
}

export const dashboardAggregateHandlers = [
  http.get(
    '/api/dashboard/departments',
    withAuth(async ({ user, employee }) => {
      const role = roleOf(user.id)!;
      const scope = dashboardScope(role);
      if (scope === 'self') return err(403, 'forbidden', 'Access denied.');

      const today = istToday();
      const activeEmployees = db
        .read()
        .employees.filter((e) => !e.deleted_at && e.status !== 'inactive');
      const relevantDepts =
        scope === 'department' && employee
          ? db.read().departments.filter((d) => d.id === employee.department_id)
          : db.read().departments;

      const rows = relevantDepts.map((dept) => {
        const empIds = activeEmployees
          .filter((e) => e.department_id === dept.id)
          .map((e) => e.id);
        const todayRows = db
          .read()
          .attendance.filter((a) => a.date === today && empIds.includes(a.employee_id));
        return {
          id: dept.id,
          name: dept.name,
          headcount: empIds.length,
          present: todayRows.filter((r) => r.status === 'present' || r.status === 'late' || r.status === 'wfh').length,
          absent: empIds.length - todayRows.filter((r) => r.check_in_at !== null).length -
            todayRows.filter((r) => r.status === 'on_leave').length,
          on_leave: todayRows.filter((r) => r.status === 'on_leave').length,
        };
      });
      return ok({ items: rows });
    }),
  ),

  http.get(
    '/api/dashboard/pending-actions',
    withAuth(async ({ user, employee }) => {
      const role = roleOf(user.id)!;
      const canApproveLeaveDept = hasPermission(role, 'leave.approve', 'department');
      const canApproveLeaveOrg = hasPermission(role, 'leave.approve', 'organisation');
      const canApproveAttendanceDept = hasPermission(role, 'attendance.correct.approve', 'department');
      const canApproveAttendanceOrg = hasPermission(role, 'attendance.correct.approve', 'organisation');

      const items: {
        kind: 'leave' | 'correction' | 'document_expiring' | 'expense';
        id: string;
        title: string;
        subtitle: string;
        action_url: string;
        created_at: string;
      }[] = [];

      // Expenses awaiting THIS caller — pending_manager for dept mgr,
      // pending_finance for finance/MD.
      const canExpDept = hasPermission(role, 'expense.approve', 'department');
      const canExpOrg = hasPermission(role, 'expense.approve', 'organisation');
      if (canExpDept || canExpOrg) {
        for (const exp of db.read().expenses) {
          if (exp.deleted_at) continue;
          const target = db.read().employees.find((e) => e.id === exp.employee_id);
          if (!target) continue;
          const forThisCaller =
            (exp.stage === 'pending_manager' &&
              (canExpOrg ||
                (canExpDept && employee?.department_id === target.department_id))) ||
            (exp.stage === 'pending_finance' && canExpOrg) ||
            (exp.stage === 'approved' && canExpOrg);
          if (!forThisCaller) continue;
          items.push({
            kind: 'expense',
            id: exp.id,
            title: `${target.full_name} — ${exp.title}`,
            subtitle: `${(exp.amount_paise / 100).toLocaleString('en-IN')} · ${exp.stage.replace('_', ' ')}`,
            action_url:
              exp.stage === 'pending_manager'
                ? '/hrms/expenses?tab=team'
                : '/hrms/expenses?tab=finance',
            created_at: exp.created_at,
          });
        }
      }

      // Leave requests awaiting THIS caller.
      if (canApproveLeaveDept || canApproveLeaveOrg) {
        for (const r of db.read().leaveRequests) {
          if (r.status !== 'pending') continue;
          const target = db.read().employees.find((e) => e.id === r.employee_id);
          if (!target) continue;

          const stage = !r.approver_id ? 'awaiting_manager' : 'awaiting_hr';
          const forThisCaller =
            (stage === 'awaiting_manager' &&
              (canApproveLeaveOrg ||
                (canApproveLeaveDept && employee?.department_id === target.department_id))) ||
            (stage === 'awaiting_hr' && canApproveLeaveOrg);
          if (!forThisCaller) continue;

          const type = db.read().leaveTypes.find((t) => t.id === r.leave_type_id);
          items.push({
            kind: 'leave',
            id: r.id,
            title: `${target.full_name} — ${type?.name ?? 'Leave'}`,
            subtitle: `${r.computed_working_days.toFixed(1)} day(s) · ${r.start_date} → ${r.end_date}`,
            action_url: '/hrms/leave?tab=queue',
            created_at: r.created_at,
          });
        }
      }

      // Attendance corrections awaiting THIS caller.
      if (canApproveAttendanceDept || canApproveAttendanceOrg) {
        for (const c of db.read().corrections) {
          if (c.status !== 'pending') continue;
          const target = db.read().employees.find((e) => e.id === c.employee_id);
          if (!target) continue;
          const forThisCaller =
            canApproveAttendanceOrg ||
            (canApproveAttendanceDept && employee?.department_id === target.department_id);
          if (!forThisCaller) continue;
          items.push({
            kind: 'correction',
            id: c.id,
            title: `${target.full_name} — Attendance correction`,
            subtitle: `${c.date} · ${c.reason.slice(0, 40)}${c.reason.length > 40 ? '…' : ''}`,
            action_url: '/hrms/attendance',
            created_at: c.created_at,
          });
        }
      }

      // Documents expiring within 30 days (§8.8) — surface in the queue.
      const expiring = expiringDocsForCaller(user.id, employee?.id ?? null, 30);
      for (const d of expiring) {
        const emp = db.read().employees.find((e) => e.id === d.employee_id);
        items.push({
          kind: 'document_expiring',
          id: d.id,
          title: `${emp?.full_name ?? 'Someone'} — ${d.name} expiring`,
          subtitle: `Expires ${d.expiry_date} (${d.days_left} day${d.days_left === 1 ? '' : 's'} left)`,
          action_url: `/hrms/documents?expiringWithinDays=30`,
          created_at: d.expiry_date, // sort by soonest expiry
        });
      }

      items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return ok({ items, count: items.length });
    }),
  ),

  http.get(
    '/api/dashboard/activity',
    withAuth(async ({ user }) => {
      const role = roleOf(user.id)!;
      const orgAudit = hasPermission(role, 'audit.read.all', 'organisation');
      const hrAudit = hasPermission(role, 'audit.read.hr', 'organisation');
      if (!orgAudit && !hrAudit) return err(403, 'forbidden', 'Access denied.');
      const rows = [...db.read().auditLog].sort((a, b) =>
        a.created_at > b.created_at ? -1 : 1,
      );
      // Enrich with actor label.
      const items = rows.slice(0, 20).map((r) => {
        const actor = r.actor_user_id
          ? db.read().users.find((u) => u.id === r.actor_user_id)
          : null;
        const actorEmp = actor?.employee_id
          ? db.read().employees.find((e) => e.id === actor.employee_id)
          : null;
        return {
          id: r.id,
          action: r.action,
          entity_type: r.entity_type,
          entity_id: r.entity_id,
          created_at: r.created_at,
          actor_label: actorEmp?.full_name ?? actor?.email ?? 'system',
        };
      });
      return ok({ items });
    }),
  ),
];
