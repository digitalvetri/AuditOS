/**
 * HRMS → Payment summary.
 *
 * What every client has been invoiced, paid and still owes, built from the
 * Workstation invoices. Open a client to see each invoice with its
 * instalments (a "split" is simply several payments against one invoice),
 * record a new payment, or remove one entered by mistake.
 *
 * Extras: overdue ageing (how long money has been pending), collection rate,
 * collected this month, recent payments, a WhatsApp reminder for clients
 * with dues, and a CSV export of the client table.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown, ChevronRight, Download, MessageCircle, Plus, Trash2, Wallet,
} from 'lucide-react';
import {
  paymentSummaryApi, PAYMENT_MODE_LABEL,
  type ClientInvoice, type ClientSummary, type PayState, type PaymentMode, type SummaryResponse,
} from '@/modules/paymentSummary/api';
import {
  ListCard, ListEmpty, ListHeader, ListToolbar, Money, SearchBox, Spacer, StatusPills, fmtDay,
} from '@/modules/workstation/listUi';
import { Field, Modal, QueryState, inputClass } from '@/modules/workstation/components';
import { inrAmount } from '@/modules/workstation/invoices/document';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { istToday } from '@/lib/dates';

const rupees = (paise: number) => `₹${inrAmount(paise)}`;
const M = ({ paise }: { paise: number }) => <Money value={rupees(paise)} />;

const STATE_LOOK: Record<PayState, { label: string; bg: string; fg: string; dot: string }> = {
  paid: { label: 'Paid', bg: '#ecfdf5', fg: '#047857', dot: '#10b981' },
  partial: { label: 'Partly paid', bg: '#fffbeb', fg: '#b45309', dot: '#f59e0b' },
  unpaid: { label: 'Unpaid', bg: '#eff6ff', fg: '#1e40af', dot: '#2563eb' },
  overdue: { label: 'Overdue', bg: '#fef2f2', fg: '#b91c1c', dot: '#ef4444' },
};

function StateChip({ state }: { state: PayState }) {
  const s = STATE_LOOK[state];
  return (
    <span className="inline-flex items-center gap-2 h-6 px-3 rounded-full text-12 font-medium whitespace-nowrap" style={{ background: s.bg, color: s.fg }}>
      <span className="rounded-full" style={{ background: s.dot, width: 6, height: 6 }} />
      {s.label}
    </span>
  );
}

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'dues', label: 'Has dues' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'partial', label: 'Partly paid' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'paid', label: 'Fully paid' },
];

function matches(c: ClientSummary, filter: string) {
  if (filter === 'dues') return c.pending_paise > 0;
  return !filter || c.status === filter;
}

export function PaymentSummaryPage() {
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'payment_summary.manage', 'organisation');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const summary = useQuery({ queryKey: ['payment-summary'], queryFn: () => paymentSummaryApi.summary() });

  const clients = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (summary.data?.clients ?? []).filter((c) =>
      matches(c, filter)
      && (!needle || c.client_name.toLowerCase().includes(needle) || (c.client_code ?? '').toLowerCase().includes(needle)));
  }, [summary.data, q, filter]);

  const counts = useMemo(() => {
    const all = summary.data?.clients ?? [];
    return Object.fromEntries(FILTERS.map((f) => [f.value, f.value ? all.filter((c) => matches(c, f.value)).length : undefined]));
  }, [summary.data]);

  return (
    <div className="max-w-[1400px] space-y-5">
      <ListHeader
        title="Payment summary"
        meta={<>What each client has been invoiced, has paid and still owes. Open a client to record a payment or a split.</>}
        action={summary.data ? (
          <button type="button" onClick={() => exportCsv(summary.data!.clients)}
            className="h-9 px-4 inline-flex items-center gap-2 text-13 font-medium rounded-lg bg-white border border-neutral-200 text-neutral-800 hover:bg-neutral-50">
            <Download size={15} /> Export CSV
          </button>
        ) : undefined}
      />

      <QueryState query={summary} empty={null}>
        {(data: SummaryResponse) => (
          <>
            <Totals data={data} />
            <div className="grid gap-5 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="space-y-4 min-w-0">
                <ListToolbar>
                  <SearchBox value={q} onChange={setQ} placeholder="Search client or code" />
                  <Spacer />
                  <StatusPills options={FILTERS} value={filter} onChange={setFilter} counts={counts} />
                </ListToolbar>
                <ListCard>
                  {clients.length === 0 ? (
                    <ListEmpty>{data.clients.length === 0
                      ? 'No sent invoices yet. Invoices appear here once they are sent from Workstation → Invoice.'
                      : 'No client matches this filter.'}</ListEmpty>
                  ) : (
                    <ClientTable clients={clients} open={open} onToggle={(id) => setOpen(open === id ? null : id)} canManage={canManage} />
                  )}
                </ListCard>
              </div>
              <aside className="space-y-5 min-w-0">
                <Ageing ageing={data.ageing} />
                <RecentPayments items={data.recent_payments} />
              </aside>
            </div>
          </>
        )}
      </QueryState>
    </div>
  );
}

// ── Totals ────────────────────────────────────────────────────────────────

function Totals({ data }: { data: SummaryResponse }) {
  const t = data.totals;
  const tiles = [
    { label: 'Invoiced', value: t.invoiced_paise, note: `${t.invoices} invoice${t.invoices === 1 ? '' : 's'} · ${t.clients} client${t.clients === 1 ? '' : 's'}` },
    { label: 'Received', value: t.paid_paise, note: t.collection_rate == null ? '—' : `${t.collection_rate}% collected`, tone: 'text-[#047857]' },
    { label: 'Pending', value: t.pending_paise, note: `${t.clients_with_dues} client${t.clients_with_dues === 1 ? '' : 's'} with dues`, tone: 'text-[#b45309]' },
    { label: 'Overdue', value: t.overdue_paise, note: 'Past the due date', tone: t.overdue_paise ? 'text-[#b91c1c]' : undefined },
    { label: 'Received this month', value: t.collected_this_month_paise, note: new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) },
  ];
  return (
    <section className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-5" data-testid="payment-totals">
      {tiles.map((x) => (
        <div key={x.label} className="dash-card p-5">
          <div className="text-13 font-medium text-neutral-500">{x.label}</div>
          <div className={`num-display text-24 leading-tight mt-1 ${x.tone ?? 'text-neutral-900'}`}><M paise={x.value} /></div>
          <div className="text-12 text-neutral-500 mt-1 truncate">{x.note}</div>
        </div>
      ))}
    </section>
  );
}

// ── Client table ──────────────────────────────────────────────────────────

function ClientTable({ clients, open, onToggle, canManage }: {
  clients: ClientSummary[]; open: string | null; onToggle: (id: string) => void; canManage: boolean;
}) {
  return (
    <div className="md:overflow-x-auto">
      <table className="w-full text-13">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-12 text-neutral-500">
            <th className="font-normal py-3 pl-5 pr-4">Client</th>
            <th className="font-normal py-3 px-4 text-right">Invoiced</th>
            <th className="font-normal py-3 px-4 text-right">Received</th>
            <th className="font-normal py-3 px-4 text-right">Pending</th>
            <th className="font-normal py-3 px-4 hidden lg:table-cell">Progress</th>
            <th className="font-normal py-3 px-4">Status</th>
            <th className="font-normal py-3 px-4 hidden lg:table-cell">Last payment</th>
            <th className="font-normal py-3 pl-4 pr-5" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => {
            const isOpen = open === c.client_id;
            const pct = c.invoiced_paise ? Math.round((c.paid_paise / c.invoiced_paise) * 100) : 0;
            return (
              <ClientRows key={c.client_id} c={c} isOpen={isOpen} pct={pct} onToggle={() => onToggle(c.client_id)} canManage={canManage} />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ClientRows({ c, isOpen, pct, onToggle, canManage }: {
  c: ClientSummary; isOpen: boolean; pct: number; onToggle: () => void; canManage: boolean;
}) {
  return (
    <>
      <tr
        onClick={onToggle} tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onToggle(); }}
        className={`border-b border-neutral-100 cursor-pointer transition-colors ${isOpen ? 'bg-[#f7f9fc]' : 'hover:bg-neutral-50'}`}
        data-testid={`ps-client-${c.client_id}`}
      >
        <td className="py-3 pl-5 pr-4">
          <div className="flex items-center gap-2">
            {isOpen ? <ChevronDown size={15} className="text-neutral-400 shrink-0" /> : <ChevronRight size={15} className="text-neutral-400 shrink-0" />}
            <div className="min-w-0">
              <div className="font-semibold text-neutral-900 truncate">{c.client_name}</div>
              <div className="text-11 text-neutral-500">
                {c.client_code ? `${c.client_code} · ` : ''}{c.invoices} invoice{c.invoices === 1 ? '' : 's'}
                {c.open_invoices ? ` · ${c.open_invoices} open` : ''}
              </div>
            </div>
          </div>
        </td>
        <td className="py-3 px-4 text-right whitespace-nowrap tabular-nums"><M paise={c.invoiced_paise} /></td>
        <td className="py-3 px-4 text-right whitespace-nowrap tabular-nums text-[#047857]"><M paise={c.paid_paise} /></td>
        <td className={`py-3 px-4 text-right whitespace-nowrap tabular-nums font-semibold ${c.pending_paise ? (c.overdue_paise ? 'text-[#b91c1c]' : 'text-[#b45309]') : 'text-neutral-400'}`}>
          <M paise={c.pending_paise} />
        </td>
        <td className="py-3 px-4 hidden lg:table-cell">
          <div className="flex items-center gap-2 w-[120px]">
            <div className="flex-1 h-1.5 rounded-full bg-neutral-100 overflow-hidden" aria-label={`${pct}% received`}>
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct === 100 ? '#10b981' : '#2f62b0' }} />
            </div>
            <span className="text-11 text-neutral-500 tabular-nums w-8 text-right">{pct}%</span>
          </div>
        </td>
        <td className="py-3 px-4"><StateChip state={c.status} /></td>
        <td className="py-3 px-4 hidden lg:table-cell text-neutral-600 whitespace-nowrap">{fmtDay(c.last_payment_on)}</td>
        <td className="py-3 pl-4 pr-5 text-right" onClick={(e) => e.stopPropagation()}>
          {c.pending_paise > 0 && c.contact_number ? (
            <a href={reminderLink(c)} target="_blank" rel="noreferrer" title="Send a payment reminder on WhatsApp"
              className="h-8 w-8 inline-flex items-center justify-center rounded-full text-[#047857] hover:bg-[#ecfdf5]">
              <MessageCircle size={16} />
            </a>
          ) : null}
        </td>
      </tr>
      {isOpen ? (
        <tr className="border-b border-neutral-200 bg-[#f7f9fc]">
          <td colSpan={8} className="px-5 pb-5 pt-1">
            <ClientInvoices clientId={c.client_id} canManage={canManage} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ── One client's invoices + instalments ───────────────────────────────────

function ClientInvoices({ clientId, canManage }: { clientId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [paying, setPaying] = useState<ClientInvoice | null>(null);
  const detail = useQuery({ queryKey: ['payment-summary', 'client', clientId], queryFn: () => paymentSummaryApi.client(clientId) });

  const remove = useMutation({
    mutationFn: ({ invoiceId, paymentId }: { invoiceId: string; paymentId: string }) => paymentSummaryApi.remove(invoiceId, paymentId),
    onSuccess: () => {
      toast.push('success', 'Payment removed.');
      qc.invalidateQueries({ queryKey: ['payment-summary'] });
      qc.invalidateQueries({ predicate: isInvoiceQuery });
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  if (detail.isLoading) return <div className="h-16 rounded-md bg-white border border-neutral-200" />;
  if (!detail.data) return <div className="text-13 text-red-700">Could not load this client's invoices.</div>;

  return (
    <div className="space-y-3">
      {detail.data.invoices.map((inv) => (
        <div key={inv.id} className="bg-white border border-neutral-200 rounded-lg">
          <div className="flex items-center gap-x-6 gap-y-2 flex-wrap px-4 py-3">
            <div className="min-w-[150px]">
              <Link to={`/workstation/invoices/${inv.id}`} className="font-semibold text-primary hover:underline">{inv.invoice_number}</Link>
              <div className="text-11 text-neutral-500">
                {fmtDay(inv.invoice_date)} · due {fmtDay(inv.due_date)}
                {inv.days_overdue ? <span className="text-[#b91c1c]"> · {inv.days_overdue} days overdue</span> : null}
              </div>
            </div>
            <Amount label="Total" paise={inv.total_paise} />
            <Amount label="Received" paise={inv.paid_paise} tone="text-[#047857]" />
            <Amount label="Pending" paise={inv.pending_paise} tone={inv.pending_paise ? 'text-[#b45309] font-semibold' : 'text-neutral-400'} />
            <StateChip state={inv.state} />
            <Spacer />
            {canManage && inv.pending_paise > 0 ? (
              <Button variant="primary" onClick={() => setPaying(inv)}>
                <span className="inline-flex items-center gap-1.5"><Plus size={14} /> Record payment</span>
              </Button>
            ) : null}
          </div>
          {inv.payments.length ? (
            <div className="border-t border-neutral-100 px-4 py-2">
              <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 py-1">
                {inv.payments.length > 1 ? `Paid in ${inv.payments.length} instalments` : 'Payment'}
              </div>
              <table className="w-full text-13">
                <tbody>
                  {inv.payments.map((p, i) => (
                    <tr key={p.id} className="border-t border-neutral-100 first:border-t-0">
                      <td className="py-2 pr-4 text-neutral-500 w-8 tabular-nums">{i + 1}.</td>
                      <td className="py-2 pr-4 whitespace-nowrap">{fmtDay(p.paid_on)}</td>
                      <td className="py-2 pr-4">{PAYMENT_MODE_LABEL[p.mode] ?? p.mode}</td>
                      <td className="py-2 pr-4 text-neutral-600 truncate max-w-[260px]" title={[p.reference, p.note].filter(Boolean).join(' · ')}>
                        {[p.reference, p.note].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums font-medium whitespace-nowrap"><M paise={p.amount_paise} /></td>
                      <td className="py-2 w-8 text-right">
                        {canManage ? (
                          <button type="button" title="Remove this payment (entered by mistake)"
                            disabled={remove.isPending}
                            onClick={() => remove.mutate({ invoiceId: inv.id, paymentId: p.id })}
                            className="h-7 w-7 inline-flex items-center justify-center rounded-full text-neutral-400 hover:text-red-700 hover:bg-red-50">
                            <Trash2 size={14} />
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ))}
      {paying ? <PaymentModal inv={paying} onClose={() => setPaying(null)} /> : null}
    </div>
  );
}

function Amount({ label, paise, tone = 'text-neutral-900' }: { label: string; paise: number; tone?: string }) {
  return (
    <div>
      <div className="text-11 text-neutral-500">{label}</div>
      <div className={`tabular-nums ${tone}`}><M paise={paise} /></div>
    </div>
  );
}

// ── Record a payment / instalment ─────────────────────────────────────────

function PaymentModal({ inv, onClose }: { inv: ClientInvoice; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [amount, setAmount] = useState(String(inv.pending_paise / 100));
  const [paidOn, setPaidOn] = useState(istToday());
  const [mode, setMode] = useState<PaymentMode>('bank_transfer');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');

  const amountPaise = Math.round((Number(amount) || 0) * 100);
  const after = inv.pending_paise - amountPaise;

  const save = useMutation({
    mutationFn: () => paymentSummaryApi.record(inv.id, {
      amount_paise: amountPaise, paid_on: paidOn, mode,
      reference: reference.trim() || undefined, note: note.trim() || undefined,
    }),
    onSuccess: () => {
      toast.push('success', after === 0 ? `${inv.invoice_number} is fully paid.` : `Recorded. ${rupees(after)} still pending.`);
      qc.invalidateQueries({ queryKey: ['payment-summary'] });
      qc.invalidateQueries({ predicate: isInvoiceQuery });
      onClose();
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const quick = (fraction: number) => setAmount(String(Math.round(inv.pending_paise * fraction) / 100));

  return (
    <Modal
      open title={`Record payment — ${inv.invoice_number}`} onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={save.isPending || amountPaise <= 0 || after < 0} onClick={() => save.mutate()}>
            Record {amountPaise > 0 ? rupees(amountPaise) : ''}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-3 mb-4 text-13">
        <Amount label="Invoice total" paise={inv.total_paise} />
        <Amount label="Received so far" paise={inv.paid_paise} tone="text-[#047857]" />
        <Amount label="Pending" paise={inv.pending_paise} tone="text-[#b45309] font-semibold" />
      </div>
      <Field label="Amount received (₹)" hint={after > 0 ? `${rupees(after)} will still be pending — record the rest as another instalment later.` : after === 0 ? 'This clears the invoice.' : `At most ${rupees(inv.pending_paise)}.`}>
        <input className={inputClass} type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
      </Field>
      <div className="flex gap-2 -mt-1 mb-3">
        {[['Full', 1], ['Half', 0.5], ['A third', 1 / 3], ['A quarter', 0.25]].map(([label, f]) => (
          <button key={label as string} type="button" onClick={() => quick(f as number)}
            className="h-7 px-3 text-12 rounded-full border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50">
            {label as string}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Received on">
          <input className={inputClass} type="date" max={istToday()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        <Field label="Mode">
          <select className={inputClass} value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)}>
            {(Object.keys(PAYMENT_MODE_LABEL) as PaymentMode[]).map((m) => <option key={m} value={m}>{PAYMENT_MODE_LABEL[m]}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Reference (UTR, cheque no., UPI ID…)">
        <input className={inputClass} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
      </Field>
      <Field label="Note">
        <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. 1st of 3 agreed instalments" />
      </Field>
    </Modal>
  );
}

// ── Side cards ────────────────────────────────────────────────────────────

function Ageing({ ageing }: { ageing: SummaryResponse['ageing'] }) {
  const parts = [
    { label: 'Not yet due', value: ageing.current, color: '#2f62b0' },
    { label: '1–30 days overdue', value: ageing.d1_30, color: '#f59e0b' },
    { label: '31–60 days', value: ageing.d31_60, color: '#f97316' },
    { label: '61–90 days', value: ageing.d61_90, color: '#ef4444' },
    { label: 'Over 90 days', value: ageing.d90_plus, color: '#991b1b' },
  ];
  const total = parts.reduce((t, p) => t + p.value, 0);
  return (
    <ListCard title="Pending by age">
      <div className="px-5 py-4">
        {total === 0 ? <div className="text-13 text-neutral-500">Nothing pending.</div> : (
          <>
            <div className="flex h-2.5 rounded-full overflow-hidden bg-neutral-100" aria-hidden>
              {parts.filter((p) => p.value).map((p) => (
                <div key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
              ))}
            </div>
            <ul className="mt-4 space-y-2">
              {parts.map((p) => (
                <li key={p.label} className="flex items-center gap-2 text-13">
                  <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: p.color }} />
                  <span className="text-neutral-600 flex-1">{p.label}</span>
                  <span className={`tabular-nums ${p.value ? 'text-neutral-900' : 'text-neutral-400'}`}><M paise={p.value} /></span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </ListCard>
  );
}

function RecentPayments({ items }: { items: SummaryResponse['recent_payments'] }) {
  return (
    <ListCard title={<span className="inline-flex items-center gap-2"><Wallet size={15} /> Recent payments</span>}>
      {items.length === 0 ? <ListEmpty>No payments recorded yet.</ListEmpty> : (
        <ul className="divide-y divide-neutral-100">
          {items.map((p) => (
            <li key={p.id} className="px-5 py-3 flex items-start gap-3 text-13">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-neutral-900 truncate">{p.client_name}</div>
                <div className="text-11 text-neutral-500">{p.invoice_number} · {PAYMENT_MODE_LABEL[p.mode] ?? p.mode} · {fmtDay(p.paid_on)}</div>
              </div>
              <div className="tabular-nums font-medium text-[#047857] whitespace-nowrap"><M paise={p.amount_paise} /></div>
            </li>
          ))}
        </ul>
      )}
    </ListCard>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Workstation's invoice queries ('invoices.list', 'invoices.get', …) — refreshed after a payment. */
