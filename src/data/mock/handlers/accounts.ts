/**
 * Accounts + Payments handlers per §8.6 + §9.
 *
 *   GET  /api/accounts/ledger       filtered list, running balance recomputed
 *   GET  /api/accounts/transactions alias
 *   GET  /api/accounts/summary      totals · by-type · this-month
 *   POST /api/accounts/ledger/:id/reverse   contra entry (append-only)
 *   GET  /api/payments              filtered list
 *   POST /api/payments              manual entry (Finance) → also writes ledger
 *
 * Append-only invariant: no PATCH, no DELETE. Corrections are contra entries.
 * `accounts.manage` (Finance) is required for mutations; `accounts.read` (MD)
 * plus `accounts.manage` are both accepted for reads.
 *
 * "Client accounting must never enter this module" (§8.6). We enforce by
 * NEVER accepting a client_id on any ledger or payment write — separate
 * namespace, not a naming convention.
 */

import { http } from 'msw';
import type {
  LedgerTransaction,
  Payment,
  RoleCode,
} from '@/data/models';
import { db } from '../db';
import { audit, err, ok, withAuth } from '../middleware';
import { hasPermission } from '@/platform/rbac/matrix';
import { istToday } from '@/lib/dates';

function roleOf(userId: string): RoleCode | null {
  const u = db.read().users.find((x) => x.id === userId);
  if (!u) return null;
  return db.read().roles.find((x) => x.id === u.role_id)?.code ?? null;
}
function canRead(role: RoleCode): boolean {
  return (
    hasPermission(role, 'accounts.manage', 'organisation') ||
    hasPermission(role, 'accounts.read', 'organisation')
  );
}
function canManage(role: RoleCode): boolean {
  return hasPermission(role, 'accounts.manage', 'organisation');
}
function canPayments(role: RoleCode): boolean {
  return hasPermission(role, 'payments.manage', 'organisation');
}

const LEDGER_TYPES: LedgerTransaction['type'][] = [
  'Payroll', 'Expense Reimbursement', 'Office Expense', 'Employee Advance', 'Advance Recovery', 'Payment',
];

const nowISO = () => new Date().toISOString();

/**
 * Recompute running balance on a filtered slice. The stored `running_balance`
 * is a snapshot at write-time in the full ledger; when the caller filters,
 * we recompute on the returned rows so the balance column reads intuitively
 * for that view.
 */
function withRunningBalance(rows: LedgerTransaction[]): LedgerTransaction[] {
  const sorted = [...rows].sort((a, b) =>
    a.created_at === b.created_at ? 0 : a.created_at < b.created_at ? -1 : 1,
  );
  let running = 0;
  return sorted.map((r) => {
    running += r.credit_paise - r.debit_paise;
    return { ...r, running_balance_paise: running };
  });
}

