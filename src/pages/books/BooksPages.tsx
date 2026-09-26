import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { booksApi, errorText, type ZRecord } from '@/modules/books/api';
import { useBooks, useOrg } from '@/modules/books/context';
import { Badge, Btn, Cell, Empty, ErrorState, Field, KV, Modal, Notice, NumberInput, PageHeader, Pager, Row, Section, Select, Skeleton, Table, TextInput, date, money, today } from '@/modules/books/ui';
import { DetailDrawer, EntityListPage, RecordActions, RESOURCES } from './EntityList';
import { isCashAcct, useAccountOptions, useLookup } from './forms';

/** A resource list page, e.g. /books/sales/invoices → RESOURCES.invoices. */
export function ResourcePage({ entity }: { entity: string }) {
  return <EntityListPage key={entity} resource={RESOURCES[entity]} />;
}

// ── customer / vendor detail ──────────────────────────────────────────────
export function ContactDetailPage({ kind }: { kind: 'customer' | 'vendor' }) {
  const { id = '' } = useParams();
  const org = useOrg();
  const resource = RESOURCES[kind === 'customer' ? 'customers' : 'vendors'];
  const q = useQuery({ queryKey: ['books', org.id, 'record', resource.entity, id], queryFn: () => booksApi.org(org.id).get(resource.entity, id) });
  const tabs = kind === 'customer'
    ? [['invoices', 'Invoices'], ['estimates', 'Estimates'], ['salesorders', 'Sales Orders'], ['customerpayments', 'Payments'], ['creditnotes', 'Credit Notes']]
    : [['bills', 'Bills'], ['purchaseorders', 'Purchase Orders'], ['vendorpayments', 'Payments'], ['expenses', 'Expenses'], ['vendorcredits', 'Debit Notes']];
  const [tab, setTab] = useState(tabs[0][0]);
  const back = kind === 'customer' ? '/books/customers' : '/books/vendors';
  if (q.isLoading) return <Skeleton rows={6} />;
  if (q.isError) return <Section><ErrorState error={errorText(q.error)} onRetry={() => q.refetch()} /></Section>;
  const r = q.data!;
  const addr = (a: ZRecord | undefined) => (a ? [a.attention, a.address, a.street2, [a.city, a.state, a.zip].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ') : '');
  return (
    <div className="space-y-4">
      <Link to={back} className="inline-flex items-center gap-1 text-13 text-inkMuted hover:text-ink"><ArrowLeft size={14} />All {kind}s</Link>
      <PageHeader title={r.contact_name} subtitle={r.company_name} right={<RecordActions resource={resource} record={r} onClose={() => history.back()} />} />
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Section title="Details" className="xl:col-span-2"><div className="p-4"><KV items={[...resource.detail(r, org.currency_code), ['Billing address', addr(r.billing_address)], ['Shipping address', addr(r.shipping_address)], ['Notes', r.notes]]} /></div></Section>
        <Section title="Contact persons">
          {((r.contact_persons as ZRecord[]) ?? []).length === 0 ? <Empty title="No contact persons." /> : (
            <div className="divide-y divide-border">{(r.contact_persons as ZRecord[]).map((p) => (
              <div key={p.contact_person_id} className="px-4 py-2 text-13"><div className="font-medium">{[p.salutation, p.first_name, p.last_name].filter(Boolean).join(' ')}{p.is_primary_contact ? <span className="text-inkMuted font-normal"> · primary</span> : null}</div><div className="text-inkMuted">{[p.email, p.phone || p.mobile].filter(Boolean).join(' · ')}</div></div>
            ))}</div>
          )}
        </Section>
      </div>
      <div className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map(([k, l]) => <button key={k} type="button" onClick={() => setTab(k)} className={`px-3 h-9 text-13 border-b-2 -mb-px ${tab === k ? 'border-primary text-ink font-medium' : 'border-transparent text-inkMuted hover:text-ink'}`}>{l}</button>)}
      </div>
      <EntityListPage key={tab} resource={RESOURCES[tab]} fixedParams={{ [kind === 'customer' ? 'customer_id' : 'vendor_id']: id }} embedded />
    </div>
  );
}

// ── payments ──────────────────────────────────────────────────────────────
export function PaymentsPage() {
  const [side, setSide] = useState<'customerpayments' | 'vendorpayments'>('customerpayments');
  return (
    <div className="space-y-3">
      <div className="flex gap-1 border-b border-border">
        {([['customerpayments', 'Payments received'], ['vendorpayments', 'Payments made']] as const).map(([k, l]) => (
          <button key={k} type="button" onClick={() => setSide(k)} className={`px-3 h-9 text-13 border-b-2 -mb-px ${side === k ? 'border-primary text-ink font-medium' : 'border-transparent text-inkMuted hover:text-ink'}`}>{l}</button>
        ))}
      </div>
      <EntityListPage key={side} resource={RESOURCES[side]} />
    </div>
  );
}

// ── banking ───────────────────────────────────────────────────────────────
const TXN_FILTERS = [['Status.All', 'All'], ['Status.Uncategorized', 'Uncategorized'], ['Status.Categorized', 'Categorized'], ['Status.ManuallyAdded', 'Manually added'], ['Status.Excluded', 'Excluded']].map(([value, label]) => ({ value, label }));

function useBankAccounts() {
  return useLookup('bankaccounts');
}

export function BankingPage() {
  const accounts = useBankAccounts();
  const [account, setAccount] = useState('');
  const [filter, setFilter] = useState('Status.All');
  const [adding, setAdding] = useState(false);
  const { can } = useBooks();
  const chosen = account || String(accounts.data?.items[0]?.account_id ?? '');
  return (
    <div className="space-y-4">
      <EntityListPage resource={RESOURCES.bankaccounts} />
      <PageHeader title="Bank transactions" subtitle="Transactions recorded or imported into Zoho Books for the selected account." right={can.accountant && chosen ? <Btn onClick={() => setAdding(true)}><Plus size={14} />Add transaction</Btn> : null} />
      <div className="flex flex-wrap gap-2">
        <div className="w-72"><Select value={chosen} onChange={setAccount} options={(accounts.data?.items ?? []).map((a) => ({ value: String(a.account_id), label: a.account_name }))} placeholder={accounts.isLoading ? 'Loading…' : accounts.data?.items.length ? undefined : 'No bank accounts'} /></div>
        <div className="w-48"><Select value={filter} onChange={setFilter} options={TXN_FILTERS} /></div>
      </div>
      {chosen ? <TransactionsTable account={chosen} filter={filter} /> : <Section><Empty title="No bank accounts in Zoho Books." /></Section>}
      <Notice>Bank feeds and statement imports are set up in Zoho Books; imported lines appear here once Zoho has them.</Notice>
      {adding ? <ManualTxnForm account={chosen} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function TransactionsTable({ account, filter, onMatch, onCategorize }: { account: string; filter: string; onMatch?: (t: ZRecord) => void; onCategorize?: (t: ZRecord) => void }) {
  const org = useOrg();
  const { can } = useBooks();
  const qc = useQueryClient();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['books', org.id, 'list', 'banktransactions', account, filter, page], queryFn: () => booksApi.org(org.id).list('banktransactions', { account_id: account, filter_by: filter, page, per_page: 25, sort_column: 'date', sort_order: 'D' }) });
  const act = useMutation({
    mutationFn: ({ id, a }: { id: string; a: string }) => booksApi.org(org.id).action('banktransactions', id, a),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['books', org.id] }); toast.push('success', r.message || 'Done.'); },
    onError: (e) => toast.push('error', errorText(e)),
  });
  if (q.isLoading) return <Section><Skeleton rows={6} /></Section>;
  if (q.isError) return <Section><ErrorState error={errorText(q.error)} onRetry={() => q.refetch()} /></Section>;
  const items = q.data!.items;
  return (
    <Section>
      {items.length === 0 ? <Empty title="No transactions found." /> : (
        <Table cols={[{ label: 'Date' }, { label: 'Description' }, { label: 'Reference' }, { label: 'Type' }, { label: 'Status' }, { label: 'Deposit', right: true }, { label: 'Withdrawal', right: true }, { label: '' }]} minWidth={900}>
          {items.map((t) => {
            const debit = t.debit_or_credit === 'debit';
            const st = String(t.status ?? '').toLowerCase();
            return (
              <Row key={t.transaction_id} onClick={st === 'uncategorized' ? undefined : () => setOpen(String(t.transaction_id))}>
                <Cell muted>{date(t.date)}</Cell>
                <Cell>{t.description || t.payee || '—'}</Cell>
                <Cell muted>{t.reference_number || '—'}</Cell>
                <Cell muted className="capitalize">{String(t.transaction_type ?? '').replace(/_/g, ' ') || '—'}</Cell>
                <Cell><Badge status={st} /></Cell>
                <Cell right>{debit ? '' : money(t.amount, t.currency_code ?? org.currency_code)}</Cell>
                <Cell right>{debit ? money(t.amount, t.currency_code ?? org.currency_code) : ''}</Cell>
                <Cell right>
                  {can.accountant ? (
                    <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                      {st === 'uncategorized' && onMatch ? <Btn variant="ghost" onClick={() => onMatch(t)}>Match</Btn> : null}
                      {st === 'uncategorized' && onCategorize ? <Btn variant="ghost" onClick={() => onCategorize(t)}>Categorize</Btn> : null}
                      {st === 'uncategorized' ? <Btn variant="ghost" onClick={() => act.mutate({ id: String(t.transaction_id), a: 'exclude' })}>Exclude</Btn> : null}
                      {st === 'excluded' ? <Btn variant="ghost" onClick={() => act.mutate({ id: String(t.transaction_id), a: 'restore' })}>Restore</Btn> : null}
                      {st === 'matched' ? <Btn variant="ghost" onClick={() => act.mutate({ id: String(t.transaction_id), a: 'unmatch' })}>Unmatch</Btn> : null}
                      {st === 'categorized' ? <Btn variant="ghost" onClick={() => act.mutate({ id: String(t.transaction_id), a: 'uncategorize' })}>Uncategorize</Btn> : null}
                    </div>
                  ) : null}
                </Cell>
              </Row>
            );
          })}
        </Table>
      )}
      <Pager page={page} hasMore={q.data!.has_more} onPage={setPage} loading={q.isFetching} />
      {open ? <DetailDrawer resource={{ entity: 'banktransactions', title: 'Bank transactions', singular: 'transaction', idField: 'transaction_id', nameField: 'reference_number', empty: '', columns: [], detail: (r, c) => [['Date', date(r.date)], ['Amount', money(r.amount, r.currency_code ?? c)], ['Type', r.transaction_type], ['Status', <Badge status={r.status} />], ['Reference', r.reference_number], ['Description', r.description], ['Payee', r.payee], ['Account', r.account_name], ['Offset account', r.offset_account_name]] }} id={open} onClose={() => setOpen(null)} /> : null}
    </Section>
  );
}