const isInvoiceQuery = (q: { queryKey: readonly unknown[] }) => String(q.queryKey[0]).startsWith('invoices.');

function reminderLink(c: ClientSummary): string {
  const digits = (c.contact_number ?? '').replace(/\D/g, '');
  const phone = digits.length === 10 ? `91${digits}` : digits;
  const text = `Dear ${c.client_name}, this is a gentle reminder that ${rupees(c.pending_paise)} is pending against `
    + `${c.open_invoices} invoice${c.open_invoices === 1 ? '' : 's'}`
    + (c.oldest_due_date ? ` (oldest due ${fmtDay(c.oldest_due_date)})` : '')
    + '. Kindly arrange the payment at the earliest. Thank you.';
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

function exportCsv(rows: ClientSummary[]) {
  const head = ['Client', 'Code', 'Invoices', 'Open invoices', 'Invoiced (₹)', 'Received (₹)', 'Pending (₹)', 'Overdue (₹)', 'Status', 'Oldest due', 'Last payment'];
  const cell = (v: string | number | null) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const r = (p: number) => (p / 100).toFixed(2);
  const lines = [head, ...rows.map((c) => [
    c.client_name, c.client_code, c.invoices, c.open_invoices, r(c.invoiced_paise), r(c.paid_paise), r(c.pending_paise),
    r(c.overdue_paise), STATE_LOOK[c.status].label, c.oldest_due_date, c.last_payment_on,
  ])].map((l) => l.map(cell).join(','));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `payment-summary-${istToday()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
