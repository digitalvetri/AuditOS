import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileText, AlertTriangle, Download, CheckCircle2, RotateCcw, Trash2, Wand2, Pencil, X } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import {
  auditAutomationApi,
  type AaJobDetail,
  type AaTxn,
  type AaTxnStatus,
  type AaRule,
} from '@/modules/tools/audit-automation/api';

/**
 * /audit-automation/bank/jobs/:jobId — one bank statement, read into
 * transactions: review → fix/accept/exclude → ledgers (by hand or by rule)
 * → approve → Tally XML.
 *
 * The server re-checks the running balance after every edit, so fixing
 * one amount clears (or raises) flags on the rows after it. Approval needs
 * no open flags, a ledger on every row and the bank's own Tally ledger.
 */

const inr = (paise: number | null | undefined) =>
  paise == null ? '' : (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const FLAG_TEXT: Record<string, string> = {
  BALANCE_BREAK: 'Balance does not follow from the row above',
  AUTO_SWAPPED: 'Debit/credit were read the wrong way round — corrected, please confirm',
  NO_AMOUNT: 'No withdrawal or deposit amount',
  BOTH_AMOUNTS: 'Both a withdrawal and a deposit',
  DATE_ORDER: 'Date is earlier than the row above',
  OUT_OF_PERIOD: 'Date is outside the chosen financial year',
  NO_BALANCE: 'No running balance on this row',
  // Introduced per REPOTIC §1: a row without a Tally ledger is NOT OK.
  // The row stays in "Needs review" until a ledger is picked.
  NO_LEDGER: 'No Tally ledger yet — pick one or accept to postpone',
  ACCEPTED: 'Accepted as read',
};
const JOB_FLAG_TEXT: Record<string, string> = {
  BALANCE_BREAKS: 'Some rows break the running balance',
  DUPLICATE_ROWS: 'Some rows were already in an earlier statement for this client',
  OPENING_BALANCE_MISMATCH: "Opening balance does not match the statement's own figure",
  CLOSING_BALANCE_MISMATCH: "Closing balance does not match the statement's own figure",
  PAGE_COUNT_MISMATCH: 'Page count differs from the "Page N of M" footer',
  ADAPTER_UNCERTAIN: 'Bank could not be confirmed from the letterhead',
  ADAPTER_MISMATCH: 'Uploaded despite the letterhead naming another bank',
  UNKNOWN_FORMAT: 'Bank not in the list',
};
const VOUCHERS = ['payment', 'receipt', 'contra', 'journal'] as const;
const TABS: { key: 'all' | AaTxnStatus; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'flagged', label: 'Needs review' }, { key: 'ok', label: 'OK' },
  { key: 'duplicate', label: 'Duplicates' }, { key: 'excluded', label: 'Excluded' },
];
const PAGE = 100;

export function BankJobDetailPage() {
  const { jobId = '' } = useParams();
  const q = useQuery({
    queryKey: ['aa.job', jobId],
    enabled: Boolean(jobId),
    queryFn: () => auditAutomationApi.job(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.job.status;
      return status === 'queued' || status === 'extracting' ? 1500 : false;
    },
  });

  return (
    <div className="max-w-[1240px] mx-auto" data-testid="aa-bank-job">
      <div className="mb-4">
        <Link to="/audit-automation/bank" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900">
          <ArrowLeft size={14} strokeWidth={1.75} /> Bank statements
        </Link>
      </div>
      {q.isLoading ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">Loading…</div>
      ) : q.error ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-danger">Could not load this job.</div>
      ) : q.data ? (
        <JobDetail detail={q.data} />
      ) : null}
    </div>
  );
}

