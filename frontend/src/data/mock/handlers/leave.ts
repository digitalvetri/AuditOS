/**
 * Leave handlers per §9.
 *
 *   GET  /api/leaves                                          list, scoped
 *   POST /api/leaves                                          apply
 *   GET  /api/leaves/:id                                      one
 *   POST /api/leaves/:id/approve | /reject | /cancel
 *   GET  /api/leaves/balances/:employeeId                     balances (per §5 scope)
 *   GET  /api/leaves/holidays                                 org-wide
 *
 * Approval routing (§3):
 *   days ≤ 5  → manager approve → status='approved'
 *   days > 5  → manager approve (approver_id set, status still 'pending')
 *              → HR approve (hr_approver_id set, status='approved')
 *
 * On 'approved': deduct balance + upsert On Leave attendance rows for range.
 * On cancel of a FUTURE approved leave: restore balance + remove those rows.
 * On rejection: mandatory reason, notify. No balance/attendance mutation.
 */

import { http } from 'msw';
import type {
  Attendance,
  Employee,
  LeaveRequest,
  LeaveType,
  RoleCode,
} from '@/data/models';
import { db } from '../db';
import { audit, err, ok, withAuth } from '../middleware';
import { hasPermission, type Scope } from '@/platform/rbac/matrix';
import { computeWorkingDays } from '@/lib/leaveDays';
import { istToday, daysBetween } from '@/lib/dates';

// ── Helpers ───────────────────────────────────────────────────────────────

function roleOf(userId: string): RoleCode | null {
  const u = db.read().users.find((x) => x.id === userId);
  if (!u) return null;
  const r = db.read().roles.find((x) => x.id === u.role_id);
  return r?.code ?? null;
}

function scopeForLeave(role: RoleCode): Scope {
  if (hasPermission(role, 'leave.manage', 'organisation')) return 'organisation';
  if (hasPermission(role, 'leave.read', 'organisation')) return 'organisation';
  if (hasPermission(role, 'leave.approve', 'organisation')) return 'organisation';
  if (hasPermission(role, 'leave.read', 'department')) return 'department';
  if (hasPermission(role, 'leave.approve', 'department')) return 'department';
  return 'self';
}

function findEmp(id: string): Employee | null {
  return db.read().employees.find((e) => e.id === id) ?? null;
}

function findType(id: string): LeaveType | null {
  return db.read().leaveTypes.find((t) => t.id === id) ?? null;
}

function findSchedule(id: string) {
  return db.read().workSchedules.find((s) => s.id === id) ?? null;
}

function notify(
  userId: string,
  n: {
    type: string;
    title: string;
    body: string;
    entity_id?: string | null;
    action_url?: string | null;
  },
): void {
  db.write((d) => {
    d.notifications.push({
      id: `ntf-${crypto.randomUUID()}`,
      user_id: userId,
      type: n.type,
      module: 'leave',
      entity_type: 'LeaveRequest',
      entity_id: n.entity_id ?? null,
      title: n.title,
      body: n.body,
      action_url: n.action_url ?? null,
      is_read: false,
      created_at: new Date().toISOString(),
    });
  });
}

function computeDaysFor(request: {
  employee_id: string;
  start_date: string;
  end_date: string;
  half_day: boolean;
}): number {
  const emp = findEmp(request.employee_id);
  if (!emp) return 0;
  const schedule = findSchedule(emp.work_schedule_id);
  if (!schedule) return 0;
  const holidays = db.read().holidays;
  return computeWorkingDays({
    startISO: request.start_date,
    endISO: request.end_date,
    halfDay: request.half_day,
    schedule,
    holidays,
  });
}

