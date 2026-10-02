/**
 * Reports handlers per §8.10 + §9.
 *
 *   GET /api/reports/:type?params
 *
 * Types:
 *   attendance   per-employee summary for a period (present/late/absent/leave/wfh/hours/off-site)
 *   leave        utilisation by employee (entitled/availed/pending/available per type)
 *   payroll      salary summary for a PayrollRun (per employee gross/deductions/net)
 *   expenses     per-employee + per-category summary for a period
 *
 * RBAC scoped at QUERY level, not response filter (§8.10).
 *   attendance/leave: Employee=self, Manager=dept, HR/MD=org, Finance=denied.
 *   payroll/expenses: Employee=self (own only), Finance/MD=org, HR/Manager=denied.
 */

import { http } from 'msw';
import type { Employee, RoleCode } from '@/data/models';
import { db } from '../db';
import { err, ok, withAuth } from '../middleware';
import { hasPermission } from '@/platform/rbac/matrix';

type ReportScope = 'self' | 'department' | 'organisation';

function roleOf(userId: string): RoleCode | null {
  const u = db.read().users.find((x) => x.id === userId);
  if (!u) return null;
  return db.read().roles.find((x) => x.id === u.role_id)?.code ?? null;
}

/** Scope for attendance + leave reports. */
function peopleScope(role: RoleCode): ReportScope | 'blocked' {
  if (hasPermission(role, 'reports.all', 'organisation')) return 'organisation';
  if (hasPermission(role, 'reports.hr', 'organisation')) return 'organisation';
  if (hasPermission(role, 'reports.hr', 'department')) return 'department';
  if (hasPermission(role, 'reports.hr', 'self')) return 'self';
  return 'blocked';
}

/** Scope for payroll + expenses reports. */
function financeScope(role: RoleCode): ReportScope | 'blocked' {
  if (hasPermission(role, 'reports.all', 'organisation')) return 'organisation';
  if (hasPermission(role, 'reports.finance', 'organisation')) return 'organisation';
  // Employee self-scope for expenses only — their own history.
  if (hasPermission(role, 'expense.submit', 'self')) return 'self';
  return 'blocked';
}

function empsInScope(scope: ReportScope, caller: Employee | null): Employee[] {
  const all = db.read().employees.filter((e) => !e.deleted_at);
  if (scope === 'organisation') return all;
  if (scope === 'department' && caller) return all.filter((e) => e.department_id === caller.department_id);
  if (scope === 'self' && caller) return all.filter((e) => e.id === caller.id);
  return [];
}

const nowISO = () => new Date().toISOString();

