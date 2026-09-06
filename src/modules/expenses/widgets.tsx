/**
 * Expense dashboard widgets — fills the Finance Admin dashboard per §6.2.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { registerWidget } from '@/platform/dashboard/registry';
import { expensesApi } from './api';
import { inr } from '@/lib/format';

function FinanceExpensesWidget() {
  const q = useQuery({
    queryKey: ['expenses', 'finance-widget'],
    queryFn: () => expensesApi.list({ scope: 'finance-queue' }),
    retry: false,
  });
  if (q.isError) return <div className="text-13 text-neutral-500">Expenses unavailable.</div>;
  const items = q.data?.items ?? [];
  const pending = items.filter((e) => e.stage === 'pending_finance');
  const approvedUnpaid = items.filter((e) => e.stage === 'approved');
  const approvedTotal = approvedUnpaid.reduce((s, e) => s + e.amount_paise, 0);
  return (
    <div data-testid="finance-expenses-widget">
      <div className="flex items-baseline justify-between">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Expenses to action</div>
        <Link to="/hrms/expenses?tab=finance" className="text-11 text-gold hover:text-gold-hover">Open queue →</Link>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 tabular-nums">
        <div>
          <div className="text-11 text-neutral-500">Awaiting approval</div>
          <div className={'text-20 mt-1 ' + (pending.length > 0 ? 'text-neutral-900 font-semibold' : 'text-neutral-500')}>{pending.length}</div>
        </div>
        <div>
          <div className="text-11 text-neutral-500">Approved / unpaid</div>
          <div className={'text-20 mt-1 ' + (approvedUnpaid.length > 0 ? 'text-neutral-900 font-semibold' : 'text-neutral-500')}>{approvedUnpaid.length}</div>
          <div className="text-11 text-neutral-500 mt-1">{inr(approvedTotal)}</div>
        </div>
      </div>
    </div>
  );
}

function EmployeeExpensesWidget() {
  const q = useQuery({
    queryKey: ['expenses', 'mine-widget'],
    queryFn: () => expensesApi.list({ scope: 'mine' }),
    retry: false,
  });
  if (q.isError) return <div className="text-13 text-neutral-500">Expenses unavailable.</div>;
  const items = q.data?.items ?? [];
  if (items.length === 0) {
    return (
      <div>
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">My expenses</div>
        <div className="text-13 text-neutral-500 mt-2">No expenses submitted yet.</div>
      </div>
    );
  }
  const claimed = items.filter((e) => e.stage !== 'draft' && e.stage !== 'rejected').reduce((s, e) => s + e.amount_paise, 0);
  const reimbursed = items.filter((e) => e.stage === 'paid').reduce((s, e) => s + e.amount_paise, 0);
  const drafts = items.filter((e) => e.stage === 'draft').length;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">My expenses</div>
        <Link to="/hrms/expenses" className="text-11 text-gold hover:text-gold-hover">Open →</Link>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 tabular-nums">
        <div>
          <div className="text-11 text-neutral-500">Claimed</div>
          <div className="text-16 text-neutral-900 mt-1">{inr(claimed)}</div>
        </div>
        <div>
          <div className="text-11 text-neutral-500">Reimbursed</div>
          <div className="text-16 text-neutral-900 mt-1">{inr(reimbursed)}</div>
        </div>
      </div>
      {drafts > 0 ? (
        <div className="text-11 text-amber mt-2">{drafts} draft{drafts === 1 ? '' : 's'} awaiting submission</div>
      ) : null}
    </div>
  );
}

registerWidget({
  id: 'expenses.finance',
  slot: 'primary',
  roles: ['finance_admin', 'md'],
  scope: 'organisation',
  component: FinanceExpensesWidget,
  order: 15,
});

registerWidget({
  id: 'expenses.mine',
  slot: 'secondary',
  roles: ['employee', 'dept_manager', 'hr_admin', 'finance_admin', 'md'],
  scope: 'self',
  component: EmployeeExpensesWidget,
  order: 20,
});
