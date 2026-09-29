/**
 * /hrms/expenses — tabs: My expenses / Team queue (Dept Manager) / Finance queue (Finance).
 * HR gets a spec'd 403 at handler; UI shows an access-denied panel.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { Button } from '@/components/Button';
import { ExpensesTable } from '@/modules/expenses/ExpensesTable';
import { NewExpenseModal } from '@/modules/expenses/NewExpenseModal';
import { expensesApi } from '@/modules/expenses/api';
import { inr } from '@/lib/format';

type Tab = 'mine' | 'team' | 'finance';

export function ExpensesPage() {
  const { session } = useAuth();
  const canSubmit = can(session?.role.code, 'expense.submit', 'self');
  const canApproveDept = can(session?.role.code, 'expense.approve', 'department');
  const canApproveOrg = can(session?.role.code, 'expense.approve', 'organisation');
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab') as Tab | null;
  const initialTab: Tab = tabParam ?? 'mine';
  const [tab, setTab] = useState<Tab>(initialTab);
  const [creating, setCreating] = useState(false);

  const setActive = (t: Tab) => {
    setTab(t);
    if (t === 'mine') setParams({}, { replace: true });
    else setParams({ tab: t }, { replace: true });
  };

  return (
    <div className="space-y-4">
      {canSubmit ? (
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => setCreating(true)} data-testid="expense-new-open">
            New expense
          </Button>
        </div>
      ) : null}

      <div className="border-b border-neutral-200 flex items-center gap-4 flex-wrap">
        <TabBtn id="mine" active={tab === 'mine'} onClick={() => setActive('mine')}>My expenses</TabBtn>
        {canApproveDept || canApproveOrg ? (
          <TabBtn id="team" active={tab === 'team'} onClick={() => setActive('team')}>Team queue</TabBtn>
        ) : null}
        {canApproveOrg ? (
          <TabBtn id="finance" active={tab === 'finance'} onClick={() => setActive('finance')}>Finance queue</TabBtn>
        ) : null}
      </div>

      {tab === 'finance' ? <SelfApprovedStrip /> : null}
      {tab === 'mine' ? <ExpensesTable mode="mine" /> : null}
      {tab === 'team' ? <ExpensesTable mode="team" /> : null}
      {tab === 'finance' ? <ExpensesTable mode="finance" /> : null}

      <NewExpenseModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function SelfApprovedStrip() {
  const q = useQuery({
    queryKey: ['expenses', 'self-approved-report'],
    queryFn: () => expensesApi.selfApprovedReport(),
    retry: false,
  });
  if (q.isLoading || q.isError || !q.data) return null;
  const { count, total_paise } = q.data;
  if (count === 0) return null;
  return (
    <div
      className="bg-white border border-neutral-200 rounded px-4 py-3 border-l-2 border-l-gold"
      data-testid="self-approved-report"
    >
      <div className="text-13 text-neutral-900">
        <span className="font-medium">{count}</span> claim{count === 1 ? '' : 's'} where the approver or payer is the claimant.
        {' '}Total <span className="font-medium">{inr(total_paise)}</span>.
      </div>
      <div className="text-11 text-neutral-500 mt-1">
        Not blocked — the partner approving their own claim is ordinary in a small firm — but recorded here for peer review.
      </div>
    </div>
  );
}

function TabBtn({ id, active, onClick, children }: { id: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`expense-tab-${id}`}
      className={
        'h-10 px-1 text-13 -mb-px border-b-2 ' +
        (active ? 'border-gold text-neutral-900 font-medium' : 'border-transparent text-neutral-500 hover:text-neutral-900')
      }
    >
      {children}
    </button>
  );
}