export const accountsHandlers = [
  // GET /api/accounts/ledger  (and /transactions alias)
  ...['/api/accounts/ledger', '/api/accounts/transactions'].map((path) =>
    http.get(
      path,
      withAuth(async ({ user, request }) => {
        const role = roleOf(user.id)!;
        if (!canRead(role)) return err(403, 'forbidden', 'Access denied.');
        const url = new URL(request.url);
        const type = url.searchParams.get('type') as LedgerTransaction['type'] | null;
        const employeeId = url.searchParams.get('employeeId');
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');

        let rows = db.read().ledger.filter((l) => l.status === 'posted' || l.status === 'reversed');
        if (type) rows = rows.filter((l) => l.type === type);
        if (employeeId) rows = rows.filter((l) => l.employee_id === employeeId);
        if (from) rows = rows.filter((l) => l.date >= from);
        if (to) rows = rows.filter((l) => l.date <= to);

        const items = withRunningBalance(rows).reverse(); // newest first
        // Enrich with employee display fields.
        const enriched = items.map((r) => {
          const emp = r.employee_id ? db.read().employees.find((e) => e.id === r.employee_id) : null;
          return {
            ...r,
            employee: emp ? { id: emp.id, full_name: emp.full_name, employee_code: emp.employee_code } : null,
          };
        });
        return ok({ items: enriched, count: enriched.length });
      }),
    ),
  ),

  // GET /api/accounts/summary
  http.get(
    '/api/accounts/summary',
    withAuth(async ({ user }) => {
      const role = roleOf(user.id)!;
      if (!canRead(role)) return err(403, 'forbidden', 'Access denied.');
      // Both `posted` and `reversed` rows count in totals — the `reversed`
      // status on an original ledger row is a marker meaning "a contra entry
      // exists for me", not "erase me from the books." The contra row itself
      // is a separate row with status='posted'. Together they net to zero.
      const all = db.read().ledger.filter((l) => l.status === 'posted' || l.status === 'reversed');
      const totalDebit = all.reduce((s, l) => s + l.debit_paise, 0);
      const totalCredit = all.reduce((s, l) => s + l.credit_paise, 0);
      const balance = totalCredit - totalDebit;

      const today = istToday();
      const monthPrefix = today.slice(0, 7);
      const thisMonth = all.filter((l) => l.date.startsWith(monthPrefix));
      const monthDebit = thisMonth.reduce((s, l) => s + l.debit_paise, 0);
      const monthCredit = thisMonth.reduce((s, l) => s + l.credit_paise, 0);

      const byType: { type: string; debit: number; credit: number; count: number }[] = [];
      for (const t of LEDGER_TYPES) {
        const rows = all.filter((l) => l.type === t);
        byType.push({
          type: t,
          debit: rows.reduce((s, l) => s + l.debit_paise, 0),
          credit: rows.reduce((s, l) => s + l.credit_paise, 0),
          count: rows.length,
        });
      }

      return ok({
        totals: { debit_paise: totalDebit, credit_paise: totalCredit, balance_paise: balance },
        this_month: { debit_paise: monthDebit, credit_paise: monthCredit },
        by_type: byType,
      });
    }),
  ),

  // POST /api/accounts/ledger/:id/reverse  — contra entry
  http.post(
    '/api/accounts/ledger/:id/reverse',
    withAuth(async ({ user, params, request }) => {
      const role = roleOf(user.id)!;
      if (!canManage(role)) return err(403, 'forbidden', 'Only Finance can reverse.');
      const id = String(params.id);
      const orig = db.read().ledger.find((l) => l.id === id);
      if (!orig) return err(404, 'not_found', 'Ledger row not found.');
      if (orig.status === 'reversed') return err(409, 'already_reversed', 'This row has already been reversed.');

      // Compute new running balance (append at end of ledger).
      const runningAfter = db.read().ledger.reduce((s, l) => s + l.credit_paise - l.debit_paise, 0)
        + (orig.debit_paise - orig.credit_paise); // reverse swaps debit/credit

      const reverse: LedgerTransaction = {
        id: `lt-rev-${crypto.randomUUID()}`,
        date: nowISO().slice(0, 10),
        type: orig.type,
        description: `Reversal — ${orig.description}`,
        employee_id: orig.employee_id,
        category: orig.category,
        debit_paise: orig.credit_paise,     // swap
        credit_paise: orig.debit_paise,     // swap
        running_balance_paise: runningAfter,
        reference_id: orig.id,
        reference_type: 'LedgerReversal',
        status: 'posted',
        created_at: nowISO(),
        created_by: user.id,
      };
      db.write((d) => {
        // Original stays intact — mark it reversed so it can't be reversed again.
        const o = d.ledger.find((l) => l.id === id)!;
        o.status = 'reversed';
        d.ledger.push(reverse);
      });
      audit({
        actor_user_id: user.id,
        action: 'accounts.ledger_reversed',
        entity_type: 'LedgerTransaction',
        entity_id: id,
        before_json: { status: orig.status },
        after_json: { reverse_id: reverse.id },
        request,
      });
      return ok({ original: { ...orig, status: 'reversed' }, reverse });
    }),
  ),

  // GET /api/payments
  http.get(
    '/api/payments',
    withAuth(async ({ user, request }) => {
      const role = roleOf(user.id)!;
      if (!canPayments(role)) return err(403, 'forbidden', 'Access denied.');
      const url = new URL(request.url);
      const employeeId = url.searchParams.get('employeeId');
      const status = url.searchParams.get('status');

      let rows = db.read().payments.filter((p) => !p.deleted_at);
      if (employeeId) rows = rows.filter((p) => p.employee_id === employeeId);
      if (status) rows = rows.filter((p) => p.status === status);
      rows = [...rows].sort((a, b) => (a.created_at > b.created_at ? -1 : 1));
      const items = rows.map((p) => {
        const emp = db.read().employees.find((e) => e.id === p.employee_id);
        return {
          ...p,
          employee: emp ? { id: emp.id, full_name: emp.full_name, employee_code: emp.employee_code } : null,
        };
      });
      return ok({ items, count: items.length });
    }),
  ),

  // POST /api/payments  — manual entry (advance, misc)
  http.post(
    '/api/payments',
    withAuth(async ({ user, request }) => {
      const role = roleOf(user.id)!;
      if (!canPayments(role)) return err(403, 'forbidden', 'Only Finance can record payments.');
      const body = (await request.json().catch(() => ({}))) as {
        employee_id?: string;
        amount_paise?: number;
        method?: Payment['method'];
        reference?: string;
        ledger_type?: LedgerTransaction['type'];
        description?: string;
      };
      if (!body.employee_id || typeof body.amount_paise !== 'number' || body.amount_paise <= 0) {
        return err(400, 'validation', 'employee_id and positive amount_paise required.');
      }
      const emp = db.read().employees.find((e) => e.id === body.employee_id);
      if (!emp) return err(422, 'invalid_employee', 'Unknown employee.');

      const ledgerType: LedgerTransaction['type'] = body.ledger_type ?? 'Employee Advance';
      if (!LEDGER_TYPES.includes(ledgerType)) return err(400, 'validation', 'unknown ledger_type');

      const now = nowISO();
      const paymentId = `pay-${crypto.randomUUID()}`;
      const ref = body.reference ?? `SIM-${paymentId}`;

      const payment: Payment = {
        id: paymentId,
        employee_id: body.employee_id,
        payroll_run_id: null,
        expense_id: null,
        amount_paise: body.amount_paise,
        method: body.method ?? 'mock',
        reference: ref,
        status: 'completed',
        paid_at: now,
        created_at: now,
        updated_at: now,
        created_by: user.id,
        updated_by: user.id,
        deleted_at: null,
      };

      // Atomic write — payment + matching ledger.
      db.write((d) => {
        d.payments.push(payment);
        const running = d.ledger.reduce((s, l) => s + l.credit_paise - l.debit_paise, 0) - body.amount_paise!;
        d.ledger.push({
          id: `lt-pay-${paymentId}`,
          date: now.slice(0, 10),
          type: ledgerType,
          description: body.description ?? `${ledgerType} — ${emp.full_name}`,
          employee_id: emp.id,
          category: ledgerType,
          debit_paise: body.amount_paise!,
          credit_paise: 0,
          running_balance_paise: running,
          reference_id: paymentId,
          reference_type: 'Payment',
          status: 'posted',
          created_at: now,
          created_by: user.id,
        });
      });
      audit({
        actor_user_id: user.id,
        action: 'payments.recorded',
        entity_type: 'Payment',
        entity_id: paymentId,
        after_json: { amount: body.amount_paise, type: ledgerType, employee_id: emp.id },
        request,
      });
      return ok({ payment });
    }),
  ),
];
