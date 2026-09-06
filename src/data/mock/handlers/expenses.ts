/**
 * Expenses handlers per §8.5 + §9.
 *
 *   GET    /api/expenses                       scoped list
 *   POST   /api/expenses                       create as draft
 *   GET    /api/expenses/:id                   detail w/ approval history
 *   PATCH  /api/expenses/:id                   owner, draft only
 *   POST   /api/expenses/:id/submit            draft → pending_manager
 *   POST   /api/expenses/:id/approve           Manager (pending_manager → pending_finance)
 *                                              Finance (pending_finance → approved)
 *   POST   /api/expenses/:id/reject            Manager or Finance; reason required
 *   POST   /api/expenses/:id/pay               Finance only; approved → paid
 *                                              writes Payment + LedgerTransaction
 *
 * Every stage change: audit + notification + ExpenseApproval log row.
 *
 * On PAID: Payment + LedgerTransaction created ATOMICALLY (one db.write block).
 * The ledger is never written by hand for an expense (§8.5 rule).
 */

import { http } from 'msw';
import type {
  Expense,
  ExpenseApproval,
  ExpensePaymentMethod,
  ExpenseStage,
  Payment,
  RoleCode,
} from '@/data/models';
import { db } from '../db';
import { audit, err, ok, withAuth } from '../middleware';
import { hasPermission, type Scope } from '@/platform/rbac/matrix';

function roleOf(userId: string): RoleCode | null {
  const u = db.read().users.find((x) => x.id === userId);
  if (!u) return null;
  return db.read().roles.find((x) => x.id === u.role_id)?.code ?? null;
}

function findEmp(id: string) {
  return db.read().employees.find((e) => e.id === id);
}

function scopeForExpense(role: RoleCode): Scope | 'blocked' {
  // Finance/MD: org. Dept Manager: department. Employee: self. HR: no access.
  if (hasPermission(role, 'expense.manage', 'organisation')) return 'organisation';
  if (hasPermission(role, 'expense.approve', 'organisation')) return 'organisation';
  if (hasPermission(role, 'expense.approve', 'department')) return 'department';
  if (hasPermission(role, 'expense.submit', 'self')) return 'self';
  return 'blocked';
}

function canApproveManager(role: RoleCode): boolean {
  return hasPermission(role, 'expense.approve', 'department') || hasPermission(role, 'expense.approve', 'organisation');
}
function canApproveFinance(role: RoleCode): boolean {
  return hasPermission(role, 'expense.approve', 'organisation');
}
function canPay(role: RoleCode): boolean {
  return hasPermission(role, 'expense.pay', 'organisation');
}

const nowISO = () => new Date().toISOString();

function notify(
  userId: string,
  n: { type: string; title: string; body: string; entity_id?: string | null; action_url?: string | null },
): void {
  db.write((d) => {
    d.notifications.push({
      id: `ntf-${crypto.randomUUID()}`,
      user_id: userId,
      type: n.type,
      module: 'expense',
      entity_type: 'Expense',
      entity_id: n.entity_id ?? null,
      title: n.title,
      body: n.body,
      action_url: n.action_url ?? null,
      is_read: false,
      created_at: nowISO(),
    });
  });
}

function logApproval(exp: Expense, actorId: string, to: ExpenseStage, notes: string | null) {
  const row: ExpenseApproval = {
    id: `ea-${crypto.randomUUID()}`,
    expense_id: exp.id,
    actor_user_id: actorId,
    from_stage: exp.stage,
    to_stage: to,
    notes,
    created_at: nowISO(),
  };
  db.write((d) => d.expenseApprovals.push(row));
}