function ManualTxnForm({ account, onClose }: { account: string; onClose: () => void }) {
  const org = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState({ transaction_type: 'deposit', date: today(), amount: '', reference_number: '', description: '' });
  const m = useMutation({
    mutationFn: () => booksApi.org(org.id).create('banktransactions', { from_account_id: account, transaction_type: v.transaction_type, date: v.date, amount: Number(v.amount), reference_number: v.reference_number || undefined, description: v.description || undefined }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['books', org.id] }); toast.push('success', 'Transaction added in Zoho Books.'); onClose(); },
  });
  return (
    <Modal title="Add bank transaction" onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" loading={m.isPending} disabled={!(Number(v.amount) > 0)} onClick={() => m.mutate()}>Save</Btn></>}>
      <div className="space-y-3">
        {m.error ? <Notice tone="error">{errorText(m.error)}</Notice> : null}
        <Field label="Type"><Select value={v.transaction_type} onChange={(x) => setV({ ...v, transaction_type: x })} options={[['deposit', 'Deposit'], ['expense', 'Expense'], ['transfer_fund', 'Transfer'], ['owner_contribution', 'Owner contribution'], ['owner_drawings', 'Owner drawings'], ['other_income', 'Other income'], ['interest_income', 'Interest income']].map(([value, label]) => ({ value, label }))} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date"><TextInput type="date" value={v.date} onChange={(x) => setV({ ...v, date: x })} /></Field>
          <Field label="Amount"><NumberInput value={v.amount} onChange={(x) => setV({ ...v, amount: x })} /></Field>
        </div>
        <Field label="Reference"><TextInput value={v.reference_number} onChange={(x) => setV({ ...v, reference_number: x })} /></Field>
        <Field label="Description"><TextInput value={v.description} onChange={(x) => setV({ ...v, description: x })} /></Field>
        <p className="text-12 text-inkMuted">Zoho Books validates which accounts each transaction type needs and reports anything missing.</p>
      </div>
    </Modal>
  );
}

