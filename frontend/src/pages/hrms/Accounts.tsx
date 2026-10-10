/**
 * /hrms/accounts — the consolidated internal-finance module (§6.1).
 *
 * Sidebar shows ONE "Accounts" entry that opens this layout with six
 * tabs — Overview | Payroll | Expenses | Payments | Collections | Ledger.
 * Matching lives as a sub-tab under Collections.
 *
 * Legacy /hrms/payroll and /hrms/expenses redirect here (App.tsx). Auth
 * is per-sub-tab, not on the layout — Payroll needs payroll.view, Ledger
 * needs accounts.read, etc.
 */
import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownLeft, ArrowUpRight, Banknote, BellRing, BookOpen, CalendarClock, CalendarDays, ChevronLeft, ChevronRight,
  ClipboardCheck, Landmark, Receipt, Wallet,
} from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import type { RoleCode } from '@/data/models';
import {
  accountsApi,
  LEDGER_TYPES,
  type LedgerRowWithEmp,
  type LedgerSort,
  type OverviewNeedsYouItem,
} from '@/modules/accounts/api';
import { NewPaymentModal } from '@/modules/accounts/NewPaymentModal';
import { CollectionsSection } from '@/modules/zpay/CollectionsSection';
import { MatchingQueueSection } from '@/modules/zpay/MatchingQueueSection';
import { fmtDate, fmtDateTime, inr } from '@/lib/format';
import { StatusLabel, type StatusVariant } from '@/components/StatusRow';
import { FilterSelect, ListHeader, ListToolbar } from '@/modules/workstation/listUi';

/** Which tabs a role can see (nav-render only — the API is the gate). */
export function accountsTabsFor(role: RoleCode | undefined) {
  return {
    overview: true,
    payroll: can(role, 'payroll.view.own', 'self') || can(role, 'payroll.view', 'organisation'),
    expenses: can(role, 'expense.submit', 'self') || can(role, 'expense.approve', 'department'),
    payments: can(role, 'payments.manage', 'organisation'),
    collections: can(role, 'accounts.read', 'organisation') || can(role, 'accounts.manage', 'organisation'),
    ledger: can(role, 'accounts.read', 'organisation') || can(role, 'accounts.manage', 'organisation'),
  };
}

export function AccountsLayout() {
  const { session } = useAuth();
  const role = session?.role.code as RoleCode | undefined;
  const tabs = accountsTabsFor(role);
  return (
    <div className="space-y-6">
      <ListHeader
        title="Payroll & expenses"
        meta="Internal JNS Accounting Solutions finance. Append-only ledger — corrections are contra entries."
      />

      <div className="flex items-center gap-2 flex-wrap">
        {tabs.overview    ? <AccountsTabLink to="overview">Overview</AccountsTabLink> : null}
        {tabs.payroll     ? <AccountsTabLink to="payroll">Payroll</AccountsTabLink> : null}
        {tabs.expenses    ? <AccountsTabLink to="expenses">Expenses</AccountsTabLink> : null}
        {tabs.payments    ? <AccountsTabLink to="payments">Payments</AccountsTabLink> : null}
        {tabs.collections ? <AccountsTabLink to="collections">Online collections</AccountsTabLink> : null}
        {tabs.ledger      ? <AccountsTabLink to="ledger">Ledger</AccountsTabLink> : null}
      </div>

      <Outlet />
    </div>
  );
}

function AccountsTabLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={to === 'overview'}
      className={({ isActive }) =>
        'h-8 px-3 inline-flex items-center text-13 rounded-full border transition-colors whitespace-nowrap ' +
        (isActive ? 'bg-[#f1edff] border-[#cbbdf2] text-primary font-medium' : 'bg-white border-neutral-200 text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50')
      }
      data-testid={`accounts-tab-${to}`}
    >
      {children}
    </NavLink>
  );
}

/**
 * §6.3 Overview dashboard. One round-trip returns everything —
 * this-month tiles, Needs-you queue, Held-not-yet-remitted, and the
 * balanced-ledger strip. Month stepper drives ?month=YYYY-MM.
 *
 * Sovereign design: one gold accent for the "Needs you" row's left
 * borders; nothing else competes.
 */
