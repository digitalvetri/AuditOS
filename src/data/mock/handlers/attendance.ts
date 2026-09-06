/**
 * Attendance handlers per §9. All server-side authorization: never trust the
 * client's `verified`, geofence, or scope.
 *
 * Endpoints:
 *   POST /api/attendance/check-in
 *   POST /api/attendance/check-out
 *   GET  /api/attendance/today
 *   GET  /api/attendance?from&to&employeeId&departmentId&status&locationType
 *   GET  /api/attendance/:employeeId
 *   POST /api/attendance/corrections
 *   GET  /api/attendance/corrections
 *   POST /api/attendance/corrections/:id/approve | /reject
 */

import { http } from 'msw';
import type {
  Attendance,
  AttendanceCorrection,
  AttendanceStatus,
  LocationType,
  RoleCode,
} from '@/data/models';
import { db } from '../db';
import { audit, err, ok, withAuth } from '../middleware';
import { haversineMeters } from '@/lib/geo';
import { rateLimit } from '@/lib/rateLimit';
import { istDateOf, istToday, daysBetween } from '@/lib/dates';
import {
  computeCheckInStatus,
  computeCheckOutStatus,
} from '@/lib/attendanceStatus';
import { hasPermission, scopeSatisfies, type Scope } from '@/platform/rbac/matrix';

// ── Helpers ───────────────────────────────────────────────────────────────

function roleOf(userId: string): RoleCode | null {
  const u = db.read().users.find((x) => x.id === userId);
  if (!u) return null;
  const r = db.read().roles.find((x) => x.id === u.role_id);
  return r?.code ?? null;
}

function requesterScope(role: RoleCode): Scope {
  // Where the caller can view attendance.
  if (hasPermission(role, 'attendance.manage', 'organisation')) return 'organisation';
  if (hasPermission(role, 'attendance.read', 'organisation')) return 'organisation';
  if (hasPermission(role, 'attendance.read', 'department')) return 'department';
  return 'self';
}

function stripCoords(row: Attendance): Attendance {
  // Coordinates are personal data (§10). Peer viewing (dept scope) never
  // sees them — HR/MD (organisation scope) do.
  return {
    ...row,
    check_in_lat: null,
    check_in_long: null,
    check_in_accuracy_m: null,
    check_out_lat: null,
    check_out_long: null,
    check_out_accuracy_m: null,
  };
}

function verifyGeofence(
  lat: number,
  lon: number,
  accuracyM: number,
): { ok: true; locationId: string; name: string } | { ok: false; reason: string } {
  if (accuracyM > 100) {
    return { ok: false, reason: 'GPS accuracy is poor. Move to an open area and retry.' };
  }
  const active = db.read().workLocations.filter((l) => l.is_active);
  for (const l of active) {
    const d = haversineMeters(lat, lon, l.latitude, l.longitude);
    if (d <= l.radius_m) return { ok: true, locationId: l.id, name: l.name };
  }
  return { ok: false, reason: 'You are not within any office geofence.' };
}

function notify(
  userId: string,
  n: {
    type: string;
    module: 'attendance';
    title: string;
    body: string;
    entity_type?: string | null;
    entity_id?: string | null;
    action_url?: string | null;
  },
): void {
  db.write((d) => {
    d.notifications.push({
      id: `ntf-${crypto.randomUUID()}`,
      user_id: userId,
      type: n.type,
      module: n.module,
      entity_type: n.entity_type ?? null,
      entity_id: n.entity_id ?? null,
      title: n.title,
      body: n.body,
      action_url: n.action_url ?? null,
      is_read: false,
      created_at: new Date().toISOString(),
    });
  });
}

interface CheckInBody {
  latitude?: number;
  longitude?: number;
  accuracy_m?: number;
  location_type?: LocationType;
  off_site_reason?: string;
  /** Client MUST NOT set — if present, ignored and audited (§8.2 last line). */
  verified?: boolean;
}