function upsertOnLeaveRows(
  employeeId: string,
  startISO: string,
  endISO: string,
  actorUserId: string,
): void {
  const dates = enumerate(startISO, endISO);
  const nowISO = new Date().toISOString();
  db.write((d) => {
    for (const iso of dates) {
      const existing = d.attendance.find(
        (a) => a.employee_id === employeeId && a.date === iso,
      );
      if (existing) {
        existing.check_in_at = null;
        existing.check_out_at = null;
        existing.check_in_lat = null;
        existing.check_in_long = null;
        existing.check_in_accuracy_m = null;
        existing.check_out_lat = null;
        existing.check_out_long = null;
        existing.check_out_accuracy_m = null;
        existing.check_in_location_id = null;
        existing.check_out_location_id = null;
        existing.location_type = null;
        existing.off_site_reason = null;
        existing.worked_minutes = null;
        existing.break_minutes = null;
        existing.status = 'on_leave';
        existing.source = 'manual';
        existing.updated_at = nowISO;
        existing.updated_by = actorUserId;
      } else {
        d.attendance.push({
          id: `att-${employeeId}-${iso}`,
          employee_id: employeeId,
          date: iso,
          check_in_at: null,
          check_out_at: null,
          check_in_lat: null,
          check_in_long: null,
          check_in_accuracy_m: null,
          check_out_lat: null,
          check_out_long: null,
          check_out_accuracy_m: null,
          check_in_location_id: null,
          check_out_location_id: null,
          location_type: null,
          off_site_reason: null,
          worked_minutes: null,
          break_minutes: null,
          status: 'on_leave',
          source: 'manual',
          correction_status: 'none',
          device: null,
          ip: null,
          client_id: null,
          created_at: nowISO,
          updated_at: nowISO,
          created_by: actorUserId,
          updated_by: actorUserId,
          deleted_at: null,
        } satisfies Attendance);
      }
    }
  });
}

function removeOnLeaveRows(employeeId: string, startISO: string, endISO: string): void {
  const dates = new Set(enumerate(startISO, endISO));
  db.write((d) => {
    d.attendance = d.attendance.filter(
      (a) => !(a.employee_id === employeeId && dates.has(a.date) && a.status === 'on_leave'),
    );
  });
}