export function AccountsOverviewPage() {
  const today = new Date();
  const defaultMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const [month, setMonth] = useState(defaultMonth);
  const q = useQuery({
    queryKey: ['accounts', 'overview', month],
    queryFn: () => accountsApi.overview(month),
    retry: false,
  });
  if (q.isLoading) return <div className="h-40 bg-neutral-100" />;
  if (q.isError || !q.data) return <div className="text-13 text-red">Could not load overview.</div>;
  const o = q.data;
  return (
    <div className="space-y-6" data-testid="accounts-overview">
      <MonthStepper month={month} setMonth={setMonth} label={o.month_label} />

      <Section title="This month">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <Tile
            label="Salary cost" icon={Wallet} tint="green"
            value={o.this_month.salary_cost_paise > 0 ? inr(o.this_month.salary_cost_paise) : '—'}
            hint={o.this_month.salary_employee_count > 0
              ? `${o.this_month.salary_employee_count} employees`
              : 'No run yet'}
          />
          <Tile
            label="Expense claims" icon={Receipt} tint="amber"
            value={inr(o.this_month.expense_claims_paise)}
            hint={`${o.this_month.expense_claim_count} claims`}
          />
          <Tile
            label="Paid out" icon={ArrowUpRight} tint="blue"
            value={inr(o.this_month.paid_out_paise)}
            hint={`${o.this_month.payment_count} payments`}
          />
          <Tile
            label="Collected" icon={ArrowDownLeft} tint="indigo"
            value={o.this_month.zpay_connected ? inr(o.this_month.collected_paise) : '—'}
            hint={o.this_month.zpay_connected ? 'from Zoho Payments' : 'not synced'}
          />
        </div>
      </Section>

      {o.needs_you.length > 0 ? (
        <Section title="Needs you" count={o.needs_you.length}>
          <div className="space-y-2">
            {o.needs_you.map((n) => <NeedsYouRow key={n.id} item={n} />)}
          </div>
        </Section>
      ) : null}

      <Section title="Held, not yet remitted">
        <div className="space-y-2">
          {o.held_liabilities.map((h) => (
            <div
              key={h.category}
              className="dash-row flex items-center gap-3 px-4 py-3"
              data-testid={`held-${h.category.replace(/\s+/g, '-')}`}
            >
              <span className="h-8 w-8 shrink-0 rounded-lg inline-flex items-center justify-center bg-[#f5f1ff] text-[#5b33c4]" aria-hidden>
                <Landmark size={15} strokeWidth={1.9} />
              </span>
              <span className={'flex-1 text-14 ' + (h.balance_paise > 0 ? 'text-neutral-900' : 'text-neutral-500')}>
                {h.category}
              </span>
              <span className={'num-display text-15 ' + (h.balance_paise > 0 ? 'text-neutral-900' : 'text-neutral-400')}>
                {inr(h.balance_paise)}
              </span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Ledger">
        <div className="dash-card p-5" data-testid="overview-ledger-strip">
          <div className="flex items-center gap-3 flex-wrap mb-4">
            <span className="h-9 w-9 rounded-lg inline-flex items-center justify-center bg-[#e9f9f1] text-[#047857]" aria-hidden>
              <BookOpen size={16} strokeWidth={1.9} />
            </span>
            <span className="text-15 font-semibold text-neutral-900">Ledger totals</span>
            <span className="ml-auto">
              {o.ledger.balanced ? (
                <span className="inline-flex items-center gap-2 h-7 px-3 rounded-full text-12 font-medium bg-[#ecfdf5] text-[#047857]">
                  <span className="rounded-full" style={{ background: '#10b981', width: 6, height: 6 }} />Balanced
                </span>
              ) : (
                <span className="inline-flex items-center gap-2 h-7 px-3 rounded-full text-12 font-medium bg-[#fef2f2] text-[#b91c1c]">
                  <span className="rounded-full" style={{ background: '#ef4444', width: 6, height: 6 }} />Unbalanced — investigate
                </span>
              )}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <LedgerStat label="Debits" value={inr(o.ledger.debit_paise)} />
            <LedgerStat label="Credits" value={inr(o.ledger.credit_paise)} />
            <LedgerStat label="Balance" value={inr(o.ledger.balance_paise)} strong />
          </div>
        </div>
      </Section>
    </div>
  );
}

function MonthStepper({
  month, setMonth, label,
}: { month: string; setMonth: (m: string) => void; label: string }) {
  const shift = (delta: number) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    setMonth(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  };
  const today = new Date();
  const currentYm = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const arrow = 'h-8 w-8 inline-flex items-center justify-center rounded-full text-neutral-600 hover:bg-[#f1edff] hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors';
  return (
    <div className="inline-flex items-center gap-1 p-1 rounded-full bg-white border border-neutral-200 shadow-card" data-testid="overview-month-stepper">
      <button type="button" onClick={() => shift(-1)} className={arrow} aria-label="Previous month" data-testid="month-prev">
        <ChevronLeft size={16} strokeWidth={2} />
      </button>
      <div className="inline-flex items-center gap-2 px-2 text-14 font-semibold text-neutral-900 min-w-[9rem] justify-center">
        <CalendarDays size={15} strokeWidth={1.9} className="text-primary" />{label}
      </div>
      <button type="button" onClick={() => shift(1)} disabled={month >= currentYm} className={arrow} aria-label="Next month" data-testid="month-next">
        <ChevronRight size={16} strokeWidth={2} />
      </button>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-15 font-semibold text-neutral-900">{title}</h2>
        {count ? <span className="inline-flex items-center h-5 px-2 rounded-full text-11 font-semibold bg-[#f1edff] text-primary">{count}</span> : null}
      </div>
      {children}
    </section>
  );
}

const TILE_TINT = {
  green: { bg: '#e9f9f1', fg: '#047857' },
  amber: { bg: '#fff7e6', fg: '#b45309' },
  blue: { bg: '#efeafd', fg: '#6941d9' },
  indigo: { bg: '#f5f1ff', fg: '#5b33c4' },
};

function Tile({ label, value, hint, icon: Icon, tint }: {
  label: string; value: string; hint: string; icon: typeof Wallet; tint: keyof typeof TILE_TINT;
}) {
  const t = TILE_TINT[tint];
  return (
    <div className="dash-card p-5">
      <div className="flex items-center gap-3">
        <span className="h-10 w-10 rounded-lg inline-flex items-center justify-center" style={{ background: t.bg, color: t.fg }} aria-hidden>
          <Icon size={18} strokeWidth={1.9} />
        </span>
        <span className="text-13 font-medium text-neutral-500">{label}</span>
      </div>
      <div className="num-display text-[26px] leading-tight text-neutral-900 mt-3">{value}</div>
      <div className="text-12 text-neutral-500 mt-1">{hint}</div>
    </div>
  );
}

function LedgerStat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-md px-4 py-3" style={{ background: strong ? '#f1edff' : '#f4f6fa', border: `1px solid ${strong ? '#dbd2f6' : '#e8ecf3'}` }}>
      <div className="text-12 text-neutral-500">{label}</div>
      <div className={`num-display text-20 mt-1 ${strong ? 'text-primary' : 'text-neutral-900'}`}>{value}</div>
    </div>
  );
}

/** An icon per kind of action, read from its label. */
const NEEDS_ICON: Record<string, typeof Wallet> = { Open: CalendarClock, Review: ClipboardCheck, Pay: Banknote };

function NeedsYouRow({ item }: { item: OverviewNeedsYouItem }) {
  const Icon = NEEDS_ICON[item.action_label] ?? BellRing;
  return (
    <a
      href={item.action_url}
      className="dash-row flex items-center gap-4 px-4 py-3"
      data-testid={`needs-${item.id}`}
    >
      <span className="h-9 w-9 shrink-0 rounded-lg inline-flex items-center justify-center bg-[#fff7e6] text-[#b45309]" aria-hidden>
        <Icon size={16} strokeWidth={1.9} />
      </span>
      <div className="text-14 text-neutral-900 flex-1">{item.message}</div>
      {item.amount_paise !== null ? (
        <div className="num-display text-15 text-neutral-900">{inr(item.amount_paise)}</div>
      ) : null}
      <span className="inline-flex items-center gap-1 h-7 px-3 rounded-full text-12 font-medium text-primary bg-[#f1edff]">
        {item.action_label} <ChevronRight size={13} strokeWidth={2} />
      </span>
    </a>
  );
}

/** Ledger sub-route — wraps the section with the accounts.read gate. */
export function AccountsLedgerPage() {
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'accounts.manage', 'organisation');
  const canRead = canManage || can(session?.role.code, 'accounts.read', 'organisation');
  if (!canRead) return <AccessDenied what="the ledger" />;
  return <LedgerSection canManage={canManage} />;
}