// ── reconciliation ────────────────────────────────────────────────────────
const RECON_TABS = [['Status.Uncategorized', 'Unmatched'], ['Status.Categorized', 'Matched & categorized'], ['Status.Excluded', 'Excluded'], ['Status.All', 'All synced']] as const;

export function ReconciliationPage() {
  const accounts = useBankAccounts();
  const [account, setAccount] = useState('');
  const [tab, setTab] = useState<string>(RECON_TABS[0][0]);
  const [matching, setMatching] = useState<ZRecord | null>(null);
  const [categorizing, setCategorizing] = useState<ZRecord | null>(null);
  const chosen = account || String(accounts.data?.items[0]?.account_id ?? '');
  const acct = accounts.data?.items.find((a) => String(a.account_id) === chosen);
  return (
    <div className="space-y-4">
      <PageHeader title="Reconciliation" subtitle="Match and categorize bank lines against Zoho Books transactions." />
      <Notice>
        <b>Synced</b> lines exist in Zoho for the account. <b>Unmatched</b> lines still need a match or category. <b>Matched / categorized</b> lines are tied to a Zoho transaction.
        Closing a statement period as <b>Reconciled</b> is not exposed by the Zoho Books API — finish that step in Zoho Books.
      </Notice>
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-72"><Select value={chosen} onChange={setAccount} options={(accounts.data?.items ?? []).map((a) => ({ value: String(a.account_id), label: a.account_name }))} placeholder={accounts.isLoading ? 'Loading…' : accounts.data?.items.length ? undefined : 'No bank accounts'} /></div>
        {acct ? <span className="text-13 text-inkMuted">Balance in Zoho Books: <span className="text-ink tabular-nums">{money(acct.balance, acct.currency_code)}</span></span> : null}
      </div>
      {chosen ? <UnmatchedSummary account={chosen} /> : null}
      <div className="flex flex-wrap gap-1 border-b border-border">
        {RECON_TABS.map(([k, l]) => <button key={k} type="button" onClick={() => setTab(k)} className={`px-3 h-9 text-13 border-b-2 -mb-px ${tab === k ? 'border-primary text-ink font-medium' : 'border-transparent text-inkMuted hover:text-ink'}`}>{l}</button>)}
      </div>
      {chosen ? <TransactionsTable key={`${chosen}-${tab}`} account={chosen} filter={tab} onMatch={setMatching} onCategorize={setCategorizing} /> : <Section><Empty title="No bank accounts in Zoho Books." /></Section>}
      {matching ? <MatchModal txn={matching} onClose={() => setMatching(null)} /> : null}
      {categorizing ? <CategorizeModal txn={categorizing} account={chosen} onClose={() => setCategorizing(null)} /> : null}
    </div>
  );
}