export const expenseHandlers = [
  // GET /api/expenses
  http.get(
    '/api/expenses',
    withAuth(async ({ user, employee, request }) => {
      const url = new URL(request.url);
      const stage = url.searchParams.get('stage') as ExpenseStage | null;
      const scopeFilter = url.searchParams.get('scope'); // 'mine' | 'team-queue' | 'finance-queue'
      const role = roleOf(user.id)!;
      const scope = scopeForExpense(role);
      if (scope === 'blocked') return err(403, 'forbidden', 'Access denied.');

      let rows = db.read().expenses.filter((e) => !e.deleted_at);
      if (scope === 'self') {
        if (!employee) return ok({ items: [], count: 0 });
        rows = rows.filter((e) => e.employee_id === employee.id);
      } else if (scope === 'department') {
        if (!employee) return ok({ items: [], count: 0 });
        const deptEmpIds = db.read().employees.filter((x) => x.department_id === employee.department_id).map((x) => x.id);
        // Dept Manager sees dept for review, plus their own for the "My" filter.
        rows = rows.filter((e) => deptEmpIds.includes(e.employee_id));
      }
      // organisation scope (Finance/MD): sees everything.

      if (scopeFilter === 'mine' && employee) {
        rows = rows.filter((e) => e.employee_id === employee.id);
      } else if (scopeFilter === 'team-queue' && employee) {
        // Direct reports OR same department, awaiting THIS manager stage.
        const deptEmpIds = db.read().employees.filter((x) => x.department_id === employee.department_id).map((x) => x.id);
        rows = rows.filter((e) => e.stage === 'pending_manager' && deptEmpIds.includes(e.employee_id));
      } else if (scopeFilter === 'finance-queue') {
        // Finance sees approved-unpaid + pending_finance.
        rows = rows.filter((e) => e.stage === 'pending_finance' || e.stage === 'approved');
      }
      if (stage) rows = rows.filter((e) => e.stage === stage);

      rows = [...rows].sort((a, b) => (a.created_at > b.created_at ? -1 : 1));
      const items = rows.map((e) => {
        const emp = findEmp(e.employee_id);
        const cat = db.read().expenseCategories.find((c) => c.id === e.category_id);
        return {
          ...e,
          employee: emp ? { id: emp.id, full_name: emp.full_name, employee_code: emp.employee_code, department_id: emp.department_id } : null,
          category: cat ? { id: cat.id, name: cat.name, code: cat.code } : null,
        };
      });
      return ok({ items, count: items.length, scope });
    }),
  ),

  // POST /api/expenses — create as draft
  http.post(
    '/api/expenses',
    withAuth(async ({ user, employee, request }) => {
      if (!employee) return err(422, 'no_employee', 'This account has no employee record.');
      const body = (await request.json().catch(() => ({}))) as Partial<Expense>;
      if (!body.title?.trim() || !body.category_id || typeof body.amount_paise !== 'number' || !body.expense_date) {
        return err(400, 'validation', 'title, category_id, amount_paise, expense_date required.');
      }
      if (body.amount_paise <= 0) return err(422, 'amount', 'Amount must be positive.');
      const cat = db.read().expenseCategories.find((c) => c.id === body.category_id);
      if (!cat) return err(400, 'invalid_category', 'Unknown expense category.');
      if (!cat.is_active) return err(422, 'inactive_category', 'This category is inactive.');
      const row: Expense = {
        id: `exp-${crypto.randomUUID()}`,
        employee_id: employee.id,
        category_id: cat.id,
        title: body.title.trim(),
        amount_paise: body.amount_paise,
        expense_date: body.expense_date,
        description: body.description ?? '',
        payment_method: (body.payment_method ?? 'card') as ExpensePaymentMethod,
        receipt_file_key: body.receipt_file_key ?? null,
        notes: body.notes ?? null,
        stage: 'draft',
        submitted_at: null,
        manager_approved_by: null,
        manager_approved_at: null,
        finance_approved_by: null,
        finance_approved_at: null,
        paid_at: null,
        payment_id: null,
        rejection_reason: null,
        rejected_by: null,
        rejected_at: null,
        client_id: null,
        created_at: nowISO(),
        updated_at: nowISO(),
        created_by: user.id,
        updated_by: user.id,
        deleted_at: null,
      };
      db.write((d) => d.expenses.push(row));
      audit({ actor_user_id: user.id, action: 'expense.created', entity_type: 'Expense', entity_id: row.id, after_json: { title: row.title, amount: row.amount_paise }, request });
      return ok({ expense: row });
    }),
  ),

  // GET /api/expenses/:id
  http.get(
    '/api/expenses/:id',
    withAuth(async ({ user, employee, params }) => {
      const id = String(params.id);
      const exp = db.read().expenses.find((e) => e.id === id);
      if (!exp) return err(404, 'not_found', 'Expense not found.');
      const role = roleOf(user.id)!;
      const scope = scopeForExpense(role);
      if (scope === 'blocked') return err(403, 'forbidden', 'Access denied.');
      const target = findEmp(exp.employee_id);
      const allowed =
        scope === 'organisation' ||
        (scope === 'department' && target?.department_id === employee?.department_id) ||
        (scope === 'self' && employee?.id === exp.employee_id);
      if (!allowed) return err(403, 'forbidden', 'Access denied.');

      const cat = db.read().expenseCategories.find((c) => c.id === exp.category_id);
      const approvals = db.read().expenseApprovals.filter((a) => a.expense_id === exp.id).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      return ok({
        expense: { ...exp, employee: target ? { id: target.id, full_name: target.full_name, employee_code: target.employee_code } : null, category: cat ? { id: cat.id, name: cat.name, code: cat.code } : null },
        approvals,
      });
    }),
  ),

  // PATCH /api/expenses/:id — draft only, owner
  http.patch(
    '/api/expenses/:id',
    withAuth(async ({ user, employee, params, request }) => {
      const id = String(params.id);
      const exp = db.read().expenses.find((e) => e.id === id);
      if (!exp) return err(404, 'not_found', 'Expense not found.');
      if (exp.stage !== 'draft') return err(409, 'not_draft', 'Only Draft expenses can be edited.');
      if (!employee || exp.employee_id !== employee.id) return err(403, 'forbidden', 'Only the claimant can edit.');

      const body = (await request.json().catch(() => ({}))) as Partial<Expense>;
      const editable = ['title', 'category_id', 'amount_paise', 'expense_date', 'description', 'payment_method', 'receipt_file_key', 'notes'] as const;
      const disallowed = Object.keys(body).filter((k) => !(editable as readonly string[]).includes(k));
      if (disallowed.length) return err(422, 'unknown_fields', 'Unknown fields.', { disallowed });

      const before = { ...exp };
      db.write((d) => {
        const t = d.expenses.find((x) => x.id === id)!;
        for (const [k, v] of Object.entries(body)) (t as unknown as Record<string, unknown>)[k] = v;
        t.updated_at = nowISO();
        t.updated_by = user.id;
      });
      audit({ actor_user_id: user.id, action: 'expense.updated', entity_type: 'Expense', entity_id: id, before_json: before, after_json: db.read().expenses.find((e) => e.id === id), request });
      return ok({ expense: db.read().expenses.find((e) => e.id === id) });
    }),
  ),

  // POST /api/expenses/:id/submit
  http.post(
    '/api/expenses/:id/submit',
    withAuth(async ({ user, employee, params, request }) => {
      const id = String(params.id);
      const exp = db.read().expenses.find((e) => e.id === id);
      if (!exp) return err(404, 'not_found', 'Expense not found.');
      if (!employee || exp.employee_id !== employee.id) return err(403, 'forbidden', 'Only the claimant can submit.');
      if (exp.stage !== 'draft') return err(409, 'not_draft', 'Only Draft expenses can be submitted.');

      const from = exp.stage;
      db.write((d) => {
        const t = d.expenses.find((x) => x.id === id)!;
        t.stage = 'pending_manager';
        t.submitted_at = nowISO();
        t.updated_at = nowISO();
        t.updated_by = user.id;
      });
      logApproval(exp, user.id, 'pending_manager', null);
      audit({ actor_user_id: user.id, action: 'expense.submitted', entity_type: 'Expense', entity_id: id, before_json: { stage: from }, after_json: { stage: 'pending_manager' }, request });

      // Notify manager.
      const mgr = employee.manager_id ? findEmp(employee.manager_id) : null;
      const mgrUser = mgr ? db.read().users.find((u) => u.employee_id === mgr.id) : null;
      if (mgrUser) {
        notify(mgrUser.id, {
          type: 'expense.submitted',
          title: 'Expense to review',
          body: `${employee.full_name} — ${exp.title} · ₹${(exp.amount_paise / 100).toLocaleString('en-IN')}`,
          entity_id: id,
          action_url: '/hrms/expenses?tab=team',
        });
      }
      return ok({ expense: db.read().expenses.find((e) => e.id === id) });
    }),
  ),

  // POST /api/expenses/:id/approve
  http.post(
    '/api/expenses/:id/approve',
    withAuth(async ({ user, employee, params, request }) => {
      const id = String(params.id);
      const exp = db.read().expenses.find((e) => e.id === id);
      if (!exp) return err(404, 'not_found', 'Expense not found.');
      const role = roleOf(user.id)!;
      const target = findEmp(exp.employee_id);

      let next: ExpenseStage;
      if (exp.stage === 'pending_manager') {
        // Manager (dept) OR Finance/MD (org).
        const dept = canApproveManager(role) && target?.department_id === employee?.department_id;
        const org = canApproveFinance(role);
        if (!dept && !org) return err(403, 'forbidden', 'Only the department manager (or Finance/MD) can approve at this stage.');
        next = 'pending_finance';
      } else if (exp.stage === 'pending_finance') {
        if (!canApproveFinance(role)) return err(403, 'forbidden', 'Only Finance/MD can approve at this stage.');
        next = 'approved';
      } else {
        return err(409, 'wrong_stage', `Expense is ${exp.stage}; cannot approve.`);
      }

      const from = exp.stage;
      const nowStamp = nowISO();
      db.write((d) => {
        const t = d.expenses.find((x) => x.id === id)!;
        t.stage = next;
        if (next === 'pending_finance') {
          t.manager_approved_by = user.id;
          t.manager_approved_at = nowStamp;
        } else if (next === 'approved') {
          t.finance_approved_by = user.id;
          t.finance_approved_at = nowStamp;
        }
        t.updated_at = nowStamp;
        t.updated_by = user.id;
      });
      logApproval(exp, user.id, next, null);
      audit({ actor_user_id: user.id, action: `expense.${next}`, entity_type: 'Expense', entity_id: id, before_json: { stage: from }, after_json: { stage: next }, request });

      // Notify claimant.
      const claimantUser = target ? db.read().users.find((u) => u.employee_id === target.id) : null;
      if (claimantUser) {
        notify(claimantUser.id, {
          type: `expense.${next}`,
          title: next === 'pending_finance' ? 'Expense manager-approved' : 'Expense finance-approved',
          body: `${exp.title} → ${next.replace('_', ' ')}`,
          entity_id: id,
          action_url: '/hrms/expenses',
        });
      }
      // Notify Finance when it lands in their queue.
      if (next === 'pending_finance') {
        const finUsers = db.read().users.filter((u) => db.read().roles.find((r) => r.id === u.role_id)?.code === 'finance_admin');
        for (const f of finUsers) {
          notify(f.id, {
            type: 'expense.pending_finance',
            title: 'Expense awaiting Finance',
            body: `${target?.full_name ?? 'Someone'} — ${exp.title}`,
            entity_id: id,
            action_url: '/hrms/expenses?tab=finance',
          });
        }
      }

      return ok({ expense: db.read().expenses.find((e) => e.id === id) });
    }),
  ),

  // POST /api/expenses/:id/reject
  http.post(
    '/api/expenses/:id/reject',
    withAuth(async ({ user, employee, params, request }) => {
      const id = String(params.id);
      const exp = db.read().expenses.find((e) => e.id === id);
      if (!exp) return err(404, 'not_found', 'Expense not found.');
      if (exp.stage !== 'pending_manager' && exp.stage !== 'pending_finance') {
        return err(409, 'wrong_stage', 'Only pending expenses can be rejected.');
      }
      const role = roleOf(user.id)!;
      const target = findEmp(exp.employee_id);
      const canReject =
        (exp.stage === 'pending_manager' && (canApproveFinance(role) || (canApproveManager(role) && target?.department_id === employee?.department_id))) ||
        (exp.stage === 'pending_finance' && canApproveFinance(role));
      if (!canReject) return err(403, 'forbidden', 'Access denied.');
      const body = (await request.json().catch(() => ({}))) as { reason?: string };
      const reason = body.reason?.trim();
      if (!reason) return err(400, 'validation', 'A reason is required.');

      const from = exp.stage;
      const nowStamp = nowISO();
      db.write((d) => {
        const t = d.expenses.find((x) => x.id === id)!;
        t.stage = 'rejected';
        t.rejection_reason = reason;
        t.rejected_by = user.id;
        t.rejected_at = nowStamp;
        t.updated_at = nowStamp;
        t.updated_by = user.id;
      });
      logApproval(exp, user.id, 'rejected', reason);
      audit({ actor_user_id: user.id, action: 'expense.rejected', entity_type: 'Expense', entity_id: id, before_json: { stage: from }, after_json: { stage: 'rejected', reason }, request });

      const claimantUser = target ? db.read().users.find((u) => u.employee_id === target.id) : null;
      if (claimantUser) {
        notify(claimantUser.id, {
          type: 'expense.rejected',
          title: 'Expense rejected',
          body: `${exp.title}: ${reason}`,
          entity_id: id,
          action_url: '/hrms/expenses',
        });
      }
      return ok({ expense: db.read().expenses.find((e) => e.id === id) });
    }),
  ),

  // POST /api/expenses/:id/pay — Finance only
  http.post(
    '/api/expenses/:id/pay',
    withAuth(async ({ user, params, request }) => {
      const id = String(params.id);
      const exp = db.read().expenses.find((e) => e.id === id);
      if (!exp) return err(404, 'not_found', 'Expense not found.');
      const role = roleOf(user.id)!;
      if (!canPay(role)) return err(403, 'forbidden', 'Only Finance/MD can pay.');
      if (exp.stage === 'paid') return err(409, 'already_paid', 'Expense is already Paid.');
      if (exp.stage !== 'approved') return err(409, 'wrong_stage', `Expense is ${exp.stage}; must be Approved.`);

      const nowStamp = nowISO();
      const paymentId = `pay-exp-${exp.id}`;
      const target = findEmp(exp.employee_id);

      // Atomic write — payment + ledger + expense stage. Real backend = a transaction.
      db.write((d) => {
        const t = d.expenses.find((x) => x.id === id)!;
        t.stage = 'paid';
        t.paid_at = nowStamp;
        t.payment_id = paymentId;
        t.updated_at = nowStamp;
        t.updated_by = user.id;

        const payment: Payment = {
          id: paymentId,
          employee_id: exp.employee_id,
          payroll_run_id: null,
          expense_id: exp.id,
          amount_paise: exp.amount_paise,
          method: 'mock',
          reference: `SIM-EXP-${exp.id}`,
          status: 'completed',
          paid_at: nowStamp,
          created_at: nowStamp,
          updated_at: nowStamp,
          created_by: user.id,
          updated_by: user.id,
          deleted_at: null,
        };
        d.payments.push(payment);

        const running = d.ledger.reduce((s, l) => s + l.credit_paise - l.debit_paise, 0) - exp.amount_paise;
        d.ledger.push({
          id: `lt-exp-${exp.id}`,
          date: nowStamp.slice(0, 10),
          type: 'Expense Reimbursement',
          description: `Reimbursement — ${exp.title}`,
          employee_id: exp.employee_id,
          category: 'Expense',
          debit_paise: exp.amount_paise,
          credit_paise: 0,
          running_balance_paise: running,
          reference_id: exp.id,
          reference_type: 'Expense',
          status: 'posted',
          created_at: nowStamp,
          created_by: user.id,
        });
      });
      logApproval(exp, user.id, 'paid', null);
      audit({ actor_user_id: user.id, action: 'expense.paid', entity_type: 'Expense', entity_id: id, before_json: { stage: 'approved' }, after_json: { stage: 'paid', payment_id: paymentId }, request });

      const claimantUser = target ? db.read().users.find((u) => u.employee_id === target.id) : null;
      if (claimantUser) {
        notify(claimantUser.id, {
          type: 'expense.paid',
          title: 'Expense reimbursed',
          body: `${exp.title} — ₹${(exp.amount_paise / 100).toLocaleString('en-IN')} paid.`,
          entity_id: id,
          action_url: '/hrms/expenses',
        });
      }
      return ok({ expense: db.read().expenses.find((e) => e.id === id), payment_id: paymentId });
    }),
  ),
];