function JobDetail({ detail }: { detail: AaJobDetail }) {
  const { job, source_document: doc } = detail;
  const statusLabel: Record<typeof job.status, string> = { queued: 'Queued', extracting: 'Reading', extracted: 'Read', failed: 'Failed' };
  const statusColor: Record<typeof job.status, string> = {
    queued: 'border-l-neutral-400 text-neutral-700', extracting: 'border-l-primary text-primary',
    extracted: 'border-l-success text-success', failed: 'border-l-danger text-danger',
  };
  return (
    <div className="space-y-4">
      <header className="bg-white border border-neutral-200 rounded p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-11 tracking-[0.06em] text-neutral-500 mb-1">BANK STATEMENT</div>
            <h1 className="text-14 font-semibold text-neutral-900 truncate">{doc?.original_filename ?? job.id.slice(0, 8)}</h1>
            <div className="text-12 text-neutral-500 mt-1">
              {doc ? `${doc.bank.name} · ${doc.bank_account.account_number_masked} · ` : ''}
              {job.period_from ? `${job.period_from} to ${job.period_to}` : `Uploaded ${new Date(job.created_at).toLocaleString()}`}
              {job.fy ? ` · FY ${job.fy}` : ''}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {job.review_status === 'approved' ? (
              <span className="inline-flex items-center gap-1 text-13 font-medium text-success"><CheckCircle2 size={14} /> Approved</span>
            ) : null}
            <span className={'inline-flex items-center pl-2 pr-2 border-l-2 text-13 font-medium ' + statusColor[job.status]}>
              {statusLabel[job.status]}{job.status === 'queued' || job.status === 'extracting' ? ` · ${job.progress}%` : ''}
            </span>
          </div>
        </div>
        {job.flags.length > 0 ? (
          <div className="mt-4 flex items-start gap-2 border-l-2 border-amber bg-amber/10 px-3 py-2">
            <AlertTriangle size={14} strokeWidth={1.75} className="text-amber mt-0.5" />
            <ul className="text-13 text-neutral-900 space-y-0.5">
              {job.flags.map((f) => <li key={f}>{JOB_FLAG_TEXT[f] ?? f}</li>)}
            </ul>
          </div>
        ) : null}
        {job.error_message ? (
          <div className="mt-4 border-l-2 border-danger bg-canvas px-3 py-2 text-13 text-neutral-900">{job.error_message}</div>
        ) : null}
        {job.status === 'extracted' ? (
          <dl className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-13">
            <Stat label="Opening balance" value={`₹${inr(job.opening_balance_paise)}`} />
            <Stat label="Closing balance" value={`₹${inr(job.closing_balance_paise)}`} />
            <Stat label="Transactions" value={String(job.row_count)} />
            <Stat label="Pages / format" value={`${doc?.page_count ?? '—'} · ${(doc?.source_format ?? 'pdf').toUpperCase()}`} />
          </dl>
        ) : null}
      </header>

      <JobActions detail={detail} />
      {job.status === 'extracted' ? <Transactions detail={detail} /> : null}
      {job.status === 'extracted' && doc ? <RulesPanel clientId={job.client_id} jobId={job.id} locked={job.review_status === 'approved'} /> : null}

      {doc ? (
        <section className="bg-white border border-neutral-200 rounded p-5">
          <div className="text-11 tracking-[0.06em] text-neutral-500 mb-3">SOURCE STATEMENT</div>
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-13">
            <Fact label="Bank" value={doc.bank.name} />
            <Fact label="Account" value={`${doc.bank_account.account_number_masked}${doc.bank_account.label ? ` — ${doc.bank_account.label}` : ''}`} />
            <Fact label="Filename" value={<span className="inline-flex items-center gap-1"><FileText size={12} strokeWidth={1.75} /> {doc.original_filename}</span>} />
            <Fact label="Size" value={`${(doc.file_size / 1024).toFixed(0)} KB`} />
            <Fact label="Pages" value={`${doc.page_count}${doc.declared_page_count && doc.declared_page_count !== doc.page_count ? ` (declared ${doc.declared_page_count})` : ''}`} />
            <Fact label="Encrypted" value={doc.encrypted ? 'Yes — decrypted with the uploader’s authorisation' : 'No'} />
            <Fact label="Uploaded by" value={doc.uploaded_by.label} />
            <Fact label="Uploaded at" value={new Date(doc.uploaded_at).toLocaleString()} />
          </dl>
        </section>
      ) : null}
    </div>
  );
}