function enumerate(startISO: string, endISO: string): string[] {
  const [sy, sm, sd] = startISO.split('-').map(Number);
  const [ey, em, ed] = endISO.split('-').map(Number);
  const cur = new Date(Date.UTC(sy, sm - 1, sd));
  const end = new Date(Date.UTC(ey, em - 1, ed));
  const out: string[] = [];
  while (cur.getTime() <= end.getTime()) {
    out.push(
      `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}-${String(cur.getUTCDate()).padStart(2, '0')}`,
    );
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function overlaps(a: { start_date: string; end_date: string }, b: { start_date: string; end_date: string }): boolean {
  return !(a.end_date < b.start_date || a.start_date > b.end_date);
}

function derivedApproverStage(req: LeaveRequest): 'awaiting_manager' | 'awaiting_hr' | 'terminal' {
  if (req.status !== 'pending') return 'terminal';
  if (!req.approver_id) return 'awaiting_manager';
  return 'awaiting_hr';
}

// ── Handlers ──────────────────────────────────────────────────────────────

export const leaveHandlers = [
  // GET /api/leaves/holidays  — org-wide, cheap
  http.get('/api/leaves/holidays', withAuth(async () => {
    return ok({ items: db.read().holidays });
  })),

  // GET /api/leaves/balances/:employeeId
  http.get(
    '/api/leaves/balances/:employeeId',
    withAuth(async ({ user, employee, params }) => {
      const targetId = String(params.employeeId);
      const role = roleOf(user.id)!;
      const scope = scopeForLeave(role);
      const target = findEmp(targetId);
      if (!target) return err(403, 'forbidden', 'Access denied.');

      const allowed =
        scope === 'organisation' ||
        (scope === 'department' && employee?.department_id === target.department_id) ||
        (scope === 'self' && employee?.id === targetId);
      if (!allowed) return err(403, 'forbidden', 'Access denied.');

      const balances = db.read().leaveBalances.filter((b) => b.employee_id === targetId);
      const types = db.read().leaveTypes;
      // Pending days by type — reflected in the UI so users see net available.
      const pendingByType: Record<string, number> = {};
      for (const r of db.read().leaveRequests) {
        if (r.employee_id !== targetId) continue;
        if (r.status !== 'pending') continue;
        pendingByType[r.leave_type_id] = (pendingByType[r.leave_type_id] ?? 0) + r.computed_working_days;
      }
      const items = types.map((t) => {
        const b = balances.find((x) => x.leave_type_id === t.id);
        return {
          type: t,
          entitled: b?.entitled ?? 0,
          availed: b?.availed ?? 0,
          carried_forward: b?.carried_forward ?? 0,
          pending: pendingByType[t.id] ?? 0,
        };
      });
      return ok({ items });
    }),
  ),

  // GET /api/leaves?employeeId=&status=&scope=queue
  http.get(
    '/api/leaves',
    withAuth(async ({ user, employee, request }) => {
      const url = new URL(request.url);
      const employeeId = url.searchParams.get('employeeId');
      const status = url.searchParams.get('status');
      const queue = url.searchParams.get('scope') === 'queue';

      const role = roleOf(user.id)!;
      const scope = scopeForLeave(role);
      const canApproveDept = hasPermission(role, 'leave.approve', 'department');
      const canApproveOrg = hasPermission(role, 'leave.approve', 'organisation');

      let rows = db.read().leaveRequests;

      // Scope: what the caller is allowed to SEE.
      if (scope === 'organisation') {
        // all
      } else if (scope === 'department' && employee) {
        const deptEmps = db
          .read()
          .employees.filter((e) => e.department_id === employee.department_id)
          .map((e) => e.id);
        rows = rows.filter((r) => deptEmps.includes(r.employee_id));
      } else if (employee) {
        rows = rows.filter((r) => r.employee_id === employee.id);
      } else {
        rows = [];
      }

      if (employeeId) {
        if (!rows.some((r) => r.employee_id === employeeId)) {
          // If the caller can't see any rows for this employee, that's a hard 403 — not empty 200.
          const target = findEmp(employeeId);
          if (!target) return err(403, 'forbidden', 'Access denied.');
          if (scope === 'self' && employee?.id !== employeeId)
            return err(403, 'forbidden', 'Access denied.');
          if (scope === 'department' && target.department_id !== employee?.department_id)
            return err(403, 'forbidden', 'Access denied.');
        }
        rows = rows.filter((r) => r.employee_id === employeeId);
      }

      if (status) rows = rows.filter((r) => r.status === status);

      if (queue) {
        // "queue" — only requests awaiting THIS caller.
        rows = rows.filter((r) => {
          if (r.status !== 'pending') return false;
          const stage = derivedApproverStage(r);
          const emp = findEmp(r.employee_id);
          if (!emp) return false;
          if (stage === 'awaiting_manager') {
            // Manager for this employee, or org-wide approver.
            if (canApproveOrg) return true;
            if (canApproveDept && employee) return emp.department_id === employee.department_id;
            return false;
          }
          if (stage === 'awaiting_hr') {
            // HR / MD only (org scope on leave.approve).
            return canApproveOrg;
          }
          return false;
        });
      }

      rows = [...rows].sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
      const items = rows.map((r) => {
        const emp = findEmp(r.employee_id);
        const type = findType(r.leave_type_id);
        return {
          ...r,
          employee: emp
            ? { id: emp.id, full_name: emp.full_name, employee_code: emp.employee_code }
            : null,
          type: type ? { id: type.id, name: type.name, code: type.code } : null,
          stage: derivedApproverStage(r),
        };
      });
      return ok({ items, count: items.length });
    }),
  ),

  // GET /api/leaves/:id
  http.get(
    '/api/leaves/:id',
    withAuth(async ({ user, employee, params }) => {
      const id = String(params.id);
      const req = db.read().leaveRequests.find((r) => r.id === id);
      if (!req) return err(404, 'not_found', 'Leave request not found.');

      const role = roleOf(user.id)!;
      const scope = scopeForLeave(role);
      const owner = employee?.id === req.employee_id;
      const target = findEmp(req.employee_id);
      const allowed =
        scope === 'organisation' ||
        (scope === 'department' && employee?.department_id === target?.department_id) ||
        owner;
      if (!allowed) return err(403, 'forbidden', 'Access denied.');

      const type = findType(req.leave_type_id);
      return ok({ request: { ...req, type, stage: derivedApproverStage(req) } });
    }),
  ),

  // POST /api/leaves — apply
  http.post(
    '/api/leaves',
    withAuth(async ({ user, employee, request }) => {
      if (!employee) return err(422, 'no_employee', 'This account has no employee record.');
      const body = (await request.json().catch(() => ({}))) as {
        leave_type_id?: string;
        start_date?: string;
        end_date?: string;
        half_day?: boolean;
        reason?: string;
      };
      const { leave_type_id, start_date, end_date, half_day = false, reason } = body;
      if (!leave_type_id || !start_date || !end_date || !reason?.trim()) {
        return err(400, 'validation', 'leave_type_id, start_date, end_date and reason are required.');
      }
      if (start_date > end_date) {
        return err(422, 'invalid_range', 'End date must be on or after start date.');
      }
      const type = findType(leave_type_id);
      if (!type) return err(400, 'unknown_type', 'Unknown leave type.');

      // Probation gating (§3): Earned does not accrue during probation.
      if (!type.accrue_during_probation && employee.status === 'probation') {
        return err(422, 'probation', `${type.name} leave is not available during probation.`);
      }

      // Half-day gating.
      if (half_day && !type.half_day_allowed) {
        return err(422, 'half_day_not_allowed', `${type.name} does not allow half-day.`);
      }
      if (half_day && start_date !== end_date) {
        return err(422, 'half_day_range', 'Half-day requests must be for a single date.');
      }

      // Notice-days (retroactive allowed when min_notice_days = 0).
      const today = istToday();
      const daysUntilStart = daysBetween(today, start_date); // negative if past
      if (daysUntilStart < 0 && type.min_notice_days > 0) {
        return err(422, 'past_date', `${type.name} cannot be applied for past dates.`);
      }
      if (daysUntilStart >= 0 && daysUntilStart < type.min_notice_days) {
        return err(
          422,
          'insufficient_notice',
          `${type.name} requires at least ${type.min_notice_days} day(s) of notice.`,
        );
      }

      // Overlap with pending/approved (per advisor — reject at submit).
      const overlap = db
        .read()
        .leaveRequests.find(
          (r) =>
            r.employee_id === employee.id &&
            (r.status === 'pending' || r.status === 'approved') &&
            overlaps({ start_date, end_date }, r),
        );
      if (overlap) {
        return err(409, 'overlap', 'You already have a leave request that overlaps these dates.');
      }

      // Server-authoritative day count.
      const days = computeDaysFor({
        employee_id: employee.id,
        start_date,
        end_date,
        half_day,
      });
      if (days <= 0) {
        return err(422, 'no_working_days', 'Selected range contains no working days.');
      }

      // Balance check (LOP is unlimited).
      if (type.code !== 'lop') {
        const bal = db.read().leaveBalances.find(
          (b) => b.employee_id === employee.id && b.leave_type_id === type.id,
        );
        const available = (bal?.entitled ?? 0) + (bal?.carried_forward ?? 0) - (bal?.availed ?? 0);
        // Include already-pending days in the "reserved" side so employees can't double-book.
        const pending = db
          .read()
          .leaveRequests.filter(
            (r) =>
              r.employee_id === employee.id &&
              r.leave_type_id === type.id &&
              r.status === 'pending',
          )
          .reduce((sum, r) => sum + r.computed_working_days, 0);
        if (days > available - pending) {
          return err(
            422,
            'insufficient_balance',
            `Insufficient ${type.name} balance. Available ${(available - pending).toFixed(1)}, requested ${days.toFixed(1)}.`,
          );
        }
      }

      const nowISO = new Date().toISOString();
      const row: LeaveRequest = {
        id: `lr-${crypto.randomUUID()}`,
        employee_id: employee.id,
        leave_type_id: type.id,
        start_date,
        end_date,
        half_day,
        computed_working_days: days,
        reason: reason.trim(),
        attachment_url: null,
        status: 'pending',
        approver_id: null,
        hr_approver_id: null,
        approved_at: null,
        rejection_reason: null,
        created_at: nowISO,
        updated_at: nowISO,
        created_by: user.id,
        updated_by: user.id,
        deleted_at: null,
      };

      db.write((d) => d.leaveRequests.push(row));

      audit({
        actor_user_id: user.id,
        action: 'leave.requested',
        entity_type: 'LeaveRequest',
        entity_id: row.id,
        after_json: { type: type.code, start_date, end_date, days },
        request,
      });

      // Notify reporting manager.
      const mgr = employee.manager_id ? findEmp(employee.manager_id) : null;
      const mgrUser = mgr
        ? db.read().users.find((u) => u.employee_id === mgr.id)
        : null;
      if (mgrUser) {
        notify(mgrUser.id, {
          type: 'leave.requested',
          title: 'Leave request to review',
          body: `${employee.full_name} requested ${days.toFixed(1)} day(s) ${type.name} from ${start_date}.`,
          entity_id: row.id,
          action_url: '/hrms/leave',
        });
      }

      return ok({ request: { ...row, type, stage: derivedApproverStage(row) } });
    }),
  ),

  // POST /api/leaves/:id/approve
  http.post(
    '/api/leaves/:id/approve',
    withAuth(async ({ user, employee, params, request }) => {
      const id = String(params.id);
      const req = db.read().leaveRequests.find((r) => r.id === id);
      if (!req) return err(404, 'not_found', 'Leave request not found.');
      if (req.status !== 'pending')
        return err(409, 'not_pending', 'This request is no longer pending.');

      const role = roleOf(user.id)!;
      const canApproveDept = hasPermission(role, 'leave.approve', 'department');
      const canApproveOrg = hasPermission(role, 'leave.approve', 'organisation');
      if (!canApproveDept && !canApproveOrg)
        return err(403, 'forbidden', 'Access denied.');

      const target = findEmp(req.employee_id);
      if (!target) return err(422, 'no_employee', 'Requester has no employee record.');

      const stage = derivedApproverStage(req);
      const nowISO = new Date().toISOString();
      let becameApproved = false;

      if (stage === 'awaiting_manager') {
        // Approver must be manager of target OR org-wide (HR/MD).
        const isManager = target.manager_id === employee?.id;
        if (!isManager && !canApproveOrg) {
          return err(403, 'forbidden', 'Only the reporting manager (or HR/MD) can approve at this stage.');
        }
        // First-stage approval.
        db.write((d) => {
          const t = d.leaveRequests.find((r) => r.id === id)!;
          t.approver_id = user.id;
          t.updated_at = nowISO;
          t.updated_by = user.id;
          if (req.computed_working_days <= 5) {
            t.status = 'approved';
            t.approved_at = nowISO;
            becameApproved = true;
          }
        });
      } else if (stage === 'awaiting_hr') {
        // Second-stage approval — HR/MD only.
        if (!canApproveOrg)
          return err(403, 'forbidden', 'Only HR or MD can complete this approval.');
        db.write((d) => {
          const t = d.leaveRequests.find((r) => r.id === id)!;
          t.hr_approver_id = user.id;
          t.status = 'approved';
          t.approved_at = nowISO;
          t.updated_at = nowISO;
          t.updated_by = user.id;
        });
        becameApproved = true;
      }

      if (becameApproved) {
        // Deduct balance (skip LOP — unlimited).
        const type = findType(req.leave_type_id)!;
        if (type.code !== 'lop') {
          db.write((d) => {
            const b = d.leaveBalances.find(
              (x) => x.employee_id === req.employee_id && x.leave_type_id === req.leave_type_id,
            );
            if (b) {
              b.availed += req.computed_working_days;
              b.updated_at = nowISO;
            }
          });
        }
        // Upsert On Leave attendance rows across range.
        upsertOnLeaveRows(req.employee_id, req.start_date, req.end_date, user.id);
      }

      audit({
        actor_user_id: user.id,
        action: becameApproved ? 'leave.approved' : 'leave.manager_approved',
        entity_type: 'LeaveRequest',
        entity_id: id,
        before_json: { status: req.status, approver_id: req.approver_id },
        after_json: { becameApproved, stage },
        request,
      });

      // Notify requester on final approval; also notify HR when escalating.
      const requesterUser = db
        .read()
        .users.find((u) => u.employee_id === req.employee_id);
      if (becameApproved && requesterUser) {
        const type = findType(req.leave_type_id);
        notify(requesterUser.id, {
          type: 'leave.approved',
          title: 'Leave approved',
          body: `Your ${type?.name ?? 'leave'} for ${req.start_date} to ${req.end_date} was approved.`,
          entity_id: id,
          action_url: '/hrms/leave',
        });
      } else if (stage === 'awaiting_manager') {
        // Escalate to HR — notify all HR admins.
        const hrUsers = db.read().users.filter((u) => {
          const r = db.read().roles.find((x) => x.id === u.role_id);
          return r?.code === 'hr_admin';
        });
        for (const hr of hrUsers) {
          notify(hr.id, {
            type: 'leave.escalated',
            title: 'Leave awaiting HR approval',
            body: `${target.full_name} — ${req.computed_working_days.toFixed(1)} day(s), manager approved.`,
            entity_id: id,
            action_url: '/hrms/leave',
          });
        }
      }

      const fresh = db.read().leaveRequests.find((r) => r.id === id)!;
      return ok({
        request: { ...fresh, type: findType(fresh.leave_type_id), stage: derivedApproverStage(fresh) },
      });
    }),
  ),

  // POST /api/leaves/:id/reject
  http.post(
    '/api/leaves/:id/reject',
    withAuth(async ({ user, employee, params, request }) => {
      const id = String(params.id);
      const req = db.read().leaveRequests.find((r) => r.id === id);
      if (!req) return err(404, 'not_found', 'Leave request not found.');
      if (req.status !== 'pending')
        return err(409, 'not_pending', 'This request is no longer pending.');

      const body = (await request.json().catch(() => ({}))) as { reason?: string };
      const reason = body.reason?.trim() ?? '';
      if (!reason) return err(400, 'validation', 'A reason for rejection is required.');

      const role = roleOf(user.id)!;
      const canApproveDept = hasPermission(role, 'leave.approve', 'department');
      const canApproveOrg = hasPermission(role, 'leave.approve', 'organisation');
      const target = findEmp(req.employee_id);
      const stage = derivedApproverStage(req);
      const isManager = target?.manager_id === employee?.id;
      const permitted =
        canApproveOrg ||
        (stage === 'awaiting_manager' && canApproveDept && isManager);
      if (!permitted) return err(403, 'forbidden', 'Access denied.');

      const nowISO = new Date().toISOString();
      db.write((d) => {
        const t = d.leaveRequests.find((r) => r.id === id)!;
        t.status = 'rejected';
        t.rejection_reason = reason;
        t.updated_at = nowISO;
        t.updated_by = user.id;
      });

      audit({
        actor_user_id: user.id,
        action: 'leave.rejected',
        entity_type: 'LeaveRequest',
        entity_id: id,
        after_json: { reason },
        request,
      });

      const requesterUser = db
        .read()
        .users.find((u) => u.employee_id === req.employee_id);
      if (requesterUser) {
        notify(requesterUser.id, {
          type: 'leave.rejected',
          title: 'Leave rejected',
          body: `Your leave for ${req.start_date} to ${req.end_date} was rejected: ${reason}`,
          entity_id: id,
          action_url: '/hrms/leave',
        });
      }

      const fresh = db.read().leaveRequests.find((r) => r.id === id)!;
      return ok({ request: { ...fresh, type: findType(fresh.leave_type_id) } });
    }),
  ),

  // POST /api/leaves/:id/cancel
  http.post(
    '/api/leaves/:id/cancel',
    withAuth(async ({ user, employee, params, request }) => {
      const id = String(params.id);
      const req = db.read().leaveRequests.find((r) => r.id === id);
      if (!req) return err(404, 'not_found', 'Leave request not found.');
      if (!employee || req.employee_id !== employee.id) {
        return err(403, 'forbidden', 'Only the requester can cancel a leave.');
      }
      if (req.status === 'cancelled' || req.status === 'rejected')
        return err(409, 'already_terminal', 'This request is already closed.');

      const today = istToday();
      if (req.status === 'approved' && req.start_date <= today) {
        return err(422, 'past_leave', 'An approved leave that has started cannot be cancelled.');
      }

      const nowISO = new Date().toISOString();
      const wasApproved = req.status === 'approved';

      db.write((d) => {
        const t = d.leaveRequests.find((r) => r.id === id)!;
        t.status = 'cancelled';
        t.updated_at = nowISO;
        t.updated_by = user.id;
      });

      if (wasApproved) {
        // Restore balance + remove On Leave attendance rows in range.
        const type = findType(req.leave_type_id)!;
        if (type.code !== 'lop') {
          db.write((d) => {
            const b = d.leaveBalances.find(
              (x) => x.employee_id === req.employee_id && x.leave_type_id === req.leave_type_id,
            );
            if (b) {
              b.availed = Math.max(0, b.availed - req.computed_working_days);
              b.updated_at = nowISO;
            }
          });
        }
        removeOnLeaveRows(req.employee_id, req.start_date, req.end_date);
      }

      audit({
        actor_user_id: user.id,
        action: 'leave.cancelled',
        entity_type: 'LeaveRequest',
        entity_id: id,
        before_json: { status: req.status },
        after_json: { wasApproved, restored: wasApproved },
        request,
      });

      const fresh = db.read().leaveRequests.find((r) => r.id === id)!;
      return ok({ request: { ...fresh, type: findType(fresh.leave_type_id) } });
    }),
  ),
];
