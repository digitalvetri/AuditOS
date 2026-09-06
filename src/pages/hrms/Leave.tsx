/**
 * /hrms/leave — Balances · My requests · Queue (if approver).
 *
 * Queue tab appears only for callers with leave.approve at dept or org scope.
 * URL param `?tab=queue` deep-links from the dashboard widget.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { Button } from '@/components/Button';
import { BalancesCard } from '@/modules/leave/BalancesCard';
import { RequestsList } from '@/modules/leave/RequestsList';
import { LeaveApplyModal } from '@/modules/leave/LeaveApplyModal';

type Tab = 'balances' | 'mine' | 'queue';

export function LeavePage() {
  const { session } = useAuth();
  const [params, setParams] = useSearchParams();
  const canApprove =
    can(session?.role.code, 'leave.approve', 'department') ||
    can(session?.role.code, 'leave.approve', 'organisation');

  const initialTab: Tab =
    (params.get('tab') as Tab | null) === 'queue' && canApprove ? 'queue' : 'balances';
  const [tab, setTab] = useState<Tab>(initialTab);
  const [applyOpen, setApplyOpen] = useState(false);

  useEffect(() => {
    // Keep the URL in step so refresh preserves the tab.
    const current = params.get('tab');
    if (tab !== 'balances' && current !== tab) setParams({ tab }, { replace: true });
    if (tab === 'balances' && current) setParams({}, { replace: true });
  }, [tab, params, setParams]);

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">HRMS</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">Leave</h1>
        </div>
        <Button variant="primary" onClick={() => setApplyOpen(true)} data-testid="leave-apply-open">
          Apply for leave
        </Button>
      </header>

      <div className="border-b border-neutral-200 flex items-center gap-4">
        <TabBtn id="balances" active={tab === 'balances'} onClick={() => setTab('balances')}>
          Balances
        </TabBtn>
        <TabBtn id="mine" active={tab === 'mine'} onClick={() => setTab('mine')}>
          My requests
        </TabBtn>
        {canApprove ? (
          <TabBtn id="queue" active={tab === 'queue'} onClick={() => setTab('queue')}>
            Approvals queue
          </TabBtn>
        ) : null}
      </div>

      {tab === 'balances' ? <BalancesCard /> : null}
      {tab === 'mine' ? <RequestsList mode="mine" /> : null}
      {tab === 'queue' ? <RequestsList mode="queue" /> : null}

      <LeaveApplyModal open={applyOpen} onClose={() => setApplyOpen(false)} />
    </div>
  );
}

function TabBtn({
  id,
  active,
  onClick,
  children,
}: {
  id: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`leave-tab-${id}`}
      className={
        'h-10 px-1 text-13 -mb-px border-b-2 ' +
        (active
          ? 'border-gold text-neutral-900 font-medium'
          : 'border-transparent text-neutral-500 hover:text-neutral-900')
      }
    >
      {children}
    </button>
  );
}