function JobActions({ detail }: { detail: AaJobDetail }) {
  const { job } = detail;
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [ledger, setLedger] = useState(job.bank_ledger_name ?? '');
  useEffect(() => { setLedger(job.bank_ledger_name ?? ''); }, [job.bank_ledger_name]);
  const approved = job.review_status === 'approved';
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['aa.job', job.id] }); void qc.invalidateQueries({ queryKey: ['aa.rows', job.id] }); };
  const err = (e: Error) => toast.push('error', e.message);
  const saveLedger = useMutation({ mutationFn: () => auditAutomationApi.updateJob(job.id, { bank_ledger_name: ledger }), onSuccess: () => { refresh(); toast.push('success', 'Bank ledger saved.'); }, onError: err });
  const apply = useMutation({ mutationFn: () => auditAutomationApi.applyRules(job.id), onSuccess: (r) => { refresh(); toast.push('success', `Rules applied — ${r.changed} row${r.changed === 1 ? '' : 's'} updated.`); }, onError: err });
  const approve = useMutation({ mutationFn: () => (approved ? auditAutomationApi.reopen(job.id) : auditAutomationApi.approve(job.id)), onSuccess: () => { refresh(); toast.push('success', approved ? 'Reopened for changes.' : 'Approved — ready for Tally.'); }, onError: err });
  const reprocess = useMutation({ mutationFn: () => auditAutomationApi.reprocess(job.id), onSuccess: () => { refresh(); toast.push('success', 'Reading the statement again.'); }, onError: err });
  const remove = useMutation({ mutationFn: () => auditAutomationApi.remove(job.id), onSuccess: () => { toast.push('success', 'Statement deleted.'); navigate('/audit-automation/bank'); }, onError: err });

  return (
    <section className="bg-white border border-neutral-200 rounded p-4 flex flex-wrap items-end gap-3">
      {job.status === 'extracted' ? (
        <>
          <label className="text-12 text-neutral-600">
            Bank ledger in Tally
            <div className="flex gap-1 mt-1">
              <input value={ledger} onChange={(e) => setLedger(e.target.value)} disabled={approved} placeholder="e.g. HDFC Bank A/c 1234"
                className="h-8 w-60 px-2 text-13 border border-neutral-300 rounded disabled:bg-neutral-50" />
              <Button variant="secondary" size="sm" onClick={() => saveLedger.mutate()} disabled={approved || saveLedger.isPending || ledger === (job.bank_ledger_name ?? '')}>Save</Button>
            </div>
          </label>
          <Button variant="secondary" size="sm" onClick={() => apply.mutate()} disabled={approved || apply.isPending}><Wand2 size={13} /> Apply ledger rules</Button>
          <Button variant="primary" size="sm" onClick={() => approve.mutate()} disabled={approve.isPending}>
            {approved ? <><RotateCcw size={13} /> Reopen</> : <><CheckCircle2 size={13} /> Approve</>}
          </Button>
          <a className={'inline-flex items-center gap-1 h-8 px-3 rounded text-13 font-medium border ' + (approved ? 'bg-primary text-white border-primary hover:opacity-90' : 'pointer-events-none opacity-40 border-neutral-300 text-neutral-500')}
            href={approved ? auditAutomationApi.tallyXmlUrl(job.id) : undefined} download title={approved ? undefined : 'Approve first'}>
            <Download size={13} /> Tally XML
          </a>
          {/* Excel export is gated on the SAME condition as Tally XML — a
              half-mapped statement is the same wrong data in a different
              file (REPOTIC §1). The ?draft=1 variant stays for internal
              review of unreviewed rows; it is intentionally not surfaced
              on the toolbar. */}
          <a className={'inline-flex items-center gap-1 h-8 px-3 rounded text-13 border ' + (approved ? 'border-neutral-300 text-neutral-800 hover:bg-neutral-50' : 'pointer-events-none opacity-40 border-neutral-300 text-neutral-500')}
            href={approved ? auditAutomationApi.workbookUrl(job.id) : undefined} download title={approved ? undefined : 'Approve first'}>
            <Download size={13} /> Excel
          </a>
        </>
      ) : null}
      <div className="flex-1" />
      {job.status !== 'queued' && job.status !== 'extracting' && !approved ? (
        <Button variant="secondary" size="sm" onClick={() => { if (window.confirm('Read the statement again? Your edits to its rows will be discarded.')) reprocess.mutate(); }} disabled={reprocess.isPending}>
          <RotateCcw size={13} /> Re-read
        </Button>
      ) : null}
      <Button variant="secondary" size="sm" onClick={() => { if (window.confirm('Delete this statement and its transactions? The file can be uploaded again afterwards.')) remove.mutate(); }} disabled={remove.isPending}>
        <Trash2 size={13} /> Delete
      </Button>
    </section>
  );
}

