/**
 * Settings handlers per §8.11. Part 1 owns all configuration.
 *
 *   GET  /api/settings/work-schedules/mine  — caller's schedule (any role)
 *   GET  /api/settings/work-schedules       — list (any role — used by Leave preview)
 *
 * Everything below requires `settings.manage` at organisation scope
 * (HR Admin + MD). Employee / Dept Manager / Finance → 403.
 *
 *   Departments        CRUD
 *   Designations       CRUD
 *   Work Locations     CRUD
 *   Holidays           CRUD
 *   Leave Types        list + PATCH (never delete — referenced by history)
 *   Expense Categories CRUD
 *   Statutory Rates    list + POST supersede (append-only; never delete)
 *   Roles              list (edit is out of scope this phase)
 *   Permissions matrix list (read-only)
 *
 * §10 rule: statutory rates are DATA. When a rate changes, POST a new row
 * with a fresh `effective_from`; the handler stamps `effective_to` on the
 * prior current row so history stays intact.
 */

import { http } from 'msw';
import { db } from '../db';
import { audit, err, ok, withAuth } from '../middleware';
import type {
  Department,
  Designation,
  ExpenseCategory,
  Holiday,
  LeaveType,
  RoleCode,
  StatutoryRate,
  WorkLocation,
} from '@/data/models';
import { hasPermission } from '@/platform/rbac/matrix';
import { MATRIX } from '@/platform/rbac/matrix';

function roleOf(userId: string): RoleCode | null {
  const u = db.read().users.find((x) => x.id === userId);
  if (!u) return null;
  return db.read().roles.find((x) => x.id === u.role_id)?.code ?? null;
}

function requireManage(userId: string): boolean {
  const role = roleOf(userId);
  if (!role) return false;
  return hasPermission(role, 'settings.manage', 'organisation');
}

// Small audit trail helper — settings changes are always org-wide.
function auditChange(
  userId: string,
  action: string,
  entity_type: string,
  entity_id: string,
  before: unknown,
  after: unknown,
  request: Request,
) {
  audit({
    actor_user_id: userId,
    action,
    entity_type,
    entity_id,
    before_json: before,
    after_json: after,
    request,
  });
}

const nowISO = () => new Date().toISOString();

// ── Work schedules (existing endpoints kept) ─────────────────────────────
const workScheduleHandlers = [
  http.get(
    '/api/settings/work-schedules/mine',
    withAuth(async ({ employee }) => {
      if (!employee) return err(422, 'no_employee', 'No employee record for this account.');
      const schedule = db.read().workSchedules.find((s) => s.id === employee.work_schedule_id);
      if (!schedule) return err(404, 'not_found', 'Work schedule not found.');
      return ok({ schedule });
    }),
  ),
  http.get('/api/settings/work-schedules', withAuth(async () => ok({ items: db.read().workSchedules }))),
];