/** Payments sub-route — Finance-gated, hosts the New-Payment modal. */
export function AccountsPaymentsPage() {
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'accounts.manage', 'organisation');
  const canRead = canManage || can(session?.role.code, 'accounts.read', 'organisation');
  const [newPay, setNewPay] = useState(false);
  if (!canRead) return <AccessDenied what="payments" />;
  return (
    <div>
      {canManage ? (
        <div className="flex justify-end mb-3">
          <Button variant="primary" onClick={() => setNewPay(true)} data-testid="new-payment">
            New payment
          </Button>
        </div>
      ) : null}
      <PaymentsSection />
      <NewPaymentModal open={newPay} onClose={() => setNewPay(false)} />
    </div>
  );
}

/**
 * Collections sub-route with Matching as a nested sub-tab. Matching's
 * breadcrumb is already ACCOUNTS / COLLECTIONS / MATCHING, so this
 * pathway matches the spec's existing story.
 */
export function AccountsCollectionsPage() {
  const location = useLocation();
  const onMatching = location.pathname.endsWith('/matching');
  return (
    <div className="space-y-4" data-testid="accounts-collections">
      <div className="flex items-center gap-2 flex-wrap text-13">
        <NavLink
          to="."
          end
          className={({ isActive }) =>
            'h-8 px-3 inline-flex items-center rounded-full border transition-colors whitespace-nowrap ' + (isActive
              ? 'bg-[#f1edff] border-[#cbbdf2] text-primary font-medium'
              : 'bg-white border-neutral-200 text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50')
          }
        >
          Online collections
        </NavLink>
        <NavLink
          to="matching"
          className={({ isActive }) =>
            'h-8 px-3 inline-flex items-center rounded-full border transition-colors whitespace-nowrap ' + (isActive
              ? 'bg-[#f1edff] border-[#cbbdf2] text-primary font-medium'
              : 'bg-white border-neutral-200 text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50')
          }
        >
          Matching
        </NavLink>
      </div>
      {onMatching ? <MatchingQueueSection /> : <CollectionsSection onGoToMatching={() => undefined} />}
    </div>
  );
}