// ── Handlers ──────────────────────────────────────────────────────────────

export const attendanceHandlers = [
  // POST /api/attendance/check-in
  http.post(
    '/api/attendance/check-in',
    withAuth(async ({ user, employee, request }) => {
      if (!employee) return err(422, 'no_employee', 'This account has no employee record.');
      // Deactivation guard: a stale cookie belonging to an inactive employee
      // must not be able to check in (§8.1 deactivation contract).
      if (employee.deleted_at || employee.status === 'inactive') {
        return err(403, 'inactive', 'This employee account is inactive.');
      }
      if (!rateLimit(`checkin:${user.id}`, 10, 60_000)) {
        return err(429, 'rate_limited', 'Too many attempts. Try again shortly.');
      }

      const body = (await request.json().catch(() => ({}))) as CheckInBody;

      // §8.2 — reject and audit any client-side "verified" claim.
      if (body.verified !== undefined) {
        audit({
          actor_user_id: user.id,
          action: 'attendance.client_forgery_attempt',
          entity_type: 'Attendance',
          entity_id: employee.id,
          before_json: null,
          after_json: { forged_field: 'verified', value: body.verified },
          request,
        });
      }

      const { latitude, longitude, accuracy_m, location_type, off_site_reason } = body;
      if (
        typeof latitude !== 'number' ||
        typeof longitude !== 'number' ||
        typeof accuracy_m !== 'number'
      ) {
        return err(400, 'validation', 'latitude, longitude and accuracy_m are required numbers.');
      }
      const locType: LocationType = location_type ?? 'office';
      if ((locType === 'client_site' || locType === 'field') && !off_site_reason?.trim()) {
        return err(422, 'reason_required', 'Off-site check-in requires a reason.');
      }

      const today = istToday();
      const existing = db.read().attendance.find(
        (a) => a.employee_id === employee.id && a.date === today && a.check_in_at !== null,
      );
      if (existing) {
        return err(409, 'already_checked_in', 'You are already checked in today.', {
          check_in_at: existing.check_in_at,
        });
      }

      // Geofence. Off-site types bypass but still capture coords.
      let locationId: string | null = null;
      let locationName: string | null = null;
      if (locType === 'office') {
        const geo = verifyGeofence(latitude, longitude, accuracy_m);
        if (!geo.ok) return err(422, 'geofence', geo.reason);
        locationId = geo.locationId;
        locationName = geo.name;
      } else {
        // Off-site — still run Haversine so we know if the person happens to be at HQ.
        const geo = verifyGeofence(latitude, longitude, accuracy_m);
        if (geo.ok) {
          locationId = geo.locationId;
          locationName = geo.name;
        }
      }

      const nowISO = new Date().toISOString();
      const row: Attendance = {
        id: `att-${employee.id}-${today}`,
        employee_id: employee.id,
        date: today,
        check_in_at: nowISO,
        check_out_at: null,
        check_in_lat: latitude,
        check_in_long: longitude,
        check_in_accuracy_m: accuracy_m,
        check_out_lat: null,
        check_out_long: null,
        check_out_accuracy_m: null,
        check_in_location_id: locationId,
        check_out_location_id: null,
        location_type: locType,
        off_site_reason: off_site_reason?.trim() ?? null,
        worked_minutes: null,
        break_minutes: null,
        status: computeCheckInStatus(nowISO),
        source: 'web_geo',
        correction_status: 'none',
        device: null,
        ip: null,
        client_id: null,
        created_at: nowISO,
        updated_at: nowISO,
        created_by: user.id,
        updated_by: user.id,
        deleted_at: null,
      };

      // If a "same day" row already exists but without check-in (seed edge / correction),
      // replace it. Otherwise the (employee_id, date) uniqueness would collide.
      db.write((d) => {
        const idx = d.attendance.findIndex(
          (a) => a.employee_id === employee.id && a.date === today,
        );
        if (idx >= 0) d.attendance[idx] = row;
        else d.attendance.push(row);
      });

      audit({
        actor_user_id: user.id,
        action: locType === 'office' ? 'attendance.check_in' : 'attendance.check_in.off_site',
        entity_type: 'Attendance',
        entity_id: row.id,
        after_json: {
          date: row.date,
          check_in_at: row.check_in_at,
          location_type: row.location_type,
          location_id: row.check_in_location_id,
        },
        request,
      });

      notify(user.id, {
        type: 'attendance.checked_in',
        module: 'attendance',
        title: 'Checked in',
        body:
          locType === 'office'
            ? `${locationName ?? 'Office'} — location verified`
            : `Off-site (${locType}) — flagged for review`,
        entity_type: 'Attendance',
        entity_id: row.id,
        action_url: '/hrms/attendance',
      });

      return ok({
        attendance: row,
        location: { id: locationId, name: locationName },
      });
    }),
  ),

  // POST /api/attendance/check-out
  http.post(
    '/api/attendance/check-out',
    withAuth(async ({ user, employee, request }) => {
      if (!employee) return err(422, 'no_employee', 'This account has no employee record.');
      if (!rateLimit(`checkout:${user.id}`, 10, 60_000)) {
        return err(429, 'rate_limited', 'Too many attempts. Try again shortly.');
      }
      const body = (await request.json().catch(() => ({}))) as CheckInBody;
      const { latitude, longitude, accuracy_m } = body;
      if (
        typeof latitude !== 'number' ||
        typeof longitude !== 'number' ||
        typeof accuracy_m !== 'number'
      ) {
        return err(400, 'validation', 'latitude, longitude and accuracy_m are required numbers.');
      }

      const today = istToday();
      const row = db.read().attendance.find(
        (a) => a.employee_id === employee.id && a.date === today && a.check_in_at !== null,
      );
      if (!row) {
        return err(422, 'no_open_session', 'No open check-in for today.');
      }
      if (row.check_out_at) {
        return err(409, 'already_checked_out', 'You have already checked out today.', {
          check_out_at: row.check_out_at,
        });
      }

      const nowISO = new Date().toISOString();
      const { status, workedMinutes, breakMinutes } = computeCheckOutStatus(
        row.check_in_at!,
        nowISO,
      );

      // Attempt to identify the check-out location; not required for check-out to succeed.
      let checkOutLocationId: string | null = null;
      const geo = verifyGeofence(latitude, longitude, accuracy_m);
      if (geo.ok) checkOutLocationId = geo.locationId;

      db.write((d) => {
        const target = d.attendance.find((a) => a.id === row.id);
        if (!target) return;
        target.check_out_at = nowISO;
        target.check_out_lat = latitude;
        target.check_out_long = longitude;
        target.check_out_accuracy_m = accuracy_m;
        target.check_out_location_id = checkOutLocationId;
        target.worked_minutes = workedMinutes;
        target.break_minutes = breakMinutes;
        // WFH status stays WFH; otherwise use computed status.
        target.status = row.status === 'wfh' ? 'wfh' : (status as AttendanceStatus);
        target.updated_at = nowISO;
        target.updated_by = user.id;
      });

      audit({
        actor_user_id: user.id,
        action: 'attendance.check_out',
        entity_type: 'Attendance',
        entity_id: row.id,
        before_json: { check_out_at: null, worked_minutes: null },
        after_json: { check_out_at: nowISO, worked_minutes: workedMinutes, status },
        request,
      });

      const updated = db.read().attendance.find((a) => a.id === row.id)!;
      return ok({ attendance: updated });
    }),
  ),

  // GET /api/attendance/today  — caller's own today row (or the KPI counts for HR/MD)
  http.get(
    '/api/attendance/today',
    withAuth(async ({ user, employee }) => {
      const today = istToday();
      const role = roleOf(user.id)!;
      const scope = requesterScope(role);

      const mine = employee
        ? db.read().attendance.find((a) => a.employee_id === employee.id && a.date === today) ??
          null
        : null;

      let counts: {
        total: number;
        present: number;
        late: number;
        absent: number;
        wfh: number;
        on_leave: number;
        missing_check_in: number;
        missing_check_out: number;
      } | null = null;

      if (scope === 'organisation' || scope === 'department') {
        const eligibleEmp = db
          .read()
          .employees.filter((e) => e.status === 'active' && !e.deleted_at)
          .filter((e) =>
            scope === 'organisation' ? true : employee ? e.department_id === employee.department_id : false,
          );
        const rowsToday = db
          .read()
          .attendance.filter((a) => a.date === today)
          .filter((a) => eligibleEmp.some((e) => e.id === a.employee_id));
        counts = {
          total: eligibleEmp.length,
          present: rowsToday.filter((r) => r.status === 'present').length,
          late: rowsToday.filter((r) => r.status === 'late').length,
          absent: eligibleEmp.length - rowsToday.filter((r) => r.check_in_at).length,
          wfh: rowsToday.filter((r) => r.status === 'wfh').length,
          on_leave: rowsToday.filter((r) => r.status === 'on_leave').length,
          missing_check_in: rowsToday.filter((r) => r.status === 'missing_check_in').length,
          missing_check_out: rowsToday.filter((r) => r.status === 'missing_check_out').length,
        };
      }

      return ok({ today: mine, counts, scope });
    }),
  ),

  // GET /api/attendance?from&to&employeeId&departmentId&status&locationType
  http.get(
    '/api/attendance',
    withAuth(async ({ user, employee, request }) => {
      const url = new URL(request.url);
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const employeeId = url.searchParams.get('employeeId');
      const departmentId = url.searchParams.get('departmentId');
      const status = url.searchParams.get('status');
      const locationType = url.searchParams.get('locationType');

      const role = roleOf(user.id)!;
      const scope = requesterScope(role);

      const allEmployees = db.read().employees;
      const inScope = (empId: string): boolean => {
        const target = allEmployees.find((e) => e.id === empId);
        if (!target) return false;
        if (scope === 'organisation') return true;
        if (scope === 'department')
          return employee ? target.department_id === employee.department_id : false;
        return employee ? empId === employee.id : false;
      };

      let rows = db.read().attendance.filter((a) => inScope(a.employee_id));
      if (from) rows = rows.filter((a) => a.date >= from);
      if (to) rows = rows.filter((a) => a.date <= to);
      if (employeeId) {
        if (!inScope(employeeId)) return err(403, 'forbidden', 'Access denied.');
        rows = rows.filter((a) => a.employee_id === employeeId);
      }
      if (departmentId) {
        const empsInDept = allEmployees.filter((e) => e.department_id === departmentId);
        rows = rows.filter((a) => empsInDept.some((e) => e.id === a.employee_id));
      }
      if (status) rows = rows.filter((a) => a.status === status);
      if (locationType) rows = rows.filter((a) => a.location_type === locationType);

      // Newest first for the UI table.
      rows.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));

      // Personal data projection — dept scope hides peer coordinates.
      const projected =
        scope === 'department'
          ? rows.map((r) => (employee && r.employee_id === employee.id ? r : stripCoords(r)))
          : rows;

      // Include employee display fields joined in for the table.
      const withEmp = projected.map((r) => {
        const e = allEmployees.find((x) => x.id === r.employee_id);
        return {
          ...r,
          employee: e
            ? { id: e.id, full_name: e.full_name, employee_code: e.employee_code, department_id: e.department_id }
            : null,
        };
      });

      return ok({ items: withEmp, count: withEmp.length, scope });
    }),
  ),

  // NOTE: §9 lists GET /api/attendance/:employeeId as a variant. It's dropped
  // here because `/api/attendance?employeeId=...` (above) already returns the
  // same result, and the parametric shape collides with `/corrections`. If a
  // client needs the parametric form later, expose it under
  // `/api/attendance/by-employee/:employeeId` to avoid the collision.

  // ── Corrections ─────────────────────────────────────────────────────────

  // POST /api/attendance/corrections
  http.post(
    '/api/attendance/corrections',
    withAuth(async ({ user, employee, request }) => {
      if (!employee)
        return err(422, 'no_employee', 'This account has no employee record.');
      const body = (await request.json().catch(() => ({}))) as {
        date?: string;
        requested_check_in_at?: string;
        requested_check_out_at?: string;
        reason?: string;
      };
      const { date, requested_check_in_at, requested_check_out_at, reason } = body;
      if (!date || !reason?.trim()) {
        return err(400, 'validation', 'date and reason are required.');
      }
      if (!requested_check_in_at && !requested_check_out_at) {
        return err(400, 'validation', 'At least one requested time is required.');
      }

      const today = istToday();
      if (date > today) return err(422, 'future_date', 'Cannot correct a future date.');
      const daysBack = daysBetween(date, today);
      if (daysBack > 7)
        return err(422, 'window_expired', 'Corrections are limited to the last 7 days.');

      const existingAttendance = db
        .read()
        .attendance.find((a) => a.employee_id === employee.id && a.date === date);

      const nowISO = new Date().toISOString();
      const row: AttendanceCorrection = {
        id: `corr-${crypto.randomUUID()}`,
        attendance_id: existingAttendance?.id ?? null,
        employee_id: employee.id,
        date,
        requested_check_in_at: requested_check_in_at ?? null,
        requested_check_out_at: requested_check_out_at ?? null,
        reason: reason.trim(),
        attachment_url: null,
        status: 'pending',
        reviewed_by: null,
        reviewed_at: null,
        review_notes: null,
        created_at: nowISO,
        updated_at: nowISO,
        created_by: user.id,
        updated_by: user.id,
        deleted_at: null,
      };

      db.write((d) => {
        d.corrections.push(row);
        if (existingAttendance) {
          const t = d.attendance.find((a) => a.id === existingAttendance.id);
          if (t) t.correction_status = 'requested';
        }
      });

      audit({
        actor_user_id: user.id,
        action: 'attendance.correction.requested',
        entity_type: 'AttendanceCorrection',
        entity_id: row.id,
        after_json: { date, requested_check_in_at, requested_check_out_at },
        request,
      });

      // Notify reporting manager if present; else HR admins.
      const managerId = employee.manager_id;
      const manager = managerId
        ? db.read().employees.find((e) => e.id === managerId)
        : null;
      const managerUser = manager
        ? db.read().users.find((u) => u.employee_id === manager.id)
        : null;
      if (managerUser) {
        notify(managerUser.id, {
          type: 'attendance.correction.pending',
          module: 'attendance',
          title: 'Attendance correction to review',
          body: `${employee.full_name} requested a correction for ${date}.`,
          entity_type: 'AttendanceCorrection',
          entity_id: row.id,
          action_url: '/hrms/attendance',
        });
      }

      return ok({ correction: row });
    }),
  ),

  // GET /api/attendance/corrections
  http.get(
    '/api/attendance/corrections',
    withAuth(async ({ user, employee, request }) => {
      const url = new URL(request.url);
      const status = url.searchParams.get('status'); // optional
      const role = roleOf(user.id)!;
      const canApproveDept = hasPermission(role, 'attendance.correct.approve', 'department');
      const canApproveOrg = hasPermission(role, 'attendance.correct.approve', 'organisation');

      let rows = db.read().corrections;
      if (canApproveOrg) {
        // all
      } else if (canApproveDept && employee) {
        const deptEmps = db
          .read()
          .employees.filter((e) => e.department_id === employee.department_id)
          .map((e) => e.id);
        rows = rows.filter((c) => deptEmps.includes(c.employee_id));
      } else if (employee) {
        rows = rows.filter((c) => c.employee_id === employee.id);
      } else {
        rows = [];
      }
      if (status) rows = rows.filter((c) => c.status === status);
      rows = [...rows].sort((a, b) => (a.created_at > b.created_at ? -1 : 1));

      const withEmp = rows.map((r) => {
        const e = db.read().employees.find((x) => x.id === r.employee_id);
        return {
          ...r,
          employee: e ? { id: e.id, full_name: e.full_name, employee_code: e.employee_code } : null,
        };
      });
      return ok({ items: withEmp, count: withEmp.length });
    }),
  ),

  // POST /api/attendance/corrections/:id/approve
  http.post(
    '/api/attendance/corrections/:id/approve',
    withAuth(async ({ user, employee, params, request }) => {
      const cid = String(params.id);
      const role = roleOf(user.id)!;
      const canApprove =
        hasPermission(role, 'attendance.correct.approve', 'department') ||
        hasPermission(role, 'attendance.correct.approve', 'organisation');
      if (!canApprove) return err(403, 'forbidden', 'Access denied.');

      const corr = db.read().corrections.find((c) => c.id === cid);
      if (!corr) return err(404, 'not_found', 'Correction not found.');
      if (corr.status !== 'pending')
        return err(409, 'already_reviewed', 'This correction has already been reviewed.');

      const targetEmp = db.read().employees.find((e) => e.id === corr.employee_id);
      const orgWide = hasPermission(role, 'attendance.correct.approve', 'organisation');
      if (!orgWide) {
        if (!employee || !targetEmp || targetEmp.department_id !== employee.department_id) {
          return err(403, 'forbidden', 'Access denied.');
        }
      }

      const nowISO = new Date().toISOString();
      let beforeSnapshot: Attendance | null = null;
      let afterSnapshot: Attendance | null = null;

      db.write((d) => {
        const target = d.corrections.find((c) => c.id === cid)!;
        target.status = 'approved';
        target.reviewed_by = user.id;
        target.reviewed_at = nowISO;

        const att = corr.attendance_id
          ? d.attendance.find((a) => a.id === corr.attendance_id)
          : d.attendance.find(
              (a) => a.employee_id === corr.employee_id && a.date === corr.date,
            );

        if (att) {
          beforeSnapshot = { ...att };
          if (corr.requested_check_in_at) att.check_in_at = corr.requested_check_in_at;
          if (corr.requested_check_out_at) att.check_out_at = corr.requested_check_out_at;
          att.correction_status = 'approved';
          if (att.check_in_at && att.check_out_at) {
            const { status, workedMinutes, breakMinutes } = computeCheckOutStatus(
              att.check_in_at,
              att.check_out_at,
            );
            att.status = att.status === 'wfh' ? 'wfh' : status;
            att.worked_minutes = workedMinutes;
            att.break_minutes = breakMinutes;
          } else if (att.check_in_at) {
            att.status = computeCheckInStatus(att.check_in_at);
          }
          att.updated_at = nowISO;
          att.updated_by = user.id;
          afterSnapshot = { ...att };
        } else if (targetEmp) {
          // Correction created a new day.
          const dateISO = corr.date;
          const check_in_at = corr.requested_check_in_at ?? null;
          const check_out_at = corr.requested_check_out_at ?? null;
          const status: AttendanceStatus = check_in_at && check_out_at
            ? computeCheckOutStatus(check_in_at, check_out_at).status
            : check_in_at
              ? computeCheckInStatus(check_in_at)
              : 'absent';
          const workedInfo = check_in_at && check_out_at
            ? computeCheckOutStatus(check_in_at, check_out_at)
            : { workedMinutes: null, breakMinutes: null };
          const newAtt: Attendance = {
            id: `att-${targetEmp.id}-${dateISO}`,
            employee_id: targetEmp.id,
            date: dateISO,
            check_in_at,
            check_out_at,
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
            worked_minutes: workedInfo.workedMinutes ?? null,
            break_minutes: workedInfo.breakMinutes ?? null,
            status,
            source: 'manual',
            correction_status: 'approved',
            device: null,
            ip: null,
            client_id: null,
            created_at: nowISO,
            updated_at: nowISO,
            created_by: user.id,
            updated_by: user.id,
            deleted_at: null,
          };
          d.attendance.push(newAtt);
          afterSnapshot = { ...newAtt };
        }
      });

      audit({
        actor_user_id: user.id,
        action: 'attendance.correction.approved',
        entity_type: 'AttendanceCorrection',
        entity_id: cid,
        before_json: beforeSnapshot,
        after_json: afterSnapshot,
        request,
      });

      // Notify the requester.
      const requesterUser = db
        .read()
        .users.find((u) => u.employee_id === corr.employee_id);
      if (requesterUser) {
        notify(requesterUser.id, {
          type: 'attendance.correction.approved',
          module: 'attendance',
          title: 'Attendance correction approved',
          body: `Your correction for ${corr.date} was approved.`,
          entity_type: 'AttendanceCorrection',
          entity_id: cid,
          action_url: '/hrms/attendance',
        });
      }

      const fresh = db.read().corrections.find((c) => c.id === cid)!;
      return ok({ correction: fresh });
    }),
  ),

  // POST /api/attendance/corrections/:id/reject
  http.post(
    '/api/attendance/corrections/:id/reject',
    withAuth(async ({ user, employee, params, request }) => {
      const cid = String(params.id);
      const role = roleOf(user.id)!;
      const canApprove =
        hasPermission(role, 'attendance.correct.approve', 'department') ||
        hasPermission(role, 'attendance.correct.approve', 'organisation');
      if (!canApprove) return err(403, 'forbidden', 'Access denied.');

      const body = (await request.json().catch(() => ({}))) as { notes?: string };
      const notes = body.notes?.trim() ?? '';
      if (!notes) return err(400, 'validation', 'A reason for rejection is required.');

      const corr = db.read().corrections.find((c) => c.id === cid);
      if (!corr) return err(404, 'not_found', 'Correction not found.');
      if (corr.status !== 'pending')
        return err(409, 'already_reviewed', 'This correction has already been reviewed.');

      const targetEmp = db.read().employees.find((e) => e.id === corr.employee_id);
      const orgWide = hasPermission(role, 'attendance.correct.approve', 'organisation');
      if (!orgWide) {
        if (!employee || !targetEmp || targetEmp.department_id !== employee.department_id) {
          return err(403, 'forbidden', 'Access denied.');
        }
      }

      const nowISO = new Date().toISOString();
      db.write((d) => {
        const target = d.corrections.find((c) => c.id === cid)!;
        target.status = 'rejected';
        target.reviewed_by = user.id;
        target.reviewed_at = nowISO;
        target.review_notes = notes;
        if (target.attendance_id) {
          const att = d.attendance.find((a) => a.id === target.attendance_id);
          if (att) att.correction_status = 'rejected';
        }
      });

      audit({
        actor_user_id: user.id,
        action: 'attendance.correction.rejected',
        entity_type: 'AttendanceCorrection',
        entity_id: cid,
        after_json: { notes },
        request,
      });

      const requesterUser = db
        .read()
        .users.find((u) => u.employee_id === corr.employee_id);
      if (requesterUser) {
        notify(requesterUser.id, {
          type: 'attendance.correction.rejected',
          module: 'attendance',
          title: 'Attendance correction rejected',
          body: `Your correction for ${corr.date} was rejected: ${notes}`,
          entity_type: 'AttendanceCorrection',
          entity_id: cid,
          action_url: '/hrms/attendance',
        });
      }
      const fresh = db.read().corrections.find((c) => c.id === cid)!;
      return ok({ correction: fresh });
    }),
  ),
];

// Silence unused import warning if scopeSatisfies isn't reached directly.
void scopeSatisfies;
void istDateOf;
