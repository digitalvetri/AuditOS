/**
 * /hrms/accounts — Ledger + Payments + Summary tabs per §8.6.
 *
 * Rules from spec that this page honours:
 *   - append-only ledger (no PATCH, no DELETE — Reverse creates a contra entry)
 *   - "Simulated payment — no bank integration." disclaimer on Payments tab
 *   - Finance-only for reads + mutations; MD read-only; everyone else 403
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { accountsApi, LEDGER_TYPES, type LedgerRowWithEmp } from '@/modules/accounts/api';
import { NewPaymentModal } from '@/modules/accounts/NewPaymentModal';
import { fmtDate, fmtDateTime, inr } from '@/lib/format';
import { StatusLabel, type StatusVariant } from '@/components/StatusRow';

type Tab = 'ledger' | 'payments' | 'summary';

export function AccountsPage() {
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'accounts.manage', 'organisation');
  const canRead = canManage || can(session?.role.code, 'accounts.read', 'organisation');
  const [params, setParams] = useSearchParams();
  const initialTab = (params.get('tab') as Tab | null) ?? 'summary';
  const [tab, setTab] = useState<Tab>(initialTab);
  const [newPay, setNewPay] = useState(false);

  const setActive = (t: Tab) => {
    setTab(t);
    if (t === 'summary') setParams({}, { replace: true });
    else setParams({ tab: t }, { replace: true });
  };

  if (!canRead) {
    return (
      <div className="max-w-[720px] mx-auto bg-white border border-neutral-200 rounded p-6">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Access denied</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">
          Accounts is Finance / MD only.
        </h1>
        <p className="text-13 text-neutral-500 mt-2">
          §8.6: internal Audit OS finance. Client accounting never appears here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">HRMS</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">Accounts</h1>
          <p className="text-13 text-neutral-500 mt-1">
            Internal Audit OS finance. Append-only ledger — corrections are contra entries.
          </p>
        </div>
        {canManage && tab === 'payments' ? (
          <Button variant="primary" onClick={() => setNewPay(true)} data-testid="new-payment">
            New payment
          </Button>
        ) : null}
      </header>

      <div className="border-b border-neutral-200 flex items-center gap-4 flex-wrap">
        <TabBtn id="summary" active={tab === 'summary'} onClick={() => setActive('summary')}>Summary</TabBtn>
        <TabBtn id="ledger" active={tab === 'ledger'} onClick={() => setActive('ledger')}>Ledger</TabBtn>
        <TabBtn id="payments" active={tab === 'payments'} onClick={() => setActive('payments')}>Payments</TabBtn>
      </div>

      {tab === 'summary' ? <SummarySection /> : null}
      {tab === 'ledger' ? <LedgerSection canManage={canManage} /> : null}
      {tab === 'payments' ? <PaymentsSection /> : null}

      <NewPaymentModal open={newPay} onClose={() => setNewPay(false)} />
    </div>
  );
}

function TabBtn({ id, active, onClick, children }: { id: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`accounts-tab-${id}`}
      className={
        'h-10 px-1 text-13 -mb-px border-b-2 ' +
        (active ? 'border-gold text-neutral-900 font-medium' : 'border-transparent text-neutral-500 hover:text-neutral-900')
      }
    >
      {children}
    </button>
  );
}

// ── Summary ───────────────────────────────────────────────────────────────
function SummarySection() {
  const q = useQuery({ queryKey: ['accounts', 'summary'], queryFn: accountsApi.summary });
  if (q.isLoading) return <div className="h-40 bg-neutral-100" />;
  if (q.isError || !q.data) return <div className="text-13 text-red">Could not load summary.</div>;
  const s = q.data;
  return (
    <div className="space-y-6" data-testid="accounts-summary">
      <div className="bg-white border border-neutral-200 rounded p-4 grid grid-cols-2 md:grid-cols-3 gap-4 tabular-nums">
        <Kpi label="Total debit" value={inr(s.totals.debit_paise)} />
        <Kpi label="Total credit" value={inr(s.totals.credit_paise)} />
        <Kpi label="Ledger balance" value={inr(s.totals.balance_paise)} emphasise />
        <Kpi label="This month · debit" value={inr(s.this_month.debit_paise)} />
        <Kpi label="This month · credit" value={inr(s.this_month.credit_paise)} />
      </div>
      <div className="bg-white border border-neutral-200 rounded overflow-hidden">
        <table className="w-full border-collapse tabular-nums">
          <thead>
            <tr>
              {['Type', 'Debit', 'Credit', 'Rows'].map((c) => (
                <th key={c} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.by_type.filter((r) => r.count > 0).map((r) => (
              <tr key={r.type} className="border-b border-neutral-200">
                <td className="px-3 py-2 text-13 text-neutral-900">{r.type}</td>
                <td className="px-3 py-2 text-13 text-neutral-900">{inr(r.debit)}</td>
                <td className="px-3 py-2 text-13 text-neutral-900">{inr(r.credit)}</td>
                <td className="px-3 py-2 text-13 text-neutral-500">{r.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Kpi({ label, value, emphasise }: { label: string; value: string; emphasise?: boolean }) {
  return (
    <div>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
      <div className={'text-20 mt-1 ' + (emphasise ? 'text-neutral-900 font-semibold' : 'text-neutral-900')}>{value}</div>
    </div>
  );
}

// ── Ledger ────────────────────────────────────────────────────────────────
function LedgerSection({ canManage }: { canManage: boolean }) {
  const [type, setType] = useState<string>('');
  const q = useQuery({
    queryKey: ['accounts', 'ledger', { type }],
    queryFn: () => accountsApi.ledger({ type: type || undefined }),
  });
  return (
    <div className="space-y-3" data-testid="accounts-ledger">
      <div className="flex items-end gap-3 flex-wrap">
        <label className="block">
          <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Type</span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded"
            data-testid="ledger-type-filter"
          >
            <option value="">Any type</option>
            {LEDGER_TYPES.map((t) => (<option key={t} value={t}>{t}</option>))}
          </select>
        </label>
      </div>
      <div className="bg-white border border-neutral-200 rounded overflow-x-auto">
        {q.isLoading ? (
          <div className="h-40 bg-neutral-100" />
        ) : (q.data?.items.length ?? 0) === 0 ? (
          <div className="p-6 text-13 text-neutral-500">No ledger rows.</div>
        ) : (
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                {['Date', 'Type', 'Description', 'Employee', 'Debit', 'Credit', 'Running', 'Reference', 'Status', canManage ? '' : null]
                  .filter((c) => c !== null)
                  .map((c) => (
                    <th key={c as string} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">
                      {c as string}
                    </th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {q.data!.items.map((r) => (
                <LedgerRow key={r.id} row={r} canManage={canManage} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function LedgerRow({ row, canManage }: { row: LedgerRowWithEmp; canManage: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const reverse = useMutation({
    mutationFn: () => accountsApi.reverse(row.id),
    onSuccess: () => {
      toast.push('success', 'Contra entry posted.');
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const s: { variant: StatusVariant; label: string } =
    row.status === 'reversed'
      ? { variant: 'awaiting', label: 'Reversed' }
      : { variant: 'ok', label: 'Posted' };
  const border = row.status === 'reversed' ? 'border-neutral-400' : 'border-transparent';

  return (
    <tr className="border-b border-neutral-200" data-testid={`ledger-row-${row.id}`}>
      <td className={`px-3 py-2 border-l-2 ${border} text-13 text-neutral-900`}>{fmtDate(row.date + 'T00:00:00Z')}</td>
      <td className="px-3 py-2 text-13 text-neutral-700">{row.type}</td>
      <td className="px-3 py-2 text-13 text-neutral-900 max-w-[280px]">{row.description}</td>
      <td className="px-3 py-2 text-13 text-neutral-500">{row.employee?.full_name ?? '—'}</td>
      <td className={'px-3 py-2 text-13 ' + (row.debit_paise > 0 ? 'text-neutral-900' : 'text-neutral-400')}>
        {row.debit_paise > 0 ? inr(row.debit_paise) : '—'}
      </td>
      <td className={'px-3 py-2 text-13 ' + (row.credit_paise > 0 ? 'text-neutral-900' : 'text-neutral-400')}>
        {row.credit_paise > 0 ? inr(row.credit_paise) : '—'}
      </td>
      <td className="px-3 py-2 text-13 text-neutral-900 font-medium">{inr(row.running_balance_paise)}</td>
      <td className="px-3 py-2 text-11 text-neutral-500 max-w-[160px]">{row.reference_id}</td>
      <td className="px-3 py-2"><StatusLabel variant={s.variant} label={s.label} /></td>
      {canManage ? (
        <td className="px-3 py-2">
          {row.status === 'posted' ? (
            <Button
              variant="ghost"
              onClick={() => {
                if (confirm(`Post a contra entry to reverse "${row.description}"?`)) reverse.mutate();
              }}
              data-testid={`ledger-reverse-${row.id}`}
            >
              Reverse
            </Button>
          ) : null}
        </td>
      ) : null}
    </tr>
  );
}

// ── Payments ──────────────────────────────────────────────────────────────
function PaymentsSection() {
  const q = useQuery({ queryKey: ['payments', 'list'], queryFn: () => accountsApi.payments.list() });
  return (
    <div className="space-y-3" data-testid="accounts-payments">
      <div className="text-11 text-neutral-500 border-l-2 border-amber pl-2">
        Simulated payment — no bank integration.
      </div>
      <div className="bg-white border border-neutral-200 rounded overflow-hidden">
        {q.isLoading ? (
          <div className="h-40 bg-neutral-100" />
        ) : (q.data?.items.length ?? 0) === 0 ? (
          <div className="p-6 text-13 text-neutral-500">No payments recorded.</div>
        ) : (
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                {['Date', 'Employee', 'Amount', 'Method', 'Reference', 'Status'].map((c) => (
                  <th key={c} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data!.items.map((p) => (
                <tr key={p.id} className="border-b border-neutral-200" data-testid={`payment-row-${p.id}`}>
                  <td className="px-3 py-2 text-13 text-neutral-900">{p.paid_at ? fmtDateTime(p.paid_at) : '—'}</td>
                  <td className="px-3 py-2">
                    <div className="text-13 text-neutral-900">{p.employee?.full_name ?? '—'}</div>
                    <div className="text-11 text-neutral-500">{p.employee?.employee_code}</div>
                  </td>
                  <td className="px-3 py-2 text-13 text-neutral-900 font-medium">{inr(p.amount_paise)}</td>
                  <td className="px-3 py-2 text-13 text-neutral-700 capitalize">{p.method.replace('_', ' ')}</td>
                  <td className="px-3 py-2 text-11 text-neutral-500 max-w-[220px]">{p.reference}</td>
                  <td className="px-3 py-2 text-13 text-neutral-700 capitalize">{p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
