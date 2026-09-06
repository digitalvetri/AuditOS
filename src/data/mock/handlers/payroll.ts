/**
 * Payroll handlers per §8.4 + §9.
 *
 *   GET  /api/payroll/runs                              list (payroll.view)
 *   POST /api/payroll/runs                              create (payroll.run)
 *   GET  /api/payroll/runs/:id                          detail w/ items
 *   POST /api/payroll/runs/:id/calculate                Draft only; writes items
 *   POST /api/payroll/runs/:id/review                   HR → HR Review → Finance Review
 *   POST /api/payroll/runs/:id/approve                  Finance approves → Approved
 *   POST /api/payroll/runs/:id/process                  Finance/MD → Processed
 *                                                       (payments + ledger + payslips)
 *   GET  /api/payroll/payslips                          scoped list
 *   GET  /api/payroll/payslips/:id                      one — own or authorised
 *   GET  /api/payroll/payslips/:id/pdf                  mock bytes (signed URL pattern)
 *
 * Stage machine:
 *   draft → hr_review → finance_review → approved → processed  (each step audited)
 *
 * Immutability: a Processed run refuses all state-change endpoints. Salary
 * structure changes DO NOT retroactively affect a Processed run — the calc
 * reads the SalaryStructure version effective on `period_start` and the
 * StatutoryRate snapshot captured at calculate-time.
 */

import { http, HttpResponse } from 'msw';
import type {
  PayrollItem,
  PayrollRun,
  PayrollStage,
  Payment,
  Payslip,
  RoleCode,
} from '@/data/models';
import { db } from '../db';
import { audit, err, ok, withAuth } from '../middleware';
import { hasPermission } from '@/platform/rbac/matrix';
import { snapshotAt } from '@/lib/payroll/statutory';
import { calculatePayrollItem } from '@/lib/payroll/calc';
import { summarize } from '@/lib/payroll/attendanceSummary';

function roleOf(userId: string): RoleCode | null {
  const u = db.read().users.find((x) => x.id === userId);
  if (!u) return null;
  return db.read().roles.find((x) => x.id === u.role_id)?.code ?? null;
}

function requireView(userId: string): boolean {
  const role = roleOf(userId);
  return role ? hasPermission(role, 'payroll.view', 'organisation') : false;
}

function findEmp(id: string) {
  return db.read().employees.find((e) => e.id === id);
}

function structureEffective(employeeId: string, onISODate: string) {
  return db
    .read()
    .salaryStructures
    .filter((s) => s.employee_id === employeeId)
    .filter((s) => s.effective_from <= onISODate && (s.effective_to === null || s.effective_to >= onISODate))
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];
}

const nowISO = () => new Date().toISOString();

// ── Signed-URL token store for payslip PDFs (5-min TTL) ──────────────────
const pdfTokens = new Map<string, { payslipId: string; userId: string; expiresAt: number }>();
function issuePdfToken(payslipId: string, userId: string): string {
  const tok = crypto.randomUUID();
  pdfTokens.set(tok, { payslipId, userId, expiresAt: Date.now() + 5 * 60_000 });
  return tok;
}
function verifyPdfToken(tok: string): { payslipId: string; userId: string } | null {
  const rec = pdfTokens.get(tok);
  if (!rec || rec.expiresAt < Date.now()) return null;
  return { payslipId: rec.payslipId, userId: rec.userId };
}

// ── Handlers ──────────────────────────────────────────────────────────────