export const reportsHandlers = [
  http.get(
    '/api/reports/:type',
    withAuth(async ({ user, employee, request, params }) => {
      const type = String(params.type);
      const url = new URL(request.url);
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const departmentId = url.searchParams.get('departmentId');
      const employeeIdFilter = url.searchParams.get('employeeId');
      const runId = url.searchParams.get('runId');

      const role = roleOf(user.id)!;

      // ── Attendance ───────────────────────────────────────────────────────
      if (type === 'attendance') {
        const scope = peopleScope(role);
        if (scope === 'blocked') return err(403, 'forbidden', 'Access denied.');
        let emps = empsInScope(scope, employee);
        if (departmentId) emps = emps.filter((e) => e.department_id === departmentId);
        if (employeeIdFilter) {
          const target = emps.find((e) => e.id === employeeIdFilter);
          if (!target) return err(403, 'forbidden', 'Access denied.');
          emps = [target];
        }
        // Attendance for those employees in the [from..to] window.
        const rows = emps.map((e) => {
          let att = db.read().attendance.filter((a) => a.employee_id === e.id);
          if (from) att = att.filter((a) => a.date >= from);
          if (to) att = att.filter((a) => a.date <= to);
          const present = att.filter((a) => a.status === 'present').length;
          const late = att.filter((a) => a.status === 'late').length;
          const half_day = att.filter((a) => a.status === 'half_day').length;
          const wfh = att.filter((a) => a.status === 'wfh').length;
          const absent = att.filter((a) => a.status === 'absent').length;
          const on_leave = att.filter((a) => a.status === 'on_leave').length;
          const missing_check_out = att.filter((a) => a.status === 'missing_check_out').length;
          const off_site = att.filter((a) => a.location_type && a.location_type !== 'office').length;
          const total_minutes = att.reduce((s, a) => s + (a.worked_minutes ?? 0), 0);
          return {
            employee_id: e.id,
            employee_code: e.employee_code,
            full_name: e.full_name,
            department_id: e.department_id,
            days_recorded: att.length,
            present, late, half_day, wfh, absent, on_leave, missing_check_out,
            off_site_days: off_site,
            hours: Math.round((total_minutes / 60) * 100) / 100,
          };
        });
        return ok({ type, items: rows, generated_at: nowISO(), scope });
      }

      // ── Leave utilisation ────────────────────────────────────────────────
      if (type === 'leave') {
        const scope = peopleScope(role);
        if (scope === 'blocked') return err(403, 'forbidden', 'Access denied.');
        let emps = empsInScope(scope, employee);
        if (departmentId) emps = emps.filter((e) => e.department_id === departmentId);
        if (employeeIdFilter) {
          const target = emps.find((e) => e.id === employeeIdFilter);
          if (!target) return err(403, 'forbidden', 'Access denied.');
          emps = [target];
        }
        const types = db.read().leaveTypes;
        const rows = emps.map((e) => {
          const balances = db.read().leaveBalances.filter((b) => b.employee_id === e.id);
          const pending = db
            .read()
            .leaveRequests.filter((r) => r.employee_id === e.id && r.status === 'pending');
          const perType = types.map((t) => {
            const b = balances.find((bb) => bb.leave_type_id === t.id);
            const pendingDays = pending
              .filter((p) => p.leave_type_id === t.id)
              .reduce((s, p) => s + p.computed_working_days, 0);
            const entitled = (b?.entitled ?? 0) + (b?.carried_forward ?? 0);
            const availed = b?.availed ?? 0;
            return {
              type_code: t.code,
              type_name: t.name,
              entitled,
              availed,
              pending: pendingDays,
              available: Math.max(0, entitled - availed - pendingDays),
            };
          });
          return {
            employee_id: e.id,
            employee_code: e.employee_code,
            full_name: e.full_name,
            department_id: e.department_id,
            by_type: perType,
          };
        });
        return ok({ type, items: rows, generated_at: nowISO(), scope });
      }

      // ── Payroll (salary summary for a run) ───────────────────────────────
      if (type === 'payroll') {
        const scope = financeScope(role);
        if (scope === 'blocked') return err(403, 'forbidden', 'Access denied.');
        // Employees can see their own payslips via the payroll module. This
        // report is aggregate — restrict self scope to their own row only.
        if (!hasPermission(role, 'payroll.view', 'organisation') && !hasPermission(role, 'payroll.view.own', 'self')) {
          return err(403, 'forbidden', 'Access denied.');
        }
        // Default: newest processed run when runId not given.
        const runs = db.read().payrollRuns;
        const run = runId
          ? runs.find((r) => r.id === runId)
          : [...runs].filter((r) => r.stage === 'processed').sort((a, b) => (a.period_start < b.period_start ? 1 : -1))[0];
        if (!run) return err(404, 'not_found', 'No payroll run found.');
        let items = db.read().payrollItems.filter((i) => i.payroll_run_id === run.id);
        if (scope === 'self' && employee) {
          items = items.filter((i) => i.employee_id === employee.id);
        }
        if (departmentId && scope !== 'self') {
          const empIds = db.read().employees.filter((e) => e.department_id === departmentId).map((e) => e.id);
          items = items.filter((i) => empIds.includes(i.employee_id));
        }
        const enriched = items.map((i) => {
          const e = db.read().employees.find((x) => x.id === i.employee_id);
          return {
            employee_id: i.employee_id,
            employee_code: e?.employee_code ?? '',
            full_name: e?.full_name ?? '',
            department_id: e?.department_id ?? '',
            payable_days: i.payable_days,
            lop_days: i.lop_days,
            basic_paise: i.earnings.basic_paise,
            hra_paise: i.earnings.hra_paise,
            gross_paise: i.gross_paise,
            pf_paise: i.deductions.pf_employee_paise,
            esi_paise: i.deductions.esi_employee_paise,
            pt_paise: i.deductions.pt_paise,
            tds_paise: i.deductions.tds_paise,
            lop_paise: i.deductions.lop_paise,
            total_deductions_paise: i.total_deductions_paise,
            net_paise: i.net_paise,
          };
        });
        return ok({
          type,
          run: { id: run.id, period_start: run.period_start, period_end: run.period_end, stage: run.stage },
          items: enriched,
          totals: {
            gross_paise: enriched.reduce((s, r) => s + r.gross_paise, 0),
            deductions_paise: enriched.reduce((s, r) => s + r.total_deductions_paise, 0),
            net_paise: enriched.reduce((s, r) => s + r.net_paise, 0),
          },
          generated_at: nowISO(),
          scope,
        });
      }

      // ── Expenses ────────────────────────────────────────────────────────
      if (type === 'expenses') {
        const scope = financeScope(role);
        if (scope === 'blocked') return err(403, 'forbidden', 'Access denied.');
        let exps = db.read().expenses.filter((e) => !e.deleted_at);
        if (from) exps = exps.filter((e) => e.expense_date >= from);
        if (to) exps = exps.filter((e) => e.expense_date <= to);

        if (scope === 'self' && employee) {
          exps = exps.filter((e) => e.employee_id === employee.id);
        } else if (departmentId) {
          const empIds = db.read().employees.filter((emp) => emp.department_id === departmentId).map((emp) => emp.id);
          exps = exps.filter((e) => empIds.includes(e.employee_id));
        }
        if (employeeIdFilter) {
          if (scope === 'self' && employee?.id !== employeeIdFilter) return err(403, 'forbidden', 'Access denied.');
          exps = exps.filter((e) => e.employee_id === employeeIdFilter);
        }

        // Aggregate per employee.
        const byEmp = new Map<string, { claimed: number; reimbursed: number; drafts: number; count: number }>();
        for (const e of exps) {
          const b = byEmp.get(e.employee_id) ?? { claimed: 0, reimbursed: 0, drafts: 0, count: 0 };
          if (e.stage === 'draft') b.drafts += 1;
          if (e.stage !== 'rejected' && e.stage !== 'draft') b.claimed += e.amount_paise;
          if (e.stage === 'paid') b.reimbursed += e.amount_paise;
          b.count += 1;
          byEmp.set(e.employee_id, b);
        }

        // Aggregate per category too.
        const byCat = new Map<string, { count: number; total: number }>();
        for (const e of exps) {
          const b = byCat.get(e.category_id) ?? { count: 0, total: 0 };
          b.count += 1;
          if (e.stage === 'paid') b.total += e.amount_paise;
          byCat.set(e.category_id, b);
        }

        const perEmployee = Array.from(byEmp.entries()).map(([empId, agg]) => {
          const emp = db.read().employees.find((x) => x.id === empId);
          return {
            employee_id: empId,
            employee_code: emp?.employee_code ?? '',
            full_name: emp?.full_name ?? '',
            department_id: emp?.department_id ?? '',
            count: agg.count,
            drafts: agg.drafts,
            claimed_paise: agg.claimed,
            reimbursed_paise: agg.reimbursed,
          };
        });
        const perCategory = Array.from(byCat.entries()).map(([catId, agg]) => {
          const cat = db.read().expenseCategories.find((x) => x.id === catId);
          return {
            category_id: catId,
            category_code: cat?.code ?? '',
            category_name: cat?.name ?? '',
            count: agg.count,
            reimbursed_paise: agg.total,
          };
        });

        return ok({
          type,
          items: perEmployee,
          by_category: perCategory,
          totals: {
            expense_count: exps.length,
            claimed_paise: perEmployee.reduce((s, r) => s + r.claimed_paise, 0),
            reimbursed_paise: perEmployee.reduce((s, r) => s + r.reimbursed_paise, 0),
          },
          generated_at: nowISO(),
          scope,
        });
      }

      return err(400, 'unknown_type', `Unknown report type: ${type}`);
    }),
  ),
];

