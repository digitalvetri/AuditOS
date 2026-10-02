/**
 * Employees + Articled Training handlers per §9.
 *
 *   GET    /api/employees                    list w/ filters + scope + Finance projection
 *   POST   /api/employees                    create (HR/MD)
 *   GET    /api/employees/:id                single (scope + projection)
 *   PATCH  /api/employees/:id                update (self→contact only; HR/MD→all)
 *   POST   /api/employees/:id/deactivate     soft delete + session revoke + audit
 *   GET    /api/employees/:id/training       Articled only (404 otherwise)
 *   PATCH  /api/employees/:id/training       Articled only (422 otherwise)
 *   GET    /api/audit-logs                   scoped audit log (used by profile Activity tab)
 *
 * Finance projection (§5‡): id, employee_code, full_name, department_id,
 * designation_id, bank_account_masked, status ONLY. Stripped in the handler,
 * never in the UI.
 *
 * Self-edit allowlist (§5*): phone, address, emergency contact, bank details.
 * Any other field → 422 employment_fields_hr_only.
 */

import { http } from 'msw';
import type {
  ArticledTraining,
  Employee,
  EmployeeType,
  RoleCode,
} from '@/data/models';
import { db } from '../db';
import { audit, err, ok, withAuth } from '../middleware';
import { hasPermission, type Scope } from '@/platform/rbac/matrix';
import { istToday } from '@/lib/dates';

// ── Helpers ───────────────────────────────────────────────────────────────

const CONTACT_FIELDS = [
  'phone',
  'address',
  'emergency_contact_name',
  'emergency_contact_phone',
  'bank_account_masked',
] as const;
type ContactField = (typeof CONTACT_FIELDS)[number];

const EMPLOYMENT_ALLOWLIST_HR = [
  ...CONTACT_FIELDS,
  'first_name',
  'last_name',
  'full_name',
  'email',
  'type',
  'status',
  'designation_id',
  'department_id',
  'manager_id',
  'work_location_id',
  'work_schedule_id',
  'joining_date',
  'exit_date',
  'exit_reason',
  'notice_period_days',
  'weekly_capacity_hours',
  'photo_url',
] as const;

function roleOf(userId: string): RoleCode | null {
  const u = db.read().users.find((x) => x.id === userId);
  if (!u) return null;
  const r = db.read().roles.find((x) => x.id === u.role_id);
  return r?.code ?? null;
}

function scopeForEmployeeRead(role: RoleCode): Scope | 'finance' {
  if (hasPermission(role, 'employee.manage', 'organisation')) return 'organisation';
  if (hasPermission(role, 'employee.read', 'organisation')) return 'organisation';
  // Finance's restricted grant is distinct — separately named so the handler
  // knows to apply the projection.
  if (hasPermission(role, 'employee.read.restricted', 'organisation')) return 'finance';
  if (hasPermission(role, 'employee.read', 'department')) return 'department';
  return 'self';
}

/**
 * The exact 6-field projection Finance receives (plus `id` for keys). Anything
 * else is a spec violation.
 */
export interface FinanceProjection {
  id: string;
  employee_code: string;
  full_name: string;
  department_id: string;
  designation_id: string;
  bank_account_masked: string | null;
  status: Employee['status'];
}

function financeProjection(e: Employee): FinanceProjection {
  return {
    id: e.id,
    employee_code: e.employee_code,
    full_name: e.full_name,
    department_id: e.department_id,
    designation_id: e.designation_id,
    bank_account_masked: e.bank_account_masked,
    status: e.status,
  };
}

/** Row shape returned to Dept-Manager scope: no bank details, no sensitive personal fields. */
function deptManagerProjection(e: Employee) {
  const { bank_account_masked: _b, address: _a, emergency_contact_phone: _ep, emergency_contact_name: _en, ...rest } = e;
  return rest;
}