function UnmatchedSummary({ account }: { account: string }) {
  const org = useOrg();
  const q = useQuery({ queryKey: ['books', org.id, 'list', 'banktransactions', account, 'unmatched-summary'], queryFn: () => booksApi.org(org.id).list('banktransactions', { account_id: account, filter_by: 'Status.Uncategorized', per_page: 200 }) });
  if (!q.data) return null;
  const inflow = q.data.items.filter((t) => t.debit_or_credit !== 'debit').reduce((s, t) => s + Number(t.amount || 0), 0);
  const outflow = q.data.items.filter((t) => t.debit_or_credit === 'debit').reduce((s, t) => s + Number(t.amount || 0), 0);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div className="bg-surface border border-border rounded p-3"><div className="text-11 uppercase tracking-[0.06em] text-inkMuted">Unmatched lines</div><div className="text-18 font-semibold tabular-nums">{q.data.items.length}{q.data.has_more ? '+' : ''}</div></div>
      <div className="bg-surface border border-border rounded p-3"><div className="text-11 uppercase tracking-[0.06em] text-inkMuted">Unmatched deposits</div><div className="text-18 font-semibold tabular-nums">{money(inflow, org.currency_code)}</div></div>
      <div className="bg-surface border border-border rounded p-3"><div className="text-11 uppercase tracking-[0.06em] text-inkMuted">Variance (net unmatched)</div><div className={`text-18 font-semibold tabular-nums ${inflow - outflow ? 'text-danger' : ''}`}>{money(inflow - outflow, org.currency_code)}</div></div>
    </div>
  );
}

