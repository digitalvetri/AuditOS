/**
 * /hrms/expenses — tabs: My expenses / Team queue (Dept Manager) / Finance queue (Finance).
 * HR gets a spec'd 403 at handler; UI shows an access-denied panel.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { Button } from '@/components/Button';
import { ExpensesTable } from '@/modules/expenses/ExpensesTable';
import { NewExpenseModal } from '@/modules/expenses/NewExpenseModal';

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
    <div className="max-w-[1200px] mx-auto space-y-6">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">HRMS</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">Expenses</h1>
        </div>
        {canSubmit ? (
          <Button variant="primary" onClick={() => setCreating(true)} data-testid="expense-new-open">
            New expense
          </Button>
        ) : null}
      </header>

      <div className="border-b border-neutral-200 flex items-center gap-4 flex-wrap">
        <TabBtn id="mine" active={tab === 'mine'} onClick={() => setActive('mine')}>My expenses</TabBtn>
        {canApproveDept || canApproveOrg ? (
          <TabBtn id="team" active={tab === 'team'} onClick={() => setActive('team')}>Team queue</TabBtn>
        ) : null}
        {canApproveOrg ? (
          <TabBtn id="finance" active={tab === 'finance'} onClick={() => setActive('finance')}>Finance queue</TabBtn>
        ) : null}
      </div>

      {tab === 'mine' ? <ExpensesTable mode="mine" /> : null}
      {tab === 'team' ? <ExpensesTable mode="team" /> : null}
      {tab === 'finance' ? <ExpensesTable mode="finance" /> : null}

      <NewExpenseModal open={creating} onClose={() => setCreating(false)} />
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