function Transactions({ detail }: { detail: AaJobDetail }) {
  const { job } = detail;
  const approved = job.review_status === 'approved';
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'all' | AaTxnStatus>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<AaTxn | null>(null);
  const [ruleFor, setRuleFor] = useState<AaTxn | null>(null);
  useEffect(() => setPage(0), [tab, search]);
  const q = useQuery({
    queryKey: ['aa.rows', job.id, tab, search, page],
    queryFn: () => auditAutomationApi.rows(job.id, { status: tab, search: search || undefined, limit: PAGE, offset: page * PAGE }),
  });
  const rules = useQuery({ queryKey: ['aa.rules', job.client_id], queryFn: () => auditAutomationApi.rules(job.client_id) });
  // The client's real ledger master — rules + distinct ledgers from past
  // approved jobs. Replaces the "unique ledger names from rules" shortcut
  // that let operators save typos like "a" because the datalist is only
  // a suggestion, not a constraint. See LedgerInput's docstring.
  const ledgerMaster = useQuery({
    queryKey: ['aa.ledger-master', job.client_id],
    queryFn: () => auditAutomationApi.ledgerMaster(job.client_id),
    enabled: Boolean(job.client_id),
  });
  const knownLedgers = useMemo(() => {
    const fromRules = (rules.data?.items ?? []).map((r) => r.ledger_name);
    const fromMaster = ledgerMaster.data?.ledgers ?? [];
    return [...new Set([...fromRules, ...fromMaster].filter((s): s is string => Boolean(s)))].sort();
  }, [rules.data, ledgerMaster.data]);
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => auditAutomationApi.updateRow(id, body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['aa.rows', job.id] }); void qc.invalidateQueries({ queryKey: ['aa.job', job.id] }); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const data = q.data;
  const counts = data?.counts ?? {};
  const all = Object.values(counts).reduce((t, n) => t + (n ?? 0), 0);

  return (
    <section className="bg-white border border-neutral-200 rounded">
      <div className="p-4 border-b border-neutral-200 flex flex-wrap items-center gap-2">
        <div className="text-11 tracking-[0.06em] text-neutral-500 mr-2">TRANSACTIONS</div>
        {TABS.map((t) => {
          const n = t.key === 'all' ? all : counts[t.key] ?? 0;
          return (
            <button key={t.key} type="button" onClick={() => setTab(t.key)}
              className={'h-7 px-2.5 rounded text-12 border ' + (tab === t.key ? 'bg-primary text-white border-primary' : 'border-neutral-300 text-neutral-700 hover:bg-neutral-50') + (t.key === 'flagged' && n ? ' font-semibold' : '')}>
              {t.label} · {n}
            </button>
          );
        })}
        <div className="flex-1" />
        {data?.missing_ledger ? <span className="text-12 text-amber">{data.missing_ledger} without a ledger</span> : null}
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search narration, ref, ledger…" className="h-8 w-56 px-2 text-13 border border-neutral-300 rounded" />
      </div>
      {/* Datalist is still referenced by the Make Rule modal input below.
          LedgerInput on each row has its own popover; it doesn't use this. */}
      <datalist id="aa-ledgers">{knownLedgers.map((l) => <option key={l} value={l} />)}</datalist>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[960px] table-fixed text-13">
          <thead>
            <tr className="text-11 uppercase tracking-[0.06em] text-neutral-500 border-b border-neutral-200">
              <th className="text-left px-3 h-8 font-medium w-10">#</th>
              <th className="text-left px-2 font-medium w-[88px]">Date</th>
              <th className="text-left px-2 font-medium">Narration</th>
              <th className="text-right px-2 font-medium w-[104px]">Withdrawal</th>
              <th className="text-right px-2 font-medium w-[104px]">Deposit</th>
              <th className="text-right px-2 font-medium w-[112px]">Balance</th>
              <th className="text-left px-2 font-medium w-[196px]">Ledger · voucher</th>
              <th className="text-left px-2 font-medium w-[96px]">Status</th>
              <th className="px-2 w-[92px]" />
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? <tr><td colSpan={9} className="px-3 py-4 text-neutral-500">Loading…</td></tr> : null}
            {data && data.items.length === 0 ? <tr><td colSpan={9} className="px-3 py-4 text-neutral-500">No transactions here.</td></tr> : null}
            {data?.items.map((r) => {
              const locked = approved || r.status === 'excluded' || r.status === 'duplicate';
              return (
              <tr key={r.id} className={'border-b border-neutral-100 align-top ' + (r.status === 'flagged' ? 'bg-amber/5' : r.status === 'excluded' || r.status === 'duplicate' ? 'text-neutral-400' : '')}>
                <td className="px-3 py-1.5 tabular-nums">{r.seq}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">{r.txn_date}</td>
                <td className="px-2 py-1.5">
                  <div className="break-words">{r.narration}</div>
                  {r.reference ? <div className="text-11 text-neutral-500 break-all">Ref {r.reference}</div> : null}
                  {r.edited ? <div className="text-11 text-primary">Edited — originally read differently</div> : null}
                  {r.flags.filter((f) => f !== 'NO_BALANCE').map((f) => (
                    <div key={f} className={'text-11 mt-0.5 ' + (f === 'ACCEPTED' ? 'text-success' : 'text-amber')}>{FLAG_TEXT[f] ?? f}</div>
                  ))}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.debit_paise ? inr(r.debit_paise) : ''}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.credit_paise ? inr(r.credit_paise) : ''}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{inr(r.balance_paise)}</td>
                <td className="px-2 py-1 space-y-1">
                  <LedgerInput value={r.ledger_name ?? ''} disabled={locked} known={knownLedgers}
                    onSave={(v) => update.mutate({ id: r.id, body: { ledger_name: v } })} />
                  <select value={r.voucher_type ?? ''} disabled={locked}
                    onChange={(e) => update.mutate({ id: r.id, body: { voucher_type: e.target.value || null } })}
                    className="h-7 w-full text-12 border border-neutral-300 rounded bg-white disabled:bg-transparent disabled:border-transparent">
                    <option value="">{r.debit_paise ? 'Payment' : 'Receipt'} (auto)</option>
                    {VOUCHERS.map((v) => <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>)}
                  </select>
                  {r.matched_rule_id ? <div className="text-11 text-neutral-500">by rule</div> : null}
                </td>
                <td className="px-2 py-1.5">
                  <span className={'text-11 px-1.5 py-0.5 rounded border whitespace-nowrap ' + ({ ok: 'border-success/40 text-success bg-success/10', flagged: 'border-amber/50 text-amber bg-amber/15', duplicate: 'border-neutral-200 text-neutral-600', excluded: 'border-neutral-200 text-neutral-500' } as const)[r.status]}>
                    {({ ok: 'OK', flagged: 'Review', duplicate: 'Duplicate', excluded: 'Excluded' } as const)[r.status]}
                  </span>
                </td>
                <td className="px-2 py-1 text-right">
                  {!approved ? (
                    <div className="flex flex-col items-end gap-0.5 text-12">
                      {!locked ? <button type="button" className="text-primary hover:underline inline-flex items-center gap-0.5" onClick={() => setEditing(r)}><Pencil size={11} /> Edit</button> : null}
                      {r.status === 'flagged' ? <button type="button" className="text-success hover:underline" onClick={() => update.mutate({ id: r.id, body: { action: 'accept' } })}>Accept</button> : null}
                      {r.flags.includes('ACCEPTED') ? <button type="button" className="text-neutral-600 hover:underline" onClick={() => update.mutate({ id: r.id, body: { action: 'unaccept' } })}>Undo accept</button> : null}
                      {r.status === 'excluded' || r.status === 'duplicate'
                        ? <button type="button" className="text-neutral-700 hover:underline" onClick={() => update.mutate({ id: r.id, body: { action: 'include' } })}>Include</button>
                        : <button type="button" className="text-neutral-600 hover:underline" onClick={() => update.mutate({ id: r.id, body: { action: 'exclude' } })}>Exclude</button>}
                      {!locked ? <button type="button" className="text-neutral-600 hover:underline" onClick={() => setRuleFor(r)}>Make rule</button> : null}
                    </div>
                  ) : null}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data && data.total > PAGE ? (
        <div className="p-3 flex items-center justify-end gap-2 text-12 text-neutral-600">
          {page * PAGE + 1}–{Math.min(data.total, (page + 1) * PAGE)} of {data.total}
          <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
          <Button variant="secondary" size="sm" disabled={(page + 1) * PAGE >= data.total} onClick={() => setPage(page + 1)}>Next</Button>
        </div>
      ) : null}
      {editing ? <EditRow row={editing} onClose={() => setEditing(null)} onSave={(body) => update.mutateAsync({ id: editing.id, body }).then(() => setEditing(null))} /> : null}
      {ruleFor ? <RuleFromRow row={ruleFor} clientId={job.client_id} jobId={job.id} onClose={() => setRuleFor(null)} /> : null}
    </section>
  );
}