function MatchModal({ txn, onClose }: { txn: ZRecord; onClose: () => void }) {
  const org = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['books', org.id, 'matches', txn.transaction_id], queryFn: () => booksApi.org(org.id).matches(String(txn.transaction_id)) });
  const [picked, setPicked] = useState<ZRecord[]>([]);
  const m = useMutation({
    mutationFn: () => booksApi.org(org.id).action('banktransactions', String(txn.transaction_id), 'match', { transactions_to_be_matched: picked.map((p) => ({ transaction_id: p.transaction_id, transaction_type: p.transaction_type })) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['books', org.id] }); toast.push('success', 'Matched in Zoho Books.'); onClose(); },
  });
  const toggle = (p: ZRecord) => setPicked((xs) => (xs.includes(p) ? xs.filter((x) => x !== p) : [...xs, p]));
  const sum = picked.reduce((t, p) => t + Number(p.amount || 0), 0);
  return (
    <Modal title="Match bank line" onClose={onClose} wide footer={<><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" disabled={!picked.length} loading={m.isPending} onClick={() => m.mutate()}>Match</Btn></>}>
      <div className="space-y-3">
        <p className="text-13">{date(txn.date)} · {txn.description || txn.payee || 'Bank line'} · <b className="tabular-nums">{money(txn.amount, org.currency_code)}</b></p>
        {m.error ? <Notice tone="error">{errorText(m.error)}</Notice> : null}
        {q.isLoading ? <Skeleton rows={3} /> : q.isError ? <ErrorState error={errorText(q.error)} /> : q.data!.items.length === 0 ? <Empty title="Zoho Books found no matching transactions.">Categorize the line instead, or record the missing payment first.</Empty> : (
          <Table cols={[{ label: '' }, { label: 'Date' }, { label: 'Type' }, { label: 'Reference' }, { label: 'Contact' }, { label: 'Amount', right: true }]} minWidth={620}>
            {q.data!.items.map((p, i) => (
              <Row key={i} onClick={() => toggle(p)}>
                <Cell><input type="checkbox" readOnly checked={picked.includes(p)} aria-label="Select" /></Cell>
                <Cell muted>{date(p.date)}</Cell><Cell muted className="capitalize">{String(p.transaction_type ?? '').replace(/_/g, ' ')}</Cell>
                <Cell>{p.reference_number || p.transaction_number || '—'}</Cell><Cell muted>{p.contact_name || '—'}</Cell>
                <Cell right>{money(p.amount, org.currency_code)}</Cell>
              </Row>
            ))}
          </Table>
        )}
        {picked.length ? <p className={`text-12 ${Math.abs(sum - Number(txn.amount)) > 0.001 ? 'text-danger' : 'text-inkMuted'}`}>Selected {money(sum, org.currency_code)} · difference {money(Number(txn.amount) - sum, org.currency_code)}</p> : null}
      </div>
    </Modal>
  );
}