function attachTodayAttendance(row: Employee) {
  const today = istToday();
  const att = db
    .read()
    .attendance.find((a) => a.employee_id === row.id && a.date === today);
  return {
    ...row,
    today_attendance: att
      ? {
          status: att.status,
          check_in_at: att.check_in_at,
          check_out_at: att.check_out_at,
          worked_minutes: att.worked_minutes,
        }
      : null,
  };
}

function projectFor(scope: Scope | 'finance', e: Employee) {
  if (scope === 'finance') return financeProjection(e);
  if (scope === 'department') return attachTodayAttendance(deptManagerProjection(e) as Employee);
  return attachTodayAttendance(e);
}

// ── Handlers ──────────────────────────────────────────────────────────────

export const employeeHandlers = [
  // GET /api/employees
  http.get(
    '/api/employees',
    withAuth(async ({ user, employee, request }) => {
      const url = new URL(request.url);
      const filters = {
        departmentId: url.searchParams.get('departmentId'),
        designationId: url.searchParams.get('designationId'),
        type: url.searchParams.get('type') as EmployeeType | null,
        status: url.searchParams.get('status') as Employee['status'] | null,
        managerId: url.searchParams.get('managerId'),
        joinedFrom: url.searchParams.get('joinedFrom'),
        joinedTo: url.searchParams.get('joinedTo'),
        includeInactive: url.searchParams.get('includeInactive') === 'true',
        q: url.searchParams.get('q')?.trim().toLowerCase() ?? '',
      };
      if (filters.joinedFrom && filters.joinedTo && filters.joinedFrom > filters.joinedTo) {
        return err(422, 'invalid_range', 'joinedFrom must be on or before joinedTo.');
      }

      const role = roleOf(user.id)!;
      const scope = scopeForEmployeeRead(role);
      let rows = db.read().employees;

      // Scope narrowing.
      if (scope === 'self') {
        if (!employee) return ok({ items: [], count: 0, scope });
        rows = rows.filter((e) => e.id === employee.id);
      } else if (scope === 'department') {
        if (!employee) return ok({ items: [], count: 0, scope });
        rows = rows.filter((e) => e.department_id === employee.department_id);
      }
      // organisation and finance: all rows.

      // Soft-delete: hide inactive unless explicitly requested (HR/MD only).
      const showInactive =
        filters.includeInactive && (scope === 'organisation');
      if (!showInactive) {
        rows = rows.filter((e) => !e.deleted_at && e.status !== 'inactive');
      }

      // Column filters.
      if (filters.departmentId) rows = rows.filter((e) => e.department_id === filters.departmentId);
      if (filters.designationId) rows = rows.filter((e) => e.designation_id === filters.designationId);
      if (filters.type) rows = rows.filter((e) => e.type === filters.type);
      if (filters.status) rows = rows.filter((e) => e.status === filters.status);
      if (filters.managerId) rows = rows.filter((e) => e.manager_id === filters.managerId);
      if (filters.joinedFrom) rows = rows.filter((e) => e.joining_date >= filters.joinedFrom!);
      if (filters.joinedTo) rows = rows.filter((e) => e.joining_date <= filters.joinedTo!);
      if (filters.q) rows = rows.filter((e) =>
        e.full_name.toLowerCase().includes(filters.q) ||
        e.email.toLowerCase().includes(filters.q) ||
        e.employee_code.toLowerCase().includes(filters.q),
      );

      // Stable order: employee_code asc.
      rows = [...rows].sort((a, b) => (a.employee_code < b.employee_code ? -1 : 1));

      const items = rows.map((r) => projectFor(scope, r));
      return ok({ items, count: items.length, scope });
    }),
  ),

  // POST /api/employees — create (HR/MD)
  http.post(
    '/api/employees',
    withAuth(async ({ user, request }) => {
      const role = roleOf(user.id)!;
      if (!hasPermission(role, 'employee.manage', 'organisation')) {
        return err(403, 'forbidden', 'Only HR or MD can create employees.');
      }
      const body = (await request.json().catch(() => ({}))) as Partial<Employee>;
      if (!body.first_name || !body.last_name || !body.email || !body.department_id || !body.designation_id) {
        return err(400, 'validation', 'first_name, last_name, email, department_id and designation_id are required.');
      }
      const nowISO = new Date().toISOString();
      const nextCode = `AO-${String(db.read().employees.length + 1).padStart(4, '0')}`;
      const row: Employee = {
        id: `emp-${crypto.randomUUID()}`,
        organisation_id: db.read().organisation.id,
        employee_code: body.employee_code ?? nextCode,
        first_name: body.first_name,
        last_name: body.last_name,
        full_name: `${body.first_name} ${body.last_name}`,
        type: (body.type ?? 'executive') as EmployeeType,
        status: (body.status ?? 'probation') as Employee['status'],
        designation_id: body.designation_id,
        department_id: body.department_id,
        manager_id: body.manager_id ?? null,
        work_location_id: body.work_location_id ?? 'wl-hq',
        work_schedule_id: body.work_schedule_id ?? 'ws-standard',
        email: body.email,
        phone: body.phone ?? '',
        joining_date: body.joining_date ?? istToday(),
        exit_date: null,
        exit_reason: null,
        notice_period_days: body.notice_period_days ?? 30,
        weekly_capacity_hours: body.weekly_capacity_hours ?? 40,
        photo_url: null,
        address: null,
        emergency_contact_name: null,
        emergency_contact_phone: null,
        bank_account_masked: null,
        created_at: nowISO,
        updated_at: nowISO,
        created_by: user.id,
        updated_by: user.id,
        deleted_at: null,
      };
      db.write((d) => d.employees.push(row));
      audit({
        actor_user_id: user.id,
        action: 'employee.created',
        entity_type: 'Employee',
        entity_id: row.id,
        after_json: { code: row.employee_code, name: row.full_name },
        request,
      });
      return ok({ employee: row });
    }),
  ),

  // GET /api/employees/:id
  http.get(
    '/api/employees/:id',
    withAuth(async ({ user, employee, params }) => {
      const id = String(params.id);
      const target = db.read().employees.find((e) => e.id === id);
      if (!target) return err(404, 'not_found', 'Employee not found.');
      const role = roleOf(user.id)!;
      const scope = scopeForEmployeeRead(role);

      const allowed =
        scope === 'organisation' ||
        scope === 'finance' ||
        (scope === 'department' && employee?.department_id === target.department_id) ||
        (scope === 'self' && employee?.id === id);
      if (!allowed) return err(403, 'forbidden', 'Access denied.');

      const dept = db.read().departments.find((d) => d.id === target.department_id);
      const designation = db.read().designations.find((d) => d.id === target.designation_id);
      const manager = target.manager_id ? db.read().employees.find((e) => e.id === target.manager_id) : null;
      const location = db.read().workLocations.find((w) => w.id === target.work_location_id);

      const projected = projectFor(scope, target);

      return ok({
        employee: projected,
        // Reference joins are safe to send at all scopes — they're display labels.
        refs: {
          department: dept ? { id: dept.id, name: dept.name } : null,
          designation: designation ? { id: designation.id, name: designation.name } : null,
          manager: manager ? { id: manager.id, full_name: manager.full_name, employee_code: manager.employee_code } : null,
          location: location ? { id: location.id, name: location.name } : null,
        },
      });
    }),
  ),

  // PATCH /api/employees/:id
  http.patch(
    '/api/employees/:id',
    withAuth(async ({ user, employee, params, request }) => {
      const id = String(params.id);
      const target = db.read().employees.find((e) => e.id === id);
      if (!target) return err(404, 'not_found', 'Employee not found.');
      if (target.deleted_at) return err(409, 'inactive', 'This employee record is inactive.');

      const role = roleOf(user.id)!;
      const canManage = hasPermission(role, 'employee.manage', 'organisation');
      const isOwn = employee?.id === id;

      if (!canManage && !isOwn) {
        return err(403, 'forbidden', 'Only HR/MD or the employee themself can edit this record.');
      }

      const body = (await request.json().catch(() => ({}))) as Partial<Employee>;
      const submittedKeys = Object.keys(body);

      // Self-edit allowlist enforcement.
      if (!canManage && isOwn) {
        const disallowed = submittedKeys.filter(
          (k) => !CONTACT_FIELDS.includes(k as ContactField),
        );
        if (disallowed.length > 0) {
          return err(422, 'employment_fields_hr_only', 'Only HR/MD can update employment fields.', {
            disallowed,
          });
        }
      }

      // For HR/MD, cap to a known field set — never accept unknown keys.
      if (canManage) {
        const invalid = submittedKeys.filter(
          (k) => !(EMPLOYMENT_ALLOWLIST_HR as readonly string[]).includes(k),
        );
        if (invalid.length > 0) {
          return err(422, 'unknown_fields', 'Unknown fields in request.', { invalid });
        }
      }

      const before = { ...target };
      const nowISO = new Date().toISOString();
      db.write((d) => {
        const t = d.employees.find((e) => e.id === id)!;
        for (const [k, v] of Object.entries(body)) {
          // TypeScript-safe assignment — the allowlist above bounds `k`.
          (t as unknown as Record<string, unknown>)[k] = v;
        }
        // If first_name / last_name changed, recompute full_name.
        if ('first_name' in body || 'last_name' in body) {
          t.full_name = `${t.first_name} ${t.last_name}`;
        }
        t.updated_at = nowISO;
        t.updated_by = user.id;
      });

      audit({
        actor_user_id: user.id,
        action: isOwn ? 'employee.self_contact_updated' : 'employee.updated',
        entity_type: 'Employee',
        entity_id: id,
        before_json: before,
        after_json: db.read().employees.find((e) => e.id === id),
        request,
      });

      const fresh = db.read().employees.find((e) => e.id === id)!;
      return ok({ employee: fresh });
    }),
  ),

  // POST /api/employees/:id/deactivate
  http.post(
    '/api/employees/:id/deactivate',
    withAuth(async ({ user, params, request }) => {
      const id = String(params.id);
      const target = db.read().employees.find((e) => e.id === id);
      if (!target) return err(404, 'not_found', 'Employee not found.');

      const role = roleOf(user.id)!;
      if (!hasPermission(role, 'employee.manage', 'organisation')) {
        return err(403, 'forbidden', 'Only HR or MD can deactivate.');
      }
      if (target.deleted_at) return err(409, 'already_inactive', 'Already inactive.');
      if (target.id === user.id) {
        return err(422, 'self_deactivate', 'You cannot deactivate yourself.');
      }

      const nowISO = new Date().toISOString();
      const before = { ...target };
      db.write((d) => {
        const emp = d.employees.find((e) => e.id === id)!;
        emp.status = 'inactive';
        emp.deleted_at = nowISO;
        emp.updated_at = nowISO;
        emp.updated_by = user.id;
        // Session revocation: block login by flipping the linked User.
        const linked = d.users.find((u) => u.employee_id === id);
        if (linked) linked.is_active = false;
        // TODO(part-2): close open chat memberships, flag pending expenses,
        // hold the employee out of the next payroll run. Emit those hooks
        // when Part 2 modules land.
      });

      audit({
        actor_user_id: user.id,
        action: 'employee.deactivated',
        entity_type: 'Employee',
        entity_id: id,
        before_json: before,
        after_json: db.read().employees.find((e) => e.id === id),
        request,
      });

      return ok({ employee: db.read().employees.find((e) => e.id === id)! });
    }),
  ),

  // GET /api/employees/:id/training
  http.get(
    '/api/employees/:id/training',
    withAuth(async ({ user, employee, params }) => {
      const id = String(params.id);
      const target = db.read().employees.find((e) => e.id === id);
      if (!target) return err(404, 'not_found', 'Employee not found.');
      const role = roleOf(user.id)!;
      const scope = scopeForEmployeeRead(role);
      const allowed =
        scope === 'organisation' ||
        (scope === 'department' && employee?.department_id === target.department_id) ||
        (scope === 'self' && employee?.id === id);
      if (!allowed) return err(403, 'forbidden', 'Access denied.');

      if (target.type !== 'articled') {
        // Genuinely doesn't exist for non-Articled — 404, not empty 200.
        return err(404, 'not_articled', 'Training record only exists for Articled Assistants.');
      }

      const record = db.read().articledTraining.find((t) => t.employee_id === id);
      if (!record) return err(404, 'not_found', 'Training record not created yet.');

      const principal = db.read().employees.find((e) => e.id === record.principal_employee_id);
      return ok({
        training: record,
        principal: principal
          ? { id: principal.id, full_name: principal.full_name, employee_code: principal.employee_code }
          : null,
      });
    }),
  ),

  // PATCH /api/employees/:id/training
  http.patch(
    '/api/employees/:id/training',
    withAuth(async ({ user, params, request }) => {
      const id = String(params.id);
      const target = db.read().employees.find((e) => e.id === id);
      if (!target) return err(404, 'not_found', 'Employee not found.');
      const role = roleOf(user.id)!;
      if (!hasPermission(role, 'employee.manage', 'organisation')) {
        return err(403, 'forbidden', 'Only HR or MD can update training.');
      }
      if (target.type !== 'articled') {
        return err(422, 'not_articled', 'Training only applies to Articled Assistants.');
      }
      const body = (await request.json().catch(() => ({}))) as Partial<ArticledTraining>;
      const nowISO = new Date().toISOString();
      const before = db.read().articledTraining.find((t) => t.employee_id === id) ?? null;

      db.write((d) => {
        let t = d.articledTraining.find((x) => x.employee_id === id);
        if (!t) {
          t = {
            id: `at-${crypto.randomUUID()}`,
            employee_id: id,
            icai_registration_no: body.icai_registration_no ?? '',
            principal_employee_id: body.principal_employee_id ?? '',
            training_start: body.training_start ?? nowISO.slice(0, 10),
            training_end: body.training_end ?? nowISO.slice(0, 10),
            current_year: body.current_year ?? 1,
            stipend_slab: body.stipend_slab ?? '',
            status: body.status ?? 'active',
            created_at: nowISO,
            updated_at: nowISO,
            created_by: user.id,
            updated_by: user.id,
            deleted_at: null,
          };
          d.articledTraining.push(t);
        } else {
          Object.assign(t, body);
          t.updated_at = nowISO;
          t.updated_by = user.id;
        }
      });

      audit({
        actor_user_id: user.id,
        action: 'employee.training_updated',
        entity_type: 'ArticledTraining',
        entity_id: id,
        before_json: before,
        after_json: db.read().articledTraining.find((t) => t.employee_id === id),
        request,
      });

      return ok({ training: db.read().articledTraining.find((t) => t.employee_id === id) });
    }),
  ),

  // GET /api/audit-logs?entity_type=Employee&entity_id=:id  — Activity tab
  http.get(
    '/api/audit-logs',
    withAuth(async ({ user, employee, request }) => {
      const url = new URL(request.url);
      const entityType = url.searchParams.get('entity_type');
      const entityId = url.searchParams.get('entity_id');
      const role = roleOf(user.id)!;
      const orgAudit = hasPermission(role, 'audit.read.all', 'organisation');
      const hrAudit = hasPermission(role, 'audit.read.hr', 'organisation');
      const isOwnScope = entityType === 'Employee' && entityId && employee?.id === entityId;

      // Own activity is allowed at self scope. Others require audit grant.
      if (!orgAudit && !hrAudit && !isOwnScope) {
        return err(403, 'forbidden', 'Audit access required.');
      }

      let rows = db.read().auditLog;
      if (entityType) rows = rows.filter((r) => r.entity_type === entityType);
      if (entityId) rows = rows.filter((r) => r.entity_id === entityId);
      // Newest first, cap at 50.
      rows = [...rows].sort((a, b) => (a.created_at > b.created_at ? -1 : 1)).slice(0, 50);

      return ok({ items: rows, count: rows.length });
    }),
  ),
];