// ── Departments ───────────────────────────────────────────────────────────
const departmentHandlers = [
  http.get('/api/settings/departments', withAuth(async () => ok({ items: db.read().departments }))),

  http.post(
    '/api/settings/departments',
    withAuth(async ({ user, request }) => {
      if (!requireManage(user.id)) return err(403, 'forbidden', 'Access denied.');
      const body = (await request.json().catch(() => ({}))) as Partial<Department>;
      if (!body.name?.trim() || !body.code?.trim())
        return err(400, 'validation', 'name and code are required.');
      const row: Department = {
        id: `dep-${crypto.randomUUID()}`,
        organisation_id: db.read().organisation.id,
        name: body.name.trim(),
        code: body.code.trim().toUpperCase(),
        created_at: nowISO(),
        updated_at: nowISO(),
        created_by: user.id,
        updated_by: user.id,
        deleted_at: null,
      };
      db.write((d) => d.departments.push(row));
      auditChange(user.id, 'department.created', 'Department', row.id, null, row, request);
      return ok({ department: row });
    }),
  ),

  http.patch(
    '/api/settings/departments/:id',
    withAuth(async ({ user, params, request }) => {
      if (!requireManage(user.id)) return err(403, 'forbidden', 'Access denied.');
      const id = String(params.id);
      const target = db.read().departments.find((d) => d.id === id);
      if (!target) return err(404, 'not_found', 'Department not found.');
      const body = (await request.json().catch(() => ({}))) as Partial<Department>;
      const before = { ...target };
      db.write((d) => {
        const t = d.departments.find((x) => x.id === id)!;
        if (body.name?.trim()) t.name = body.name.trim();
        if (body.code?.trim()) t.code = body.code.trim().toUpperCase();
        t.updated_at = nowISO();
        t.updated_by = user.id;
      });
      auditChange(user.id, 'department.updated', 'Department', id, before, db.read().departments.find((d) => d.id === id), request);
      return ok({ department: db.read().departments.find((d) => d.id === id) });
    }),
  ),

  http.delete(
    '/api/settings/departments/:id',
    withAuth(async ({ user, params, request }) => {
      if (!requireManage(user.id)) return err(403, 'forbidden', 'Access denied.');
      const id = String(params.id);
      const target = db.read().departments.find((d) => d.id === id);
      if (!target) return err(404, 'not_found', 'Department not found.');
      // Guard: cannot delete a department that still has employees.
      const used = db.read().employees.some((e) => e.department_id === id && !e.deleted_at);
      if (used) return err(409, 'in_use', 'Department has employees; reassign first.');
      db.write((d) => {
        d.departments = d.departments.filter((x) => x.id !== id);
      });
      auditChange(user.id, 'department.deleted', 'Department', id, target, null, request);
      return ok({ ok: true });
    }),
  ),
];

// ── Designations ──────────────────────────────────────────────────────────
const designationHandlers = [
  http.get('/api/settings/designations', withAuth(async () => ok({ items: db.read().designations }))),

  http.post(
    '/api/settings/designations',
    withAuth(async ({ user, request }) => {
      if (!requireManage(user.id)) return err(403, 'forbidden', 'Access denied.');
      const body = (await request.json().catch(() => ({}))) as Partial<Designation>;
      if (!body.name?.trim()) return err(400, 'validation', 'name is required.');
      const row: Designation = {
        id: `des-${crypto.randomUUID()}`,
        organisation_id: db.read().organisation.id,
        name: body.name.trim(),
        created_at: nowISO(),
        updated_at: nowISO(),
        created_by: user.id,
        updated_by: user.id,
        deleted_at: null,
      };
      db.write((d) => d.designations.push(row));
      auditChange(user.id, 'designation.created', 'Designation', row.id, null, row, request);
      return ok({ designation: row });
    }),
  ),

  http.patch(
    '/api/settings/designations/:id',
    withAuth(async ({ user, params, request }) => {
      if (!requireManage(user.id)) return err(403, 'forbidden', 'Access denied.');
      const id = String(params.id);
      const target = db.read().designations.find((d) => d.id === id);
      if (!target) return err(404, 'not_found', 'Designation not found.');
      const body = (await request.json().catch(() => ({}))) as Partial<Designation>;
      const before = { ...target };
      db.write((d) => {
        const t = d.designations.find((x) => x.id === id)!;
        if (body.name?.trim()) t.name = body.name.trim();
        t.updated_at = nowISO();
        t.updated_by = user.id;
      });
      auditChange(user.id, 'designation.updated', 'Designation', id, before, db.read().designations.find((d) => d.id === id), request);
      return ok({ designation: db.read().designations.find((d) => d.id === id) });
    }),
  ),

  http.delete(
    '/api/settings/designations/:id',
    withAuth(async ({ user, params, request }) => {
      if (!requireManage(user.id)) return err(403, 'forbidden', 'Access denied.');
      const id = String(params.id);
      const target = db.read().designations.find((d) => d.id === id);
      if (!target) return err(404, 'not_found', 'Designation not found.');
      const used = db.read().employees.some((e) => e.designation_id === id && !e.deleted_at);
      if (used) return err(409, 'in_use', 'Designation is in use.');
      db.write((d) => {
        d.designations = d.designations.filter((x) => x.id !== id);
      });
      auditChange(user.id, 'designation.deleted', 'Designation', id, target, null, request);
      return ok({ ok: true });
    }),
  ),
];