function CategorizeModal({ txn, account, onClose }: { txn: ZRecord; account: string; onClose: () => void }) {
  const org = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const debit = txn.debit_or_credit === 'debit';
  const all = useAccountOptions(() => true);
  const cash = useAccountOptions(isCashAcct);
  const types = debit ? [['expense', 'Expense'], ['owner_drawings', 'Owner drawings'], ['transfer_fund', 'Transfer to another account'], ['card_payment', 'Card payment']] : [['deposit', 'Deposit'], ['other_income', 'Other income'], ['interest_income', 'Interest income'], ['owner_contribution', 'Owner contribution'], ['transfer_fund', 'Transfer from another account']];
  const [v, setV] = useState({ transaction_type: types[0][0], other: '', reference_number: String(txn.reference_number ?? ''), description: String(txn.description ?? '') });
  const m = useMutation({
    mutationFn: () => booksApi.org(org.id).action('banktransactions', String(txn.transaction_id), 'categorize', {
      transaction_type: v.transaction_type, amount: Number(txn.amount), date: txn.date,
      from_account_id: debit ? account : v.other, to_account_id: debit ? v.other : account,
      reference_number: v.reference_number || undefined, description: v.description || undefined,
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['books', org.id] }); toast.push('success', 'Categorized in Zoho Books.'); onClose(); },
  });
  return (
    <Modal title="Categorize bank line" onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" disabled={!v.other} loading={m.isPending} onClick={() => m.mutate()}>Categorize</Btn></>}>
      <div className="space-y-3">
        <p className="text-13">{date(txn.date)} · {debit ? 'Withdrawal' : 'Deposit'} · <b className="tabular-nums">{money(txn.amount, org.currency_code)}</b></p>
        {m.error ? <Notice tone="error">{errorText(m.error)}</Notice> : null}
        <Field label="Category"><Select value={v.transaction_type} onChange={(x) => setV({ ...v, transaction_type: x })} options={types.map(([value, label]) => ({ value, label }))} /></Field>
        <Field label={debit ? 'To account' : 'From account'}><Select value={v.other} onChange={(x) => setV({ ...v, other: x })} options={v.transaction_type === 'transfer_fund' ? cash.filter((a) => a.value !== account) : all.filter((a) => a.value !== account)} placeholder="—" /></Field>
        <Field label="Reference"><TextInput value={v.reference_number} onChange={(x) => setV({ ...v, reference_number: x })} /></Field>
        <Field label="Description"><TextInput value={v.description} onChange={(x) => setV({ ...v, description: x })} /></Field>
      </div>
    </Modal>
  );
}

// ── taxes ─────────────────────────────────────────────────────────────────
export function TaxesPage() {
  const org = useOrg();
  return (
    <div className="space-y-3">
      <EntityListPage resource={RESOURCES.taxes} />
      {org.currency_code === 'INR' ? <Notice>For GST organisations Zoho Books keeps CGST, SGST, IGST and cess as component taxes and tax groups; Audit OS shows them exactly as configured there and applies no GST rules of its own.</Notice> : null}
    </div>
  );
}

