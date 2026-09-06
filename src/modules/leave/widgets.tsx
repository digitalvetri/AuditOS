/**
 * Leave dashboard widgets.
 *
 *   Employee secondary : balance chips
 *   Manager/HR queue   : aggregated "pending approvals" count (single item)
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { registerWidget } from '@/platform/dashboard/registry';
import { BalancesCard } from './BalancesCard';
import { leaveApi } from './api';

function PendingApprovalsWidget() {
  const q = useQuery({
    queryKey: ['leaves', 'queue'],
    queryFn: () => leaveApi.list({ queue: true }),
  });
  const count = q.data?.items.length ?? 0;
  return (
    <div>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">
        Leave approvals
      </div>
      <div className="mt-1 flex items-baseline justify-between tabular-nums">
        <div className={'text-28 ' + (count > 0 ? 'text-neutral-900 font-semibold' : 'text-neutral-500')}>
          {count}
        </div>
        <Link
          to="/hrms/leave?tab=queue"
          className="text-13 text-gold hover:text-gold-hover"
          data-testid="leave-queue-link"
        >
          Open queue →
        </Link>
      </div>
      <div className="text-11 text-neutral-500 mt-1">
        {count === 0 ? 'Nothing needs your attention.' : `${count} pending`}
      </div>
    </div>
  );
}

registerWidget({
  id: 'hrms.leave-balances',
  slot: 'secondary',
  roles: ['employee', 'dept_manager', 'hr_admin', 'md'],
  scope: 'self',
  component: BalancesCard,
  order: 10,
});

registerWidget({
  id: 'hrms.leave-approvals',
  slot: 'queue',
  roles: ['dept_manager', 'hr_admin', 'md'],
  scope: 'department',
  component: PendingApprovalsWidget,
  order: 10,
});