function AccessDenied({ what }: { what: string }) {
  return (
    <div className="max-w-[720px] mx-auto bg-white border border-neutral-200 rounded p-6">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Access denied</div>
      <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-neutral-900">
        {what} is Finance / MD only.
      </h1>
      <p className="text-13 text-neutral-500 mt-2">
        §8.6: internal JNS Accounting Solutions finance. Client accounting never appears here.
      </p>
    </div>
  );
}

// ── Ledger ────────────────────────────────────────────────────────────────
function LedgerSection({ canManage }: { canManage: boolean }) {
  const [type, setType] = useState<string>('');
  const [sort, setSort] = useState<LedgerSort>('date');
  const q = useQuery({
    queryKey: ['accounts', 'ledger', { type, sort }],
    queryFn: () => accountsApi.ledger({ type: type || undefined, sort }),
  });
  const showBalance = q.data?.running_balance_available ?? false;
  const [reverseTarget, setReverseTarget] = useState<LedgerRowWithEmp | null>(null);
  return (
    <div className="space-y-3" data-testid="accounts-ledger">
      <ListToolbar>
        <FilterSelect label="Type" value={type} onChange={setType} options={LEDGER_TYPES.map((t) => ({ value: t, label: t }))} />
        <select
          aria-label="Sort by"
          title="Sort by"
          value={sort}
          onChange={(e) => setSort(e.target.value as LedgerSort)}
          className="h-9 px-2 text-13 bg-white text-neutral-700 border border-neutral-200 rounded-lg focus:outline-none focus:border-primary/60"
          data-testid="ledger-sort"
        >
          <option value="date">Sort: Date (running balance)</option>
          <option value="amount">Sort: Amount</option>
          <option value="type">Sort: Type</option>
          <option value="employee">Sort: Employee</option>
        </select>
        {!showBalance && !q.isLoading && q.data ? (
          <span className="text-11 text-neutral-500">
            Running balance hidden — meaningful only in date order.
          </span>
        ) : null}
      </ListToolbar>
      <div className="bg-white border border-neutral-200 rounded overflow-x-auto">
        {q.isLoading ? (
          <div className="h-40 bg-neutral-100" />
        ) : (q.data?.items.length ?? 0) === 0 ? (
          <div className="p-6 text-13 text-neutral-500">No ledger rows.</div>
        ) : (
          <table className="hr-float w-full border-collapse tabular-nums">
            <thead>
              <tr>
                {(['Date', 'Type', 'Description', 'Employee', 'Debit', 'Credit', showBalance ? 'Running' : null, 'Reference', 'Status', canManage ? '' : null] as (string | null)[])
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
                <LedgerRow
                  key={r.id}
                  row={r}
                  canManage={canManage}
                  showBalance={showBalance}
                  onReverse={() => setReverseTarget(r)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
      <ReverseLedgerModal
        row={reverseTarget}
        onClose={() => setReverseTarget(null)}
      />
    </div>
  );
}

function LedgerRow({
  row, canManage, showBalance, onReverse,
}: {
  row: LedgerRowWithEmp; canManage: boolean; showBalance: boolean; onReverse: () => void;
}) {
  const s: { variant: StatusVariant; label: string } =
    row.status === 'reversed'
      ? { variant: 'awaiting', label: 'Reversed' }
      : { variant: 'ok', label: 'Posted' };
  const border = row.status === 'reversed' ? 'border-neutral-400' : 'border-transparent';

  return (
    <tr className="border-b border-neutral-200" data-testid={`ledger-row-${row.id}`}>
      <td className={`px-3 py-2 border-l-2 ${border} text-13 text-neutral-900`}>{fmtDate(row.date + 'T00:00:00Z')}</td>
      <td className="px-3 py-2 text-13 text-neutral-700">{row.type}</td>
      <td className="px-3 py-2 text-13 text-neutral-900 max-w-[280px]">
        {row.description}
        {row.reversal_reason ? (
          <div className="text-11 text-neutral-500 mt-1">Reason: {row.reversal_reason}</div>
        ) : null}
      </td>
      <td className="px-3 py-2 text-13 text-neutral-500">{row.employee?.full_name ?? '—'}</td>
      <td className={'px-3 py-2 text-13 ' + (row.debit_paise > 0 ? 'text-neutral-900' : 'text-neutral-400')}>
        {row.debit_paise > 0 ? inr(row.debit_paise) : '—'}
      </td>
      <td className={'px-3 py-2 text-13 ' + (row.credit_paise > 0 ? 'text-neutral-900' : 'text-neutral-400')}>
        {row.credit_paise > 0 ? inr(row.credit_paise) : '—'}
      </td>
      {showBalance ? (
        <td className="px-3 py-2 text-13 text-neutral-900 font-medium">
          {inr(row.running_balance_paise ?? 0)}
        </td>
      ) : null}
      <td className="px-3 py-2 text-11 text-neutral-500 whitespace-nowrap">
        {row.reference_label ?? row.transaction_ref}
      </td>
      <td className="px-3 py-2"><StatusLabel variant={s.variant} label={s.label} /></td>
      {canManage ? (
        <td className="px-3 py-2">
          {row.status === 'posted' && !row.reverses_id ? (
            <Button
              variant="ghost"
              onClick={onReverse}
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

function ReverseLedgerModal({
  row, onClose,
}: {
  row: LedgerRowWithEmp | null; onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const reverse = useMutation({
    mutationFn: (r: string) => accountsApi.reverse(row!.id, r),
    onSuccess: (res) => {
      const n = res.cluster_size;
      toast.push('success',
        n > 1
          ? `Reversed the whole ${n}-leg journal.`
          : 'Contra entry posted.',
      );
      qc.invalidateQueries({ queryKey: ['accounts'] });
      setReason('');
      onClose();
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  if (!row) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 px-4">
      <div className="bg-white border border-neutral-300 rounded max-w-[480px] w-full p-5 space-y-4">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Reverse ledger entry</div>
          <div className="text-15 text-neutral-900 font-medium mt-1">{row.description}</div>
          <div className="text-11 text-neutral-500 mt-1">
            {row.transaction_ref} · {row.debit_paise > 0 ? `Dr ${inr(row.debit_paise)}` : `Cr ${inr(row.credit_paise)}`}
          </div>
        </div>
        <p className="text-13 text-neutral-700">
          {row.payment_id
            ? 'This row is one leg of a multi-leg journal — reversing it will reverse the WHOLE journal to keep the books balanced.'
            : 'A contra entry will be posted and the original marked reversed. The original row is never edited.'}
        </p>
        <label className="block">
          <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Reason (required)</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full px-2 py-1 text-13 bg-white border border-neutral-300 rounded"
            placeholder="Why is this being reversed?"
            data-testid="reverse-reason"
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => reverse.mutate(reason.trim())}
            disabled={reason.trim().length < 3 || reverse.isPending}
            data-testid="reverse-confirm"
          >
            {reverse.isPending ? 'Reversing…' : 'Reverse'}
          </Button>
        </div>
      </div>
    </div>
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
          <table className="hr-float w-full border-collapse tabular-nums">
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