// ── reports ───────────────────────────────────────────────────────────────
export function ReportsPage() {
  const org = useOrg();
  const defs = useQuery({ queryKey: ['books', org.id, 'reports'], queryFn: () => booksApi.org(org.id).reports(), staleTime: Infinity });
  const now = new Date();
  const fy = `${now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1}-04-01`;
  const [sel, setSel] = useState<string | null>(null);
  const [range, setRange] = useState({ from: fy, to: today() });
  const [run, setRun] = useState(range);
  const def = defs.data?.items.find((d) => d.id === sel);
  const rep = useQuery({ queryKey: ['books', org.id, 'report', sel, run], queryFn: () => booksApi.org(org.id).report(sel!, run.from, run.to), enabled: Boolean(sel && def?.available) });
  const groups = [...new Set((defs.data?.items ?? []).map((d) => d.group))];
  return (
    <div className="space-y-4">
      <PageHeader title="Reports" subtitle="Built from Zoho Books records. Reports Zoho does not expose through its API are marked unavailable." />
      {defs.isLoading ? <Skeleton rows={4} /> : defs.isError ? <ErrorState error={errorText(defs.error)} /> : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {groups.map((g) => (
            <Section key={g} title={g}>
              <div className="py-1">{defs.data!.items.filter((d) => d.group === g).map((d) => (
                <button key={d.id} type="button" onClick={() => setSel(d.id)} className={`block w-full text-left px-4 py-1.5 text-13 ${sel === d.id ? 'text-ink font-medium bg-canvas' : d.available ? 'text-ink hover:bg-canvas' : 'text-inkFaint hover:bg-canvas'}`}>
                  {d.title}{d.available ? null : <span className="text-11"> · unavailable</span>}
                </button>
              ))}</div>
            </Section>
          ))}
        </div>
      )}
      {def ? (
        <Section title={def.title} right={def.available && def.dated ? (
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} className="h-8 px-2 text-12 bg-surface border border-border rounded" aria-label="From" />
            <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} className="h-8 px-2 text-12 bg-surface border border-border rounded" aria-label="To" />
            <Btn onClick={() => setRun(range)} loading={rep.isFetching}>Run</Btn>
          </div>
        ) : null}>
          {!def.available ? <Empty title="This report is not available through the current Zoho Books API integration.">Open it in Zoho Books for the official figures.</Empty>
            : rep.isLoading ? <Skeleton rows={6} /> : rep.isError ? <ErrorState error={errorText(rep.error)} onRetry={() => rep.refetch()} /> : rep.data ? (
              <>
                <div className="px-4 py-2 text-12 text-inkMuted border-b border-border">{rep.data.note}{rep.data.truncated ? ' Covers the most recent records only — the organisation has more than one report reads.' : ''}</div>
                {rep.data.rows.length === 0 ? <Empty title="No data for this report." /> : (
                  <Table cols={rep.data.columns.map((c) => ({ label: c.label, right: c.money || c.key === 'count' }))} minWidth={Math.max(560, rep.data.columns.length * 130)}>
                    {rep.data.rows.map((r, i) => <Row key={i}>{rep.data!.columns.map((c) => <Cell key={c.key} right={c.money || c.key === 'count'}>{c.money ? money(r[c.key], org.currency_code) : r[c.key] ?? '—'}</Cell>)}</Row>)}
                    {rep.data.totals ? <Row>{rep.data.columns.map((c) => <Cell key={c.key} right={c.money || c.key === 'count'} className="font-semibold">{c.money ? money(rep.data!.totals![c.key], org.currency_code) : rep.data!.totals![c.key] ?? ''}</Cell>)}</Row> : null}
                  </Table>
                )}
              </>
            ) : null}
        </Section>
      ) : null}
    </div>
  );
}