// ── Work locations ────────────────────────────────────────────────────────
const workLocationCrud = [
  http.get('/api/settings/work-locations', withAuth(async () => ok({ items: db.read().workLocations }))),

  http.post(
    '/api/settings/work-locations',
    withAuth(async ({ user, request }) => {
      if (!requireManage(user.id)) return err(403, 'forbidden', 'Access denied.');
      const body = (await request.json().catch(() => ({}))) as Partial<WorkLocation>;
      if (!body.name?.trim() || typeof body.latitude !== 'number' || typeof body.longitude !== 'number') {
        return err(400, 'validation', 'name, latitude, longitude are required.');
      }
      const row: WorkLocation = {
        id: `wl-${crypto.randomUUID()}`,
        organisation_id: db.read().organisation.id,
        name: body.name.trim(),
        address: body.address ?? '',
        latitude: body.latitude,
        longitude: body.longitude,
        radius_m: body.radius_m ?? 150,
        is_active: body.is_active ?? true,
        created_at: nowISO(),
        updated_at: nowISO(),
        created_by: user.id,
        updated_by: user.id,
        deleted_at: null,
      };
      db.write((d) => d.workLocations.push(row));
      auditChange(user.id, 'work_location.created', 'WorkLocation', row.id, null, row, request);
      return ok({ workLocation: row });
    }),
  ),

  http.patch(
    '/api/settings/work-locations/:id',
    withAuth(async ({ user, params, request }) => {
      if (!requireManage(user.id)) return err(403, 'forbidden', 'Access denied.');
      const id = String(params.id);
      const target = db.read().workLocations.find((w) => w.id === id);
      if (!target) return err(404, 'not_found', 'Work location not found.');
      const body = (await request.json().catch(() => ({}))) as Partial<WorkLocation>;
      const before = { ...target };
      db.write((d) => {
        const t = d.workLocations.find((x) => x.id === id)!;
        if (body.name?.trim()) t.name = body.name.trim();
        if (typeof body.address === 'string') t.address = body.address;
        if (typeof body.latitude === 'number') t.latitude = body.latitude;
        if (typeof body.longitude === 'number') t.longitude = body.longitude;
        if (typeof body.radius_m === 'number') t.radius_m = body.radius_m;
        if (typeof body.is_active === 'boolean') t.is_active = body.is_active;
        t.updated_at = nowISO();
        t.updated_by = user.id;
      });
      auditChange(user.id, 'work_location.updated', 'WorkLocation', id, before, db.read().workLocations.find((w) => w.id === id), request);
      return ok({ workLocation: db.read().workLocations.find((w) => w.id === id) });
    }),
  ),
];

// ── Holidays ─────────────────────────────────────────────────────────────
const holidayHandlers = [
  http.get('/api/settings/holidays', withAuth(async () => ok({ items: db.read().holidays.slice().sort((a, b) => a.date.localeCompare(b.date)) }))),

  http.post(
    '/api/settings/holidays',
    withAuth(async ({ user, request }) => {
      if (!requireManage(user.id)) return err(403, 'forbidden', 'Access denied.');
      const body = (await request.json().catch(() => ({}))) as Partial<Holiday>;
      if (!body.date || !body.name?.trim()) return err(400, 'validation', 'date and name are required.');
      // Collision check: same date already exists.
      if (db.read().holidays.some((h) => h.date === body.date))
        return err(409, 'duplicate', 'A holiday already exists on this date.');
      const row: Holiday = {
        id: `h-${crypto.randomUUID()}`,
        organisation_id: db.read().organisation.id,
        date: body.date,
        name: body.name.trim(),
        is_optional: body.is_optional ?? false,
        created_at: nowISO(),
        updated_at: nowISO(),
        created_by: user.id,
        updated_by: user.id,
        deleted_at: null,
      };
      db.write((d) => d.holidays.push(row));
      auditChange(user.id, 'holiday.created', 'Holiday', row.id, null, row, request);
      return ok({ holiday: row });
    }),
  ),

  http.delete(
    '/api/settings/holidays/:id',
    withAuth(async ({ user, params, request }) => {
      if (!requireManage(user.id)) return err(403, 'forbidden', 'Access denied.');
      const id = String(params.id);
      const target = db.read().holidays.find((h) => h.id === id);
      if (!target) return err(404, 'not_found', 'Holiday not found.');
      db.write((d) => {
        d.holidays = d.holidays.filter((x) => x.id !== id);
      });
      auditChange(user.id, 'holiday.deleted', 'Holiday', id, target, null, request);
      return ok({ ok: true });
    }),
  ),
];