export const payrollHandlers = [
  // ── Runs ────────────────────────────────────────────────────────────────
  http.get(
    '/api/payroll/runs',
    withAuth(async ({ user }) => {
      if (!requireView(user.id)) return err(403, 'forbidden', 'Access denied.');
      const runs = [...db.read().payrollRuns].sort((a, b) => (a.period_start < b.period_start ? 1 : -1));
      return ok({ items: runs });
    }),
  ),

  http.post(
    '/api/payroll/runs',
    withAuth(async ({ user, request }) => {
      const role = roleOf(user.id)!;
      if (!hasPermission(role, 'payroll.run', 'organisation')) {
        return err(403, 'forbidden', 'Only HR/MD can create a payroll run.');
      }
      const body = (await request.json().catch(() => ({}))) as {
        period_start?: string;
        period_end?: string;
      };
      if (!body.period_start || !body.period_end) {
        return err(400, 'validation', 'period_start and period_end required.');
      }
      if (body.period_start > body.period_end) {
        return err(422, 'invalid_range', 'period_start must be on or before period_end.');
      }
      // Reject overlapping runs.
      const overlap = db.read().payrollRuns.some(
        (r) => !(r.period_end < body.period_start! || r.period_start > body.period_end!),
      );
      if (overlap) return err(409, 'overlap', 'A payroll run for this period already exists.');
      const row: PayrollRun = {
        id: `pr-${crypto.randomUUID()}`,
        organisation_id: db.read().organisation.id,
        period_start: body.period_start,
        period_end: body.period_end,
        stage: 'draft',
        is_calculating: false,
        statutory_snapshot: null,
        headcount: 0,
        gross_total_paise: 0,
        deductions_total_paise: 0,
        net_total_paise: 0,
        reviewed_by: null,
        approved_by: null,
        processed_by: null,
        processed_at: null,
        notes: null,
        created_at: nowISO(),
        updated_at: nowISO(),
        created_by: user.id,
        updated_by: user.id,
        deleted_at: null,
      };
      db.write((d) => d.payrollRuns.push(row));
      audit({ actor_user_id: user.id, action: 'payroll.run_created', entity_type: 'PayrollRun', entity_id: row.id, after_json: row, request });
      return ok({ run: row });
    }),
  ),

  http.get(
    '/api/payroll/runs/:id',
    withAuth(async ({ user, params }) => {
      if (!requireView(user.id)) return err(403, 'forbidden', 'Access denied.');
      const id = String(params.id);
      const run = db.read().payrollRuns.find((r) => r.id === id);
      if (!run) return err(404, 'not_found', 'Run not found.');
      const items = db.read().payrollItems.filter((i) => i.payroll_run_id === id);
      const withEmp = items.map((i) => {
        const emp = findEmp(i.employee_id);
        return {
          ...i,
          employee: emp ? { id: emp.id, full_name: emp.full_name, employee_code: emp.employee_code, department_id: emp.department_id } : null,
        };
      }).sort((a, b) => (a.employee?.employee_code ?? '').localeCompare(b.employee?.employee_code ?? ''));
      return ok({ run, items: withEmp });
    }),
  ),

  // POST /api/payroll/runs/:id/calculate
  http.post(
    '/api/payroll/runs/:id/calculate',
    withAuth(async ({ user, params, request }) => {
      const role = roleOf(user.id)!;
      if (!hasPermission(role, 'payroll.run', 'organisation')) {
        return err(403, 'forbidden', 'Access denied.');
      }
      const id = String(params.id);
      const run = db.read().payrollRuns.find((r) => r.id === id);
      if (!run) return err(404, 'not_found', 'Run not found.');
      if (run.stage !== 'draft') {
        return err(409, 'not_draft', 'Only Draft runs can be recalculated.');
      }

      // Capture the statutory snapshot at period_start — locked to the run.
      const snap = snapshotAt(run.period_start, db.read().statutoryRates);
      const periodStartMonth = Number(run.period_start.split('-')[1]);

      // Rebuild items from scratch each Calculate.
      const activeEmps = db.read().employees.filter(
        (e) => e.status !== 'inactive' && !e.deleted_at && e.joining_date <= run.period_end,
      );

      const items: PayrollItem[] = [];
      let grossTotal = 0;
      let deductionsTotal = 0;
      let netTotal = 0;

      for (const emp of activeEmps) {
        const structure = structureEffective(emp.id, run.period_start);
        if (!structure) continue;
        const empAtt = db.read().attendance.filter(
          (a) => a.employee_id === emp.id && a.date >= run.period_start && a.date <= run.period_end,
        );
        const empLeaves = db.read().leaveRequests.filter(
          (l) => l.employee_id === emp.id && l.status === 'approved',
        );
        const attSum = summarize(empAtt, empLeaves, run.period_start, run.period_end);
        const calc = calculatePayrollItem({
          structure,
          attendance: attSum,
          snap,
          periodStartMonth,
        });
        const item: PayrollItem = {
          id: `pi-${run.id}-${emp.id}`,
          payroll_run_id: run.id,
          employee_id: emp.id,
          salary_structure_id: structure.id,
          payable_days: attSum.payable_days,
          present_days: attSum.present_days,
          on_leave_days: attSum.on_leave_days,
          absent_days: attSum.absent_days,
          lop_days: attSum.lop_days,
          earnings: calc.earnings,
          deductions: calc.deductions,
          gross_paise: calc.gross_paise,
          total_deductions_paise: calc.total_deductions_paise,
          net_paise: calc.net_paise,
          notes: null,
          created_at: nowISO(),
          updated_at: nowISO(),
          created_by: user.id,
          updated_by: user.id,
          deleted_at: null,
        };
        items.push(item);
        grossTotal += calc.gross_paise;
        deductionsTotal += calc.total_deductions_paise;
        netTotal += calc.net_paise;
      }

      // Atomic replace of items + run totals + snapshot.
      db.write((d) => {
        d.payrollItems = d.payrollItems.filter((i) => i.payroll_run_id !== run.id);
        d.payrollItems.push(...items);
        const r = d.payrollRuns.find((x) => x.id === run.id)!;
        r.statutory_snapshot = snap;
        r.headcount = items.length;
        r.gross_total_paise = grossTotal;
        r.deductions_total_paise = deductionsTotal;
        r.net_total_paise = netTotal;
        r.updated_at = nowISO();
        r.updated_by = user.id;
      });

      audit({ actor_user_id: user.id, action: 'payroll.calculated', entity_type: 'PayrollRun', entity_id: run.id, after_json: { items: items.length, gross: grossTotal, net: netTotal }, request });

      const fresh = db.read().payrollRuns.find((r) => r.id === id)!;
      return ok({ run: fresh, items });
    }),
  ),

  // POST /api/payroll/runs/:id/review
  http.post(
    '/api/payroll/runs/:id/review',
    withAuth(async ({ user, params, request }) => {
      const role = roleOf(user.id)!;
      if (!hasPermission(role, 'payroll.review', 'organisation')) {
        return err(403, 'forbidden', 'Only HR/MD can review.');
      }
      const id = String(params.id);
      const run = db.read().payrollRuns.find((r) => r.id === id);
      if (!run) return err(404, 'not_found', 'Run not found.');
      const allowed: PayrollStage[] = ['draft', 'hr_review'];
      if (!allowed.includes(run.stage)) {
        return err(409, 'wrong_stage', `Run is ${run.stage}; review not allowed.`);
      }
      if (run.headcount === 0) {
        return err(422, 'no_items', 'Calculate the run before submitting for review.');
      }
      const next: PayrollStage = run.stage === 'draft' ? 'hr_review' : 'finance_review';
      db.write((d) => {
        const r = d.payrollRuns.find((x) => x.id === id)!;
        r.stage = next;
        if (next === 'hr_review') r.reviewed_by = user.id;
        r.updated_at = nowISO();
        r.updated_by = user.id;
      });
      audit({ actor_user_id: user.id, action: `payroll.${next}`, entity_type: 'PayrollRun', entity_id: id, before_json: { stage: run.stage }, after_json: { stage: next }, request });
      return ok({ run: db.read().payrollRuns.find((r) => r.id === id) });
    }),
  ),

  // POST /api/payroll/runs/:id/approve — Finance
  http.post(
    '/api/payroll/runs/:id/approve',
    withAuth(async ({ user, params, request }) => {
      const role = roleOf(user.id)!;
      if (!hasPermission(role, 'payroll.approve', 'organisation')) {
        return err(403, 'forbidden', 'Only Finance/MD can approve.');
      }
      const id = String(params.id);
      const run = db.read().payrollRuns.find((r) => r.id === id);
      if (!run) return err(404, 'not_found', 'Run not found.');
      if (run.stage !== 'finance_review') {
        if (run.stage === 'processed') return err(409, 'already_processed', 'Run is Processed — immutable.');
        return err(409, 'wrong_stage', `Run is ${run.stage}; must be finance_review.`);
      }
      db.write((d) => {
        const r = d.payrollRuns.find((x) => x.id === id)!;
        r.stage = 'approved';
        r.approved_by = user.id;
        r.updated_at = nowISO();
        r.updated_by = user.id;
      });
      audit({ actor_user_id: user.id, action: 'payroll.approved', entity_type: 'PayrollRun', entity_id: id, before_json: { stage: run.stage }, after_json: { stage: 'approved' }, request });
      return ok({ run: db.read().payrollRuns.find((r) => r.id === id) });
    }),
  ),

  // POST /api/payroll/runs/:id/process — irreversible: payments + ledger + payslips
  http.post(
    '/api/payroll/runs/:id/process',
    withAuth(async ({ user, params, request }) => {
      const role = roleOf(user.id)!;
      if (!hasPermission(role, 'payroll.process', 'organisation')) {
        return err(403, 'forbidden', 'Only Finance/MD can process.');
      }
      const id = String(params.id);
      const run = db.read().payrollRuns.find((r) => r.id === id);
      if (!run) return err(404, 'not_found', 'Run not found.');
      if (run.stage === 'processed') return err(409, 'already_processed', 'Run is Processed — immutable.');
      if (run.stage !== 'approved') return err(409, 'wrong_stage', `Run is ${run.stage}; approve first.`);

      const items = db.read().payrollItems.filter((i) => i.payroll_run_id === id);
      const processedAt = nowISO();

      const payments: Payment[] = [];
      const payslips: Payslip[] = [];

      // Atomic write block — payments + ledger + payslips + run state.
      db.write((d) => {
        let running = d.ledger.reduce((acc, l) => acc + l.credit_paise - l.debit_paise, 0);
        for (const item of items) {
          const emp = d.employees.find((e) => e.id === item.employee_id);
          const payRef = `SIM-${item.payroll_run_id}-${item.employee_id}`;
          const payment: Payment = {
            id: `pay-${item.payroll_run_id}-${item.employee_id}`,
            employee_id: item.employee_id,
            payroll_run_id: item.payroll_run_id,
            expense_id: null,
            amount_paise: item.net_paise,
            method: 'mock',
            reference: payRef,
            status: 'completed',
            paid_at: processedAt,
            created_at: processedAt,
            updated_at: processedAt,
            created_by: user.id,
            updated_by: user.id,
            deleted_at: null,
          };
          d.payments.push(payment);
          payments.push(payment);

          const payslip: Payslip = {
            id: `ps-${item.payroll_run_id}-${item.employee_id}`,
            payroll_run_id: item.payroll_run_id,
            payroll_item_id: item.id,
            employee_id: item.employee_id,
            published_at: processedAt,
            file_key: `mock/payslips/${item.payroll_run_id}-${item.employee_id}.pdf`,
            status: 'published',
            created_at: processedAt,
            updated_at: processedAt,
            created_by: user.id,
            updated_by: user.id,
            deleted_at: null,
          };
          d.payslips.push(payslip);
          payslips.push(payslip);

          // Ledger: Payroll expense debit + Payment credit chain.
          running -= item.net_paise;
          d.ledger.push({
            id: `lt-${item.payroll_run_id}-payroll-${item.employee_id}`,
            date: run.period_end,
            type: 'Payroll',
            description: `Salary — ${emp?.full_name ?? item.employee_id}`,
            employee_id: item.employee_id,
            category: 'Payroll',
            debit_paise: item.net_paise,
            credit_paise: 0,
            running_balance_paise: running,
            reference_id: item.id,
            reference_type: 'PayrollItem',
            status: 'posted',
            created_at: processedAt,
            created_by: user.id,
          });

          // Notify each employee that their payslip is published.
          d.notifications.push({
            id: `ntf-${crypto.randomUUID()}`,
            user_id: d.users.find((u) => u.employee_id === item.employee_id)?.id ?? '',
            type: 'payroll.payslip_published',
            module: 'payroll',
            entity_type: 'Payslip',
            entity_id: payslip.id,
            title: 'Payslip published',
            body: `Your payslip for ${run.period_start.slice(0, 7)} is available.`,
            action_url: `/me/payslips`,
            is_read: false,
            created_at: processedAt,
          });
        }

        const r = d.payrollRuns.find((x) => x.id === id)!;
        r.stage = 'processed';
        r.processed_by = user.id;
        r.processed_at = processedAt;
        r.updated_at = processedAt;
        r.updated_by = user.id;
      });

      audit({ actor_user_id: user.id, action: 'payroll.processed', entity_type: 'PayrollRun', entity_id: id, after_json: { payments: payments.length, payslips: payslips.length }, request });
      return ok({ run: db.read().payrollRuns.find((r) => r.id === id), payments, payslips });
    }),
  ),

  // ── Payslips ────────────────────────────────────────────────────────────
  http.get(
    '/api/payroll/payslips',
    withAuth(async ({ user, employee, request }) => {
      const role = roleOf(user.id)!;
      const url = new URL(request.url);
      const employeeId = url.searchParams.get('employeeId');
      const runId = url.searchParams.get('runId');
      const canView = hasPermission(role, 'payroll.view', 'organisation');
      const canOwn = hasPermission(role, 'payroll.view.own', 'self');

      let rows = db.read().payslips.filter((p) => p.status === 'published');
      if (!canView) {
        if (!canOwn || !employee) return err(403, 'forbidden', 'Access denied.');
        rows = rows.filter((p) => p.employee_id === employee.id);
      }
      if (employeeId) {
        if (!canView && employee?.id !== employeeId) return err(403, 'forbidden', 'Access denied.');
        rows = rows.filter((p) => p.employee_id === employeeId);
      }
      if (runId) rows = rows.filter((p) => p.payroll_run_id === runId);

      const items = rows
        .sort((a, b) => (a.published_at < b.published_at ? 1 : -1))
        .map((p) => {
          const item = db.read().payrollItems.find((i) => i.id === p.payroll_item_id);
          const run = db.read().payrollRuns.find((r) => r.id === p.payroll_run_id);
          const emp = db.read().employees.find((e) => e.id === p.employee_id);
          return {
            ...p,
            period_start: run?.period_start ?? null,
            period_end: run?.period_end ?? null,
            gross_paise: item?.gross_paise ?? 0,
            net_paise: item?.net_paise ?? 0,
            employee: emp ? { id: emp.id, full_name: emp.full_name, employee_code: emp.employee_code } : null,
          };
        });
      return ok({ items });
    }),
  ),

  http.get(
    '/api/payroll/payslips/:id',
    withAuth(async ({ user, employee, params }) => {
      const role = roleOf(user.id)!;
      const id = String(params.id);
      const payslip = db.read().payslips.find((p) => p.id === id);
      if (!payslip || payslip.status !== 'published') return err(404, 'not_found', 'Payslip not found.');
      const canView = hasPermission(role, 'payroll.view', 'organisation');
      const isOwn = payslip.employee_id === employee?.id;
      if (!canView && !isOwn) return err(403, 'forbidden', 'Access denied.');

      const item = db.read().payrollItems.find((i) => i.id === payslip.payroll_item_id);
      const run = db.read().payrollRuns.find((r) => r.id === payslip.payroll_run_id);
      const emp = db.read().employees.find((e) => e.id === payslip.employee_id);
      const structure = item ? db.read().salaryStructures.find((s) => s.id === item.salary_structure_id) : null;
      const dept = emp ? db.read().departments.find((d) => d.id === emp.department_id) : null;
      const desig = emp ? db.read().designations.find((d) => d.id === emp.designation_id) : null;
      return ok({
        payslip,
        run,
        item,
        structure,
        employee: emp ? {
          id: emp.id,
          full_name: emp.full_name,
          employee_code: emp.employee_code,
          email: emp.email,
        } : null,
        department: dept ? { id: dept.id, name: dept.name } : null,
        designation: desig ? { id: desig.id, name: desig.name } : null,
      });
    }),
  ),

  http.get(
    '/api/payroll/payslips/:id/download-url',
    withAuth(async ({ user, employee, params }) => {
      const role = roleOf(user.id)!;
      const id = String(params.id);
      const payslip = db.read().payslips.find((p) => p.id === id);
      if (!payslip || payslip.status !== 'published') return err(404, 'not_found', 'Payslip not found.');
      const canView = hasPermission(role, 'payroll.view', 'organisation');
      const isOwn = payslip.employee_id === employee?.id;
      if (!canView && !isOwn) return err(403, 'forbidden', 'Access denied.');
      const tok = issuePdfToken(id, user.id);
      return ok({
        url: `/api/payroll/payslips/${id}/pdf?t=${encodeURIComponent(tok)}`,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
    }),
  ),

  http.get('/api/payroll/payslips/:id/pdf', async ({ request, params }) => {
    const id = String((params as { id: string }).id);
    const url = new URL(request.url);
    const tok = url.searchParams.get('t');
    if (!tok) return HttpResponse.json({ error: { code: 'missing_token', message: 'Token required.' } }, { status: 403 });
    const rec = verifyPdfToken(tok);
    if (!rec || rec.payslipId !== id) {
      return HttpResponse.json({ error: { code: 'invalid_token', message: 'Invalid or expired token.' } }, { status: 403 });
    }
    const payslip = db.read().payslips.find((p) => p.id === id);
    if (!payslip) return HttpResponse.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 });
    const item = db.read().payrollItems.find((i) => i.id === payslip.payroll_item_id);
    const run = db.read().payrollRuns.find((r) => r.id === payslip.payroll_run_id);
    const emp = db.read().employees.find((e) => e.id === payslip.employee_id);
    const body =
      `AUDIT OS\nPAYSLIP\n\n` +
      `Employee: ${emp?.full_name} (${emp?.employee_code})\n` +
      `Period:   ${run?.period_start} to ${run?.period_end}\n` +
      `\nEARNINGS\n` +
      `  Basic:            ${(item?.earnings.basic_paise ?? 0) / 100}\n` +
      `  HRA:              ${(item?.earnings.hra_paise ?? 0) / 100}\n` +
      `  Conveyance:       ${(item?.earnings.conveyance_paise ?? 0) / 100}\n` +
      `  Special Allow:    ${(item?.earnings.special_paise ?? 0) / 100}\n` +
      `  Incentive:        ${(item?.earnings.incentive_paise ?? 0) / 100}\n` +
      `                    -------\n` +
      `  Gross:            ${(item?.gross_paise ?? 0) / 100}\n\n` +
      `DEDUCTIONS\n` +
      `  PF (employee):    ${(item?.deductions.pf_employee_paise ?? 0) / 100}\n` +
      `  ESI (employee):   ${(item?.deductions.esi_employee_paise ?? 0) / 100}\n` +
      `  Professional Tax: ${(item?.deductions.pt_paise ?? 0) / 100}\n` +
      `  TDS:              ${(item?.deductions.tds_paise ?? 0) / 100}\n` +
      `  LOP:              ${(item?.deductions.lop_paise ?? 0) / 100}\n` +
      `  Advance:          ${(item?.deductions.advance_paise ?? 0) / 100}\n` +
      `                    -------\n` +
      `  Total ded:        ${(item?.total_deductions_paise ?? 0) / 100}\n\n` +
      `NET PAY:            ${(item?.net_paise ?? 0) / 100}\n\n` +
      `Generated: ${new Date().toISOString()}\n` +
      `Simulated payslip — no real payment processed.\n`;
    return new HttpResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="payslip-${emp?.employee_code}-${run?.period_start.slice(0, 7)}.txt"`,
      },
    });
  }),

  // ── Salary structure — HR/MD read-write, Finance read, Employee no ────
  http.get(
    '/api/employees/:id/salary',
    withAuth(async ({ user, params }) => {
      const role = roleOf(user.id)!;
      const canRead =
        hasPermission(role, 'salary.manage', 'organisation') ||
        hasPermission(role, 'payroll.view', 'organisation');
      if (!canRead) return err(403, 'forbidden', 'Access denied.');
      const id = String(params.id);
      const rows = db.read().salaryStructures.filter((s) => s.employee_id === id);
      const current = rows.find((s) => s.effective_to === null);
      return ok({ current, history: rows.sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1)) });
    }),
  ),

  http.patch(
    '/api/employees/:id/salary',
    withAuth(async ({ user, params, request }) => {
      const role = roleOf(user.id)!;
      if (!hasPermission(role, 'salary.manage', 'organisation')) {
        return err(403, 'forbidden', 'Only HR/MD can update salary.');
      }
      const id = String(params.id);
      const body = (await request.json().catch(() => ({}))) as {
        effective_from: string;
        monthly_ctc_paise?: number;
        basic_paise?: number;
        hra_paise?: number;
        conveyance_paise?: number;
        special_allowance_paise?: number;
      };
      if (!body.effective_from) return err(400, 'validation', 'effective_from required.');
      // Cap the currently-effective row.
      db.write((d) => {
        for (const s of d.salaryStructures) {
          if (s.employee_id === id && s.effective_to === null && s.effective_from < body.effective_from) {
            const prev = new Date(body.effective_from);
            prev.setUTCDate(prev.getUTCDate() - 1);
            s.effective_to = prev.toISOString().slice(0, 10);
            s.updated_at = nowISO();
            s.updated_by = user.id;
          }
        }
      });
      const cur = db.read().salaryStructures.find((s) => s.employee_id === id && s.effective_to === null);
      const row = {
        id: `ss-${crypto.randomUUID()}`,
        employee_id: id,
        effective_from: body.effective_from,
        effective_to: null,
        monthly_ctc_paise: body.monthly_ctc_paise ?? cur?.monthly_ctc_paise ?? 0,
        basic_paise: body.basic_paise ?? cur?.basic_paise ?? 0,
        hra_paise: body.hra_paise ?? cur?.hra_paise ?? 0,
        conveyance_paise: body.conveyance_paise ?? cur?.conveyance_paise ?? 0,
        special_allowance_paise: body.special_allowance_paise ?? cur?.special_allowance_paise ?? 0,
        custom_components: cur?.custom_components ?? [],
        notes: null,
        created_at: nowISO(),
        updated_at: nowISO(),
        created_by: user.id,
        updated_by: user.id,
        deleted_at: null,
      };
      db.write((d) => d.salaryStructures.push(row));
      audit({ actor_user_id: user.id, action: 'salary.updated', entity_type: 'SalaryStructure', entity_id: row.id, before_json: cur, after_json: row, request });
      return ok({ structure: row });
    }),
  ),
];