/**
 * Ledger entry — autocomplete against the client's known ledgers, with
 * "Create new ledger" as an EXPLICIT action, not a side effect of typing
 * (REPOTIC §1 fix 2). Typing "a" and tabbing away used to silently save
 * "a" as the ledger name, producing a Tally import that fails on every
 * row. Now:
 *
 *   - Suggestions filter as you type.
 *   - Clicking a suggestion saves it immediately.
 *   - Pressing Enter / blurring with text that does NOT match any known
 *     ledger shows a pending prompt (" ↳ Create new ledger 'X' ") that
 *     the operator must click to confirm. Blurring without confirming
 *     reverts to the previous value, so there is no accidental save.
 *
 * `known` is the client's ledger master from
 * GET /audit-automation/clients/:id/ledger-master.
 */
function LedgerInput({ value, disabled, known, onSave }: {
  value: string; disabled: boolean; known: string[]; onSave: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  const [focused, setFocused] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<string | null>(null);
  useEffect(() => setV(value), [value]);

  const typed = v.trim();
  const matchExact = typed && known.some((k) => k.toLowerCase() === typed.toLowerCase());
  const suggestions = typed
    ? known.filter((k) => k.toLowerCase().includes(typed.toLowerCase())).slice(0, 8)
    : known.slice(0, 8);

  const commit = (next: string) => {
    const t = next.trim();
    if (t === value) return;
    setV(t); setPendingCreate(null); setFocused(false);
    onSave(t);
  };

  const onBlur = () => {
    // Give click handlers on the dropdown a chance to run.
    setTimeout(() => {
      if (pendingCreate !== null) return;  // let the user click Create
      if (!typed) { setV(''); if (value) commit(''); setFocused(false); return; }
      if (matchExact) { commit(typed); return; }
      // New value — queue a confirmation. If they blur the pending UI too,
      // we revert — the Create button is the only way to actually save.
      setPendingCreate(typed);
    }, 150);
  };

  return (
    <div className="relative">
      <input value={v} disabled={disabled}
        onChange={(e) => { setV(e.target.value); setPendingCreate(null); }}
        onFocus={() => setFocused(true)}
        onBlur={onBlur}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { setV(value); setPendingCreate(null); setFocused(false); (e.target as HTMLInputElement).blur(); }
        }}
        placeholder={disabled ? '' : 'Ledger…'}
        className={'h-7 w-full px-1.5 text-12 border rounded disabled:bg-transparent disabled:border-transparent ' + (!value && !disabled ? 'border-amber/60' : 'border-neutral-300')} />
      {focused && !disabled && (suggestions.length > 0 || pendingCreate || (typed && !matchExact)) ? (
        <div className="absolute left-0 right-0 top-full mt-0.5 z-20 bg-white border border-neutral-300 rounded shadow-md text-12 max-h-56 overflow-auto">
          {suggestions.map((s) => (
            <button key={s} type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(s)}
              className={'w-full text-left px-2 py-1 hover:bg-neutral-50 ' + (s === value ? 'text-primary' : 'text-neutral-800')}>
              {s}
            </button>
          ))}
          {pendingCreate && !matchExact ? (
            <button type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(pendingCreate)}
              className="w-full text-left px-2 py-1 border-t border-neutral-100 bg-amber/10 hover:bg-amber/20 text-amber-800">
              <span className="font-semibold">↳ Create new ledger</span> "{pendingCreate}"
            </button>
          ) : null}
          {pendingCreate === null && typed && !matchExact ? (
            <div className="px-2 py-1 text-11 text-neutral-500 border-t border-neutral-100">Not in the client's ledger master. Press Enter to review.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const toRupees = (p: number | null) => (p == null ? '' : (p / 100).toFixed(2));
const toPaise = (s: string) => (s.trim() === '' ? 0 : Math.round(Number(s.replace(/,/g, '')) * 100));

function EditRow({ row, onClose, onSave }: { row: AaTxn; onClose: () => void; onSave: (body: Record<string, unknown>) => Promise<unknown> }) {
  const [f, setF] = useState({
    txn_date: row.txn_date, value_date: row.value_date ?? '', narration: row.narration, reference: row.reference ?? '',
    debit: toRupees(row.debit_paise), credit: toRupees(row.credit_paise), balance: toRupees(row.balance_paise),
  });
  const [saving, setSaving] = useState(false);
  const o = row.original as { txn_date?: string; narration?: string; debit_paise?: string; credit_paise?: string; balance_paise?: string | null };
  const bad = [f.debit, f.credit, f.balance].some((x) => x.trim() !== '' && Number.isNaN(Number(x.replace(/,/g, ''))));
  const save = async () => {
    setSaving(true);
    try {
      await onSave({
        txn_date: f.txn_date, value_date: f.value_date || null, narration: f.narration, reference: f.reference || null,
        debit_paise: toPaise(f.debit), credit_paise: toPaise(f.credit), balance_paise: f.balance.trim() === '' ? null : toPaise(f.balance),
      });
    } finally { setSaving(false); }
  };
  const field = (k: keyof typeof f, label: string, type = 'text') => (
    <label className="text-12 text-neutral-600">{label}
      <input type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} className="mt-1 h-8 w-full px-2 text-13 border border-neutral-300 rounded" />
    </label>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-label={`Edit transaction ${row.seq}`}>
      <div className="bg-white rounded border border-neutral-200 w-full max-w-[640px]">
        <div className="px-5 py-3 border-b border-neutral-200 flex items-center justify-between">
          <div className="text-14 font-semibold">Edit transaction #{row.seq}</div>
          <button type="button" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="p-5 grid grid-cols-2 gap-3">
          {field('txn_date', 'Date', 'date')}
          {field('value_date', 'Value date', 'date')}
          <div className="col-span-2">{field('narration', 'Narration')}</div>
          {field('reference', 'Reference / cheque no.')}
          <div />
          {field('debit', 'Withdrawal (₹)')}
          {field('credit', 'Deposit (₹)')}
          {field('balance', 'Balance (₹, negative if overdrawn)')}
          <div className="col-span-2 text-12 text-neutral-500 border-l-2 border-neutral-300 pl-2">
            As read from the statement: {o.txn_date} · {o.narration} · Dr {o.debit_paise ? inr(Number(o.debit_paise)) : '0'} · Cr {o.credit_paise ? inr(Number(o.credit_paise)) : '0'} · Bal {o.balance_paise ? inr(Number(o.balance_paise)) : '—'}
          </div>
        </div>
        <div className="px-5 py-3 border-t border-neutral-200 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving || bad || !f.txn_date}>{saving ? 'Saving…' : 'Save — balance re-checked'}</Button>
        </div>
      </div>
    </div>
  );
}

function suggestPattern(narration: string): string {
  // The longest alphabetic chunk is usually the party ("…-KAVERI SUPPLIERS").
  const parts = narration.toUpperCase().split(/[^A-Z &]+/).map((p) => p.trim()).filter((p) => p.length >= 4 && !/^(UPI|NEFT|RTGS|IMPS|CHQ|PAID|TO|BY|TRANSFER|CR|DR)$/.test(p));
  return parts.sort((a, b) => b.length - a.length)[0] ?? narration.slice(0, 20);
}

function RuleFromRow({ row, clientId, jobId, onClose }: { row: AaTxn; clientId: string; jobId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ pattern: suggestPattern(row.narration), ledger_name: row.ledger_name ?? '', direction: row.debit_paise ? 'withdrawal' : 'deposit', voucher_type: row.voucher_type ?? '', firmWide: false });
  const save = useMutation({
    mutationFn: async () => {
      await auditAutomationApi.createRule({ client_id: f.firmWide ? null : clientId, pattern: f.pattern, ledger_name: f.ledger_name, direction: f.direction, voucher_type: f.voucher_type || null });
      return auditAutomationApi.applyRules(jobId);
    },
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['aa.rows', jobId] }); void qc.invalidateQueries({ queryKey: ['aa.rules', clientId] }); toast.push('success', `Rule saved — ${r.changed} row${r.changed === 1 ? '' : 's'} updated.`); onClose(); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-label="New ledger rule">
      <div className="bg-white rounded border border-neutral-200 w-full max-w-[560px]">
        <div className="px-5 py-3 border-b border-neutral-200 flex items-center justify-between">
          <div className="text-14 font-semibold">New ledger rule</div>
          <button type="button" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-3 text-13">
          <div className="text-12 text-neutral-500">From: {row.narration}</div>
          <label className="block text-12 text-neutral-600">When the narration contains
            <input value={f.pattern} onChange={(e) => setF({ ...f, pattern: e.target.value })} className="mt-1 h-8 w-full px-2 text-13 border border-neutral-300 rounded" />
          </label>
          <label className="block text-12 text-neutral-600">Post to ledger
            <input list="aa-ledgers" value={f.ledger_name} onChange={(e) => setF({ ...f, ledger_name: e.target.value })} className="mt-1 h-8 w-full px-2 text-13 border border-neutral-300 rounded" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-12 text-neutral-600">For
              <select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })} className="mt-1 h-8 w-full text-13 border border-neutral-300 rounded bg-white">
                <option value="any">Withdrawals and deposits</option><option value="withdrawal">Withdrawals only</option><option value="deposit">Deposits only</option>
              </select>
            </label>
            <label className="text-12 text-neutral-600">Voucher type
              <select value={f.voucher_type} onChange={(e) => setF({ ...f, voucher_type: e.target.value })} className="mt-1 h-8 w-full text-13 border border-neutral-300 rounded bg-white">
                <option value="">By direction (Payment / Receipt)</option>{VOUCHERS.map((v) => <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>)}
              </select>
            </label>
          </div>
          <label className="flex items-center gap-2 text-12 text-neutral-700"><input type="checkbox" checked={f.firmWide} onChange={(e) => setF({ ...f, firmWide: e.target.checked })} />Use for every client (firm-wide)</label>
        </div>
        <div className="px-5 py-3 border-t border-neutral-200 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => save.mutate()} disabled={!f.pattern.trim() || !f.ledger_name.trim() || save.isPending}>Save rule and apply</Button>
        </div>
      </div>
    </div>
  );
}