// ── Leave types (read + PATCH only — never delete; history references) ───
const leaveTypeHandlers = [
  http.get('/api/settings/leave-types', withAuth(async () => ok({ items: db.read().leaveTypes }))),

  http.patch(
    '/api/settings/leave-types/:id',
    withAuth(async ({ user, params, request }) => {
      if (!requireManage(user.id)) return err(403, 'forbidden', 'Access denied.');
      const id = String(params.id);
      const target = db.read().leaveTypes.find((t) => t.id === id);
      if (!target) return err(404, 'not_found', 'Leave type not found.');
      const body = (await request.json().catch(() => ({}))) as Partial<LeaveType>;
      const before = { ...target };
      db.write((d) => {
        const t = d.leaveTypes.find((x) => x.id === id)!;
        if (body.name?.trim()) t.name = body.name.trim();
        if (typeof body.annual_entitlement === 'number' || body.annual_entitlement === null) {
          t.annual_entitlement = body.annual_entitlement;
        }
        if (typeof body.carry_forward_max === 'number') t.carry_forward_max = body.carry_forward_max;
        if (typeof body.half_day_allowed === 'boolean') t.half_day_allowed = body.half_day_allowed;
        if (typeof body.min_notice_days === 'number') t.min_notice_days = body.min_notice_days;
        if (typeof body.accrue_during_probation === 'boolean') t.accrue_during_probation = body.accrue_during_probation;
        t.updated_at = nowISO();
        t.updated_by = user.id;
      });
      auditChange(user.id, 'leave_type.updated', 'LeaveType', id, before, db.read().leaveTypes.find((t) => t.id === id), request);
      return ok({ leaveType: db.read().leaveTypes.find((t) => t.id === id) });
    }),
  ),
];

// ── Expense categories ───────────────────────────────────────────────────
const expenseCategoryHandlers = [
  http.get('/api/settings/expense-categories', withAuth(async () => ok({ items: db.read().expenseCategories }))),

  http.post(
    '/api/settings/expense-categories',
    withAuth(async ({ user, request }) => {
      if (!requireManage(user.id)) return err(403, 'forbidden', 'Access denied.');
      const body = (await request.json().catch(() => ({}))) as Partial<ExpenseCategory>;
      if (!body.name?.trim() || !body.code?.trim()) return err(400, 'validation', 'name and code required.');
      const row: ExpenseCategory = {
        id: `ec-${crypto.randomUUID()}`,
        organisation_id: db.read().organisation.id,
        name: body.name.trim(),
        code: body.code.trim().toUpperCase(),
        is_active: body.is_active ?? true,
        requires_receipt: body.requires_receipt ?? true,
        gl_account: body.gl_account ?? null,
        created_at: nowISO(),
        updated_at: nowISO(),
        created_by: user.id,
        updated_by: user.id,
        deleted_at: null,
      };
      db.write((d) => d.expenseCategories.push(row));
      auditChange(user.id, 'expense_category.created', 'ExpenseCategory', row.id, null, row, request);
      return ok({ category: row });
    }),
  ),

  http.patch(
    '/api/settings/expense-categories/:id',
    withAuth(async ({ user, params, request }) => {
      if (!requireManage(user.id)) return err(403, 'forbidden', 'Access denied.');
      const id = String(params.id);
      const target = db.read().expenseCategories.find((c) => c.id === id);
      if (!target) return err(404, 'not_found', 'Category not found.');
      const body = (await request.json().catch(() => ({}))) as Partial<ExpenseCategory>;
      const before = { ...target };
      db.write((d) => {
        const t = d.expenseCategories.find((x) => x.id === id)!;
        if (body.name?.trim()) t.name = body.name.trim();
        if (body.code?.trim()) t.code = body.code.trim().toUpperCase();
        if (typeof body.is_active === 'boolean') t.is_active = body.is_active;
        if (typeof body.requires_receipt === 'boolean') t.requires_receipt = body.requires_receipt;
        if (typeof body.gl_account === 'string' || body.gl_account === null) t.gl_account = body.gl_account;
        t.updated_at = nowISO();
        t.updated_by = user.id;
      });
      auditChange(user.id, 'expense_category.updated', 'ExpenseCategory', id, before, db.read().expenseCategories.find((c) => c.id === id), request);
      return ok({ category: db.read().expenseCategories.find((c) => c.id === id) });
    }),
  ),
];

