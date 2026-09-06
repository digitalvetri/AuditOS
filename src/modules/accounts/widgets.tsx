/**
 * Accounts dashboard widget — Finance/MD primary slot.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { registerWidget } from '@/platform/dashboard/registry';
import { accountsApi } from './api';
import { inr } from '@/lib/format';

function LedgerBalanceWidget() {
  const q = useQuery({
    queryKey: ['accounts', 'summary'],
    queryFn: accountsApi.summary,
    retry: false,
  });
  if (q.isError) return <div className="text-13 text-neutral-500">Ledger unavailable.</div>;
  if (q.isLoading || !q.data) return <div className="h-20 bg-neutral-100" />;
  const s = q.data;
  return (
    <div data-testid="ledger-balance-widget">
      <div className="flex items-baseline justify-between">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Ledger</div>
        <Link to="/hrms/accounts" className="text-11 text-gold hover:text-gold-hover">Open →</Link>
      </div>
      <div className="mt-2 text-20 text-neutral-900 tabular-nums font-semibold">
        {inr(s.totals.balance_paise)}
      </div>
      <div className="text-11 text-neutral-500 mt-1 tabular-nums">
        This month · debit {inr(s.this_month.debit_paise)} · credit {inr(s.this_month.credit_paise)}
      </div>
    </div>
  );
}

registerWidget({
  id: 'accounts.ledger-balance',
  slot: 'primary',
  roles: ['finance_admin', 'md'],
  scope: 'organisation',
  component: LedgerBalanceWidget,
  order: 25,
});