function RulesPanel({ clientId, jobId, locked }: { clientId: string; jobId: string; locked: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['aa.rules', clientId], queryFn: () => auditAutomationApi.rules(clientId) });
  const del = useMutation({
    mutationFn: (id: string) => auditAutomationApi.deleteRule(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['aa.rules', clientId] }); toast.push('success', 'Rule deleted. Apply rules to update rows.'); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const items: AaRule[] = q.data?.items ?? [];
  return (
    <section className="bg-white border border-neutral-200 rounded p-5">
      <div className="text-11 tracking-[0.06em] text-neutral-500 mb-2">LEDGER RULES FOR THIS CLIENT</div>
      {items.length === 0 ? (
        <p className="text-13 text-neutral-500">No rules yet. Use “Make a rule” on a transaction — e.g. narration contains “AIRTEL” → Telephone Expenses — and it is applied to every statement for this client.</p>
      ) : (
        <table className="w-full text-13">
          <thead><tr className="text-11 uppercase tracking-[0.06em] text-neutral-500 border-b border-neutral-200">
            <th className="text-left py-1 font-medium">Narration</th><th className="text-left font-medium">Ledger</th><th className="text-left font-medium">For</th><th className="text-left font-medium">Voucher</th><th className="text-left font-medium">Scope</th><th />
          </tr></thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id} className="border-b border-neutral-100">
                <td className="py-1">{r.match_type} “{r.pattern}”</td>
                <td>{r.ledger_name}</td>
                <td>{r.direction === 'any' ? 'both' : r.direction + 's'}</td>
                <td>{r.voucher_type ?? 'auto'}</td>
                <td>{r.client_id ? 'this client' : 'firm-wide'}</td>
                <td className="text-right">{!locked ? <button type="button" className="text-12 text-neutral-600 hover:text-danger" onClick={() => del.mutate(r.id)}>Delete</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="sr-only">{jobId}</div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-neutral-200 rounded px-3 py-2">
      <div className="text-11 text-neutral-500">{label}</div>
      <div className="text-14 font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex">
      <dt className="w-32 text-neutral-500">{label}</dt>
      <dd className="flex-1 text-neutral-900">{value}</dd>
    </div>
  );
}