// ── Statutory rates (append-only w/ effective dating) ────────────────────
const statutoryRateHandlers = [
  http.get(
    '/api/settings/statutory-rates',
    withAuth(async ({ user, request }) => {
      // Read access: HR/MD (settings.manage) OR MD (audit.read.all). Non-admin
      // roles need not see rates today; if that changes, relax here.
      if (!requireManage(user.id)) return err(403, 'forbidden', 'Access denied.');
      const url = new URL(request.url);
      const code = url.searchParams.get('code');
      let rows = db.read().statutoryRates;
      if (code) rows = rows.filter((r) => r.code === code);
      // Sort by code then effective_from desc — history reads intuitively.
      rows = [...rows].sort((a, b) => (a.code === b.code ? (a.effective_from < b.effective_from ? 1 : -1) : a.code < b.code ? -1 : 1));
      return ok({ items: rows });
    }),
  ),

  http.post(
    '/api/settings/statutory-rates',
    withAuth(async ({ user, request }) => {
      if (!requireManage(user.id)) return err(403, 'forbidden', 'Access denied.');
      const body = (await request.json().catch(() => ({}))) as Partial<StatutoryRate>;
      if (!body.code || typeof body.value !== 'string' || !body.effective_from) {
        return err(400, 'validation', 'code, value (string), effective_from required.');
      }
      // Supersede the currently-effective row for this code (if any).
      db.write((d) => {
        for (const r of d.statutoryRates) {
          if (r.code === body.code && r.effective_to === null && r.effective_from < body.effective_from!) {
            // Cap the prior row's effective_to at the day BEFORE the new one starts.
            const prev = new Date(body.effective_from!);
            prev.setUTCDate(prev.getUTCDate() - 1);
            r.effective_to = prev.toISOString().slice(0, 10);
            r.updated_at = nowISO();
            r.updated_by = user.id;
          }
        }
      });
      const row: StatutoryRate = {
        id: `sr-${crypto.randomUUID()}`,
        organisation_id: db.read().organisation.id,
        code: body.code,
        value: body.value,
        effective_from: body.effective_from,
        effective_to: body.effective_to ?? null,
        notes: body.notes ?? null,
        created_at: nowISO(),
        updated_at: nowISO(),
        created_by: user.id,
        updated_by: user.id,
        deleted_at: null,
      };
      db.write((d) => d.statutoryRates.push(row));
      auditChange(user.id, 'statutory_rate.superseded', 'StatutoryRate', row.id, null, row, request);
      return ok({ rate: row });
    }),
  ),
];

// ── Roles + Permissions (read-only — matrix editor is out of scope) ──────
const roleHandlers = [
  http.get('/api/settings/roles', withAuth(async ({ user }) => {
    if (!requireManage(user.id)) return err(403, 'forbidden', 'Access denied.');
    // Serialise the client-side matrix so the UI can render a static grid.
    return ok({
      roles: db.read().roles,
      permissions: db.read().permissions,
      matrix: MATRIX,
    });
  })),
];

export const settingsHandlers = [
  ...workScheduleHandlers,
  ...departmentHandlers,
  ...designationHandlers,
  ...workLocationCrud,
  ...holidayHandlers,
  ...leaveTypeHandlers,
  ...expenseCategoryHandlers,
  ...statutoryRateHandlers,
  ...roleHandlers,
];
