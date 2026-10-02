import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Download, History, Link2, Mail, MessageSquare, RotateCcw, Trash2, Unlink, X } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import {
  tdsApi,
  type FollowUpStatus,
  type TdsActionStatus,
  type TdsDeductor,
  type TdsMatchStatus,
  type TdsReconJob,
  type TdsReconRow,
  type TdsReconRowEntry,
} from '@/modules/tools/audit-automation/tds';

/**
 * /audit-automation/tds/jobs/:jobId — Form 26AS vs the books' TDS
 * receivable. Two views: every row (filters, action + note, manual pair,
 * unpair) and the deductor chase list (shortfall per deductor, follow-up
 * status, due date, contact, history, a ready request letter).
 */

const PAGE = 100;
const ORDER: TdsMatchStatus[] = ['verified', 'variance', 'only_26as', 'only_books'];
const STATUS: Record<TdsMatchStatus, { label: string; hint: string; cls: string }> = {
  verified: { label: 'Verified', hint: 'In 26AS and in the books, same TDS', cls: 'border-l-success text-success' },
  variance: { label: 'Variance', hint: 'Paired, but the TDS or the section differs', cls: 'border-l-danger text-danger' },
  only_26as: { label: 'Only in 26AS', hint: 'A credit the books do not show — check the income was booked', cls: 'border-l-primary text-primary' },
  only_books: { label: 'Only in books', hint: 'TDS the books claim that 26AS does not show — chase the deductor', cls: 'border-l-amber text-amber' },
};
const ACTION: Record<TdsActionStatus, string> = {
  no_action: 'No action', chase_deductor: 'Chase deductor', revise_book: 'Revise books', credit_claimed: 'Credit claimed', written_off: 'Written off',
};
const FLAG: Record<string, string> = {
  status_u: 'Unmatched (U)', status_p: 'Provisional (P)', status_o: 'Overbooked (O)', status_z: 'Mismatched (Z)',
  short_deposit: 'Short deposit', tan_from_name: 'TAN by name', out_of_year: 'Outside FY',
};
const JOB_FLAG: Record<string, string> = {
  AY_MISMATCH: 'The 26AS and the books are for different assessment years.',
  BOOKS_OUT_OF_YEAR: 'Some entries are dated outside this financial year. They are marked “Outside FY”.',
  TAN_FROM_NAME: 'Some book entries had no TAN and were tied to a 26AS deductor by name. Check them (“TAN by name”).',
  UNBOOKED_CREDITS: 'Some 26AS credits are “U” (unmatched) — the deductor’s statement does not tie to its challan, so the credit is not usable yet.',
  SHORT_DEPOSITS: 'Some deductors deposited less TDS than they deducted.',
};
const DIFF: Record<string, string> = {
  tds_amount: 'TDS', section: 'Section', amount_paid: 'Amount paid', quarter: 'Quarter', tds_date: 'Date', grouped: 'Grouped', manual_pair: 'Paired by hand', unpaired: 'Unpaired', deductor: 'Deductor',
};
const FOLLOW: Record<FollowUpStatus, string> = { open: 'Open', contacted: 'Contacted', promised: 'Promised', resolved: 'Resolved', written_off: 'Written off' };

export function TdsReconDetailPage() {
  const { jobId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [view, setView] = useState<'rows' | 'deductors'>('rows');
  const [tab, setTab] = useState<'all' | TdsMatchStatus>('all');
  const [action, setAction] = useState<'' | TdsActionStatus>('');
  const [flag, setFlag] = useState('');
  const [deductor, setDeductor] = useState('');
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  useEffect(() => { const t = setTimeout(() => { setSearch(searchText.trim()); setOffset(0); }, 300); return () => clearTimeout(t); }, [searchText]);

  const jobQ = useQuery({
    queryKey: ['tds.job', jobId], enabled: Boolean(jobId), queryFn: () => tdsApi.getRecon(jobId),
    refetchInterval: (q) => (q.state.data?.status === 'matching' || q.state.data?.status === 'queued' ? 1500 : false),
  });
  const rowsQ = useQuery({
    queryKey: ['tds.rows', jobId, tab, action, flag, deductor, search, offset],
    enabled: Boolean(jobId) && jobQ.data?.status === 'matched' && view === 'rows',
    queryFn: () => tdsApi.getReconRows(jobId, { status: tab, ...(action ? { action } : {}), ...(flag ? { flag } : {}), ...(deductor ? { deductor } : {}), ...(search ? { search } : {}), limit: PAGE, offset }),
    placeholderData: (p) => p,
  });
  const refresh = async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['tds.rows', jobId] }), qc.invalidateQueries({ queryKey: ['tds.job', jobId] }), qc.invalidateQueries({ queryKey: ['tds.deductors', jobId] })]); };

  const remove = useMutation({
    mutationFn: () => tdsApi.deleteRecon(jobId),
    onSuccess: () => { toast.push('success', 'Reconciliation deleted. The 26AS, the books and deductor follow-ups are kept.'); navigate('/audit-automation/tds'); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const rerun = useMutation({
    mutationFn: () => tdsApi.rerun(jobId),
    onSuccess: async () => { toast.push('success', 'Matched again. Your actions and notes stay on pairs that came out the same.'); await refresh(); },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const job = jobQ.data;
  const counts = rowsQ.data?.counts ?? {};
  const total = rowsQ.data?.total ?? 0;
  const pick = (s: 'all' | TdsMatchStatus) => { setView('rows'); setTab(s); setOffset(0); };

  return (
    <div className="max-w-[1400px] mx-auto" data-testid="tds-detail">
      <div className="mb-4 flex items-center justify-between gap-2 flex-wrap">
        <Link to="/audit-automation/tds" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900">
          <ArrowLeft size={14} strokeWidth={1.75} /> TDS reconciliation
        </Link>
        {job ? (
          <div className="flex items-center gap-2 flex-wrap">
            {job.status === 'matched' ? (
              <>
                <a href={tdsApi.exportUrl(job.id)} download className="inline-flex items-center gap-1 h-8 px-3 text-13 border border-neutral-300 rounded bg-white hover:bg-neutral-50"><Download size={14} strokeWidth={1.75} /> Workbook (.xlsx)</a>
                <a href={tdsApi.exportCsvUrl(job.id)} download className="inline-flex items-center gap-1 h-8 px-3 text-13 border border-neutral-300 rounded bg-white hover:bg-neutral-50"><Download size={14} strokeWidth={1.75} /> CSV</a>
              </>
            ) : null}
            <Button variant="secondary" size="sm" disabled={rerun.isPending} onClick={() => rerun.mutate()}><RotateCcw size={14} strokeWidth={1.75} className="mr-1" /> Match again</Button>
            <Button variant="secondary" size="sm" disabled={remove.isPending} onClick={() => { if (window.confirm('Delete this reconciliation and the actions on its rows? The uploads and deductor follow-ups stay.')) remove.mutate(); }}>
              <Trash2 size={14} strokeWidth={1.75} className="mr-1" /> Delete
            </Button>
          </div>
        ) : null}
      </div>

      {jobQ.isLoading ? <Box>Loading…</Box>
        : jobQ.error ? <Box><span className="text-danger">Could not load this reconciliation: {(jobQ.error as Error).message}</span></Box>
        : job ? (
          <>
            <div className="mb-2 text-13 text-neutral-600">AY {job.assessment_year}-{String((job.assessment_year + 1) % 100).padStart(2, '0')} · FY {job.assessment_year - 1}-{String(job.assessment_year % 100).padStart(2, '0')}</div>
            {job.flags.length ? (
              <div className="mb-3 border border-amber/40 bg-amber/10 rounded p-3 space-y-1">
                {job.flags.map((f) => <div key={f} className="flex items-start gap-2 text-13 text-neutral-800"><AlertTriangle size={14} strokeWidth={1.75} className="text-amber mt-0.5 shrink-0" />{JOB_FLAG[f] ?? f}</div>)}
              </div>
            ) : null}
            <Summary job={job} onPick={pick} />
            {job.status !== 'matched' ? (
              <Box>{job.status === 'failed' ? <span className="text-danger">{job.error_message || 'Reconciliation failed.'}</span> : 'Matching…'}</Box>
            ) : (
              <>
                <div className="mt-4 flex gap-1 border-b border-neutral-200">
                  {(['rows', 'deductors'] as const).map((v) => (
                    <button key={v} type="button" onClick={() => setView(v)}
                      className={'px-3 py-2 text-13 border-b-2 -mb-px ' + (view === v ? 'border-gold text-neutral-900 font-medium' : 'border-transparent text-neutral-500 hover:text-neutral-900')}>
                      {v === 'rows' ? 'Entries' : 'Deductors — chase list'}
                    </button>
                  ))}
                </div>
                {view === 'deductors' ? (
                  <Deductors jobId={jobId} onShow={(k) => { setDeductor(k); pick('all'); }} />
                ) : (
                  <>
                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                      <div className="flex gap-1 flex-wrap">
                        {(['all', ...ORDER] as const).map((k) => (
                          <button key={k} type="button" onClick={() => pick(k)} title={k === 'all' ? undefined : STATUS[k].hint}
                            className={'h-8 px-3 text-13 rounded border ' + (tab === k ? 'border-gold bg-gold/10 text-neutral-900' : 'border-neutral-200 bg-white text-neutral-600 hover:text-neutral-900')}>
                            {k === 'all' ? 'All' : STATUS[k].label} <span className="text-11 text-neutral-400">{k === 'all' ? ORDER.reduce((n, s) => n + (counts[s] ?? 0), 0) : counts[k] ?? 0}</span>
                          </button>
                        ))}
                      </div>
                      <div className="flex-1" />
                      <input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Search TAN, deductor, section, ref"
                        className="h-8 w-56 px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold" />
                      <select value={action} onChange={(e) => { setAction(e.target.value as '' | TdsActionStatus); setOffset(0); }} aria-label="Filter by action" className="h-8 px-2 text-13 border border-neutral-300 rounded bg-white">
                        <option value="">Any action</option>
                        {(Object.keys(ACTION) as TdsActionStatus[]).map((k) => <option key={k} value={k}>{ACTION[k]} ({rowsQ.data?.action_counts[k] ?? 0})</option>)}
                      </select>
                      <select value={flag} onChange={(e) => { setFlag(e.target.value); setOffset(0); }} aria-label="Filter by warning" className="h-8 px-2 text-13 border border-neutral-300 rounded bg-white">
                        <option value="">Any warning</option>
                        {Object.entries(FLAG).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </div>
                    {deductor ? (
                      <div className="mt-2 text-12 text-neutral-600">Deductor: <span className="font-mono">{deductor}</span> <button type="button" className="ml-1 text-primary" onClick={() => setDeductor('')}>show all</button></div>
                    ) : null}
                    <Rows jobId={jobId} rows={rowsQ.data?.items ?? []} loading={rowsQ.isLoading} onChanged={refresh} />
                    {total > PAGE ? (
                      <div className="mt-2 flex items-center justify-end gap-2 text-12 text-neutral-500">
                        <span>{offset + 1}–{Math.min(offset + PAGE, total)} of {total}</span>
                        <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
                        <Button variant="secondary" size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
                      </div>
                    ) : null}
                  </>
                )}
              </>
            )}
          </>
        ) : null}
    </div>
  );
}

function Box({ children }: { children: React.ReactNode }) {
  return <div className="bg-white border border-neutral-200 rounded p-6 mt-4 text-13 text-neutral-500">{children}</div>;
}

function Summary({ job, onPick }: { job: TdsReconJob; onPick: (s: TdsMatchStatus) => void }) {
  const t = job.totals;
  const tot26 = t ? ORDER.reduce((n, s) => n + (t[s]?.tds_26as ?? 0), 0) : 0;
  const totBk = t ? ORDER.reduce((n, s) => n + (t[s]?.tds_books ?? 0), 0) : 0;
  const count: Record<TdsMatchStatus, number> = { verified: job.verified_count, variance: job.variance_count, only_26as: job.only_26as_count, only_books: job.only_books_count };
  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
      {ORDER.map((s) => (
        <button key={s} type="button" onClick={() => onPick(s)} title={STATUS[s].hint} className="text-left bg-white border border-neutral-200 rounded p-3 hover:border-gold">
          <div className="text-11 tracking-[0.06em] text-neutral-500">{STATUS[s].label.toUpperCase()}</div>
          <div className={'text-20 font-semibold mt-1 ' + STATUS[s].cls.split(' ')[1]}>{count[s]}</div>
          <div className="text-11 text-neutral-500 mt-1">
            {s === 'only_books' ? `books ₹${rupees(t?.[s]?.tds_books ?? 0)}` : s === 'only_26as' ? `26AS ₹${rupees(t?.[s]?.tds_26as ?? 0)}` : `26AS ₹${rupees(t?.[s]?.tds_26as ?? 0)} · books ₹${rupees(t?.[s]?.tds_books ?? 0)}`}
          </div>
        </button>
      ))}
      <div className="bg-white border border-neutral-200 rounded p-3">
        <div className="text-11 tracking-[0.06em] text-neutral-500">TDS CREDIT</div>
        <div className="text-13 mt-1">26AS <span className="font-semibold tabular-nums">₹{rupees(tot26)}</span></div>
        <div className="text-13">Books <span className="font-semibold tabular-nums">₹{rupees(totBk)}</span></div>
        <div className={'text-12 mt-1 ' + (totBk - tot26 > 0 ? 'text-danger' : 'text-neutral-500')}>{totBk - tot26 > 0 ? `₹${rupees(totBk - tot26)} short in 26AS` : totBk - tot26 < 0 ? `₹${rupees(tot26 - totBk)} more in 26AS` : 'Agrees'}</div>
      </div>
    </div>
  );
}

function Rows({ jobId, rows, loading, onChanged }: { jobId: string; rows: TdsReconRow[]; loading?: boolean; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [noteFor, setNoteFor] = useState<TdsReconRow | null>(null);
  const [pairFor, setPairFor] = useState<TdsReconRow | null>(null);
  const setAct = useMutation({
    mutationFn: (v: { id: string; a: TdsActionStatus }) => tdsApi.updateRow(v.id, { action_status: v.a }),
    onSuccess: async () => { toast.push('success', 'Action updated.'); await onChanged(); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const unpair = useMutation({
    mutationFn: (id: string) => tdsApi.unpair(id),
    onSuccess: async (r) => { toast.push('success', r.rows > 1 ? `Group of ${r.rows} split.` : 'Split into “only in 26AS” and “only in books”.'); await onChanged(); },
    onError: (e: Error) => toast.push('error', e.message),
  });

  if (loading) return <Box>Loading rows…</Box>;
  if (!rows.length) return <Box>No rows here.</Box>;
  return (
    <>
      <div className="mt-3 bg-white border border-neutral-200 rounded overflow-x-auto">
        <table className="w-full text-13 min-w-[1080px]">
          <thead>
            <tr className="text-left text-11 text-neutral-500 tracking-[0.06em]">
              <th className="px-3 py-2 font-normal">STATUS</th>
              <th className="px-3 py-2 font-normal">DEDUCTOR</th>
              <th className="px-3 py-2 font-normal">26AS</th>
              <th className="px-3 py-2 font-normal">BOOKS</th>
              <th className="px-3 py-2 font-normal">DIFFERENCES · WARNINGS</th>
              <th className="px-3 py-2 font-normal">ACTION</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const a = r.filing_26as_entry, b = r.books_entry, e = (a ?? b)!;
              return (
                <tr key={r.id} className="border-t border-neutral-100 align-top">
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={'inline-flex pl-2 pr-1 border-l-2 text-11 font-medium ' + STATUS[r.match_status].cls}>{STATUS[r.match_status].label}</span>
                    {r.match_method ? <div className="text-11 text-neutral-400 pl-2">{r.match_method === 'window' ? 'within 45 days' : r.match_method}{r.group_key ? ` ${r.group_key}` : ''}</div> : null}
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-neutral-900 truncate max-w-[200px]" title={e.deductor_name ?? ''}>{a?.deductor_name ?? b?.deductor_name ?? '—'}</div>
                    <div className="text-11 font-mono text-neutral-500">{a?.deductor_tan || b?.deductor_tan || (r.deductor_key?.startsWith('NAME:') ? 'no TAN' : r.deductor_key)}</div>
                  </td>
                  <td className="px-3 py-2">{a ? <Side e={a} two /> : <span className="text-neutral-400">—</span>}</td>
                  <td className="px-3 py-2">{b ? <Side e={b} /> : <span className="text-neutral-400">—</span>}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1 max-w-[220px]">
                      {r.mismatch_fields.map((f) => <span key={f} className="text-11 px-1.5 py-0.5 rounded bg-amber/10 text-neutral-800">{DIFF[f] ?? f}</span>)}
                      {r.flags.map((f) => <span key={f} className="text-11 px-1.5 py-0.5 rounded bg-danger/10 text-danger">{FLAG[f] ?? f}</span>)}
                      {!r.mismatch_fields.length && !r.flags.length ? <span className="text-neutral-400">—</span> : null}
                    </div>
                    {a && b && !r.group_key && a.tds_amount !== b.tds_amount ? <div className="text-11 text-neutral-500 mt-1">TDS diff ₹{rupees(a.tds_amount - b.tds_amount)}</div> : null}
                  </td>
                  <td className="px-3 py-2 w-[250px]">
                    <div className="flex items-center gap-1">
                      <select value={r.action_status} onChange={(ev) => setAct.mutate({ id: r.id, a: ev.target.value as TdsActionStatus })} aria-label="Action"
                        className="h-7 px-2 text-12 border border-neutral-300 rounded bg-white mr-1">
                        {(Object.keys(ACTION) as TdsActionStatus[]).map((k) => <option key={k} value={k}>{ACTION[k]}</option>)}
                      </select>
                      {r.match_status === 'only_26as' ? <Icon title="Pair with a books entry" onClick={() => setPairFor(r)}><Link2 size={14} strokeWidth={1.75} /></Icon> : null}
                      {a && b ? <Icon title={r.group_key ? 'Split this group' : 'Unpair'} onClick={() => { if (window.confirm(r.group_key ? 'Split every row of this group?' : 'Split this pair?')) unpair.mutate(r.id); }}><Unlink size={14} strokeWidth={1.75} /></Icon> : null}
                      <Icon title={r.auditor_note ? `Note: ${r.auditor_note}` : 'Add a note'} active={Boolean(r.auditor_note)} onClick={() => setNoteFor(r)}><MessageSquare size={14} strokeWidth={1.75} /></Icon>
                    </div>
                    {r.auditor_note ? <div className="text-11 text-neutral-800 mt-1 border-l-2 border-gold pl-1.5">Note: {r.auditor_note}</div> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {noteFor ? <NoteModal row={noteFor} onClose={() => setNoteFor(null)} onSaved={onChanged} /> : null}
      {pairFor ? <PairModal jobId={jobId} row={pairFor} onClose={() => setPairFor(null)} onSaved={onChanged} /> : null}
    </>
  );
}

function Side({ e, two }: { e: TdsReconRowEntry; two?: boolean }) {
  return (
    <div className="whitespace-nowrap">
      <div className="text-neutral-900 tabular-nums">TDS ₹{rupees(e.tds_amount)} <span className="text-11 text-neutral-500">{e.section || '—'}</span></div>
      <div className="text-11 text-neutral-500">{e.tds_date} · {e.quarter}{two && e.status ? ` · ${e.status}` : ''}{!two && e.reference ? ` · ${e.reference}` : ''}</div>
      <div className="text-11 text-neutral-400">paid ₹{rupees(e.amount_paid)}{two && e.tds_deposited !== undefined && e.tds_deposited !== e.tds_amount ? ` · deposited ₹${rupees(e.tds_deposited)}` : ''}</div>
    </div>
  );
}

function Icon({ title, onClick, active, children }: { title: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick}
      className={'h-7 w-7 inline-flex items-center justify-center rounded border ' + (active ? 'border-gold text-gold bg-gold/10' : 'border-neutral-200 text-neutral-500 hover:text-neutral-900 hover:border-neutral-400')}>
      {children}
    </button>
  );
}

function NoteModal({ row, onClose, onSaved }: { row: TdsReconRow; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [note, setNote] = useState(row.auditor_note ?? '');
  const save = useMutation({
    mutationFn: () => tdsApi.updateRow(row.id, { auditor_note: note.trim() || null }),
    onSuccess: async () => { toast.push('success', 'Saved.'); await onSaved(); onClose(); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  return (
    <Dialog title="Note" onClose={onClose}>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} maxLength={2000} className="w-full px-2 py-1.5 text-13 border border-neutral-300 rounded focus:outline-none focus:border-gold" placeholder="e.g. Form 16A received; deductor to revise Q2 statement" />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
      </div>
    </Dialog>
  );
}

function PairModal({ jobId, row, onClose, onSaved }: { jobId: string; row: TdsReconRow; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const a = row.filing_26as_entry!;
  const [q, setQ] = useState('');
  const [s, setS] = useState('');
  useEffect(() => { const t = setTimeout(() => setS(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const c = useQuery({ queryKey: ['tds.rows', jobId, 'pair', s], queryFn: () => tdsApi.getReconRows(jobId, { status: 'only_books', ...(s ? { search: s } : {}), limit: 50 }) });
  const pair = useMutation({
    mutationFn: (id: string) => tdsApi.pair(jobId, row.id, id),
    onSuccess: async (r) => { toast.push('success', `Paired — ${STATUS[r.match_status].label.toLowerCase()}.`); await onSaved(); onClose(); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const items = [...(c.data?.items ?? [])].sort((x, y) => Number(y.deductor_key === a.deductor_tan) - Number(x.deductor_key === a.deductor_tan));
  return (
    <Dialog title="Pair with a books entry" onClose={onClose} wide>
      <div className="text-13 border border-neutral-200 rounded p-2 bg-neutral-50">
        <span className="text-11 text-neutral-500 mr-2">26AS</span>{a.deductor_name ?? a.deductor_tan} · {a.section} · {a.tds_date} · TDS ₹{rupees(a.tds_amount)}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search books-only entries" className="mt-3 h-8 w-full px-2 text-13 border border-neutral-300 rounded focus:outline-none focus:border-gold" />
      <div className="mt-2 max-h-[340px] overflow-y-auto border border-neutral-200 rounded">
        {c.isLoading ? <div className="p-3 text-13 text-neutral-500">Loading…</div> : !items.length ? <div className="p-3 text-13 text-neutral-500">No books-only entries match.</div> : (
          <table className="w-full text-13"><tbody>
            {items.map((x) => {
              const b = x.books_entry!;
              return (
                <tr key={x.id} className="border-t border-neutral-100 first:border-t-0">
                  <td className="px-2 py-1.5">
                    <div>{b.deductor_name ?? '—'} {x.deductor_key === a.deductor_tan ? <span className="text-11 text-success">same deductor</span> : null}</div>
                    <div className="text-11 text-neutral-500">{b.tds_date} · {b.section || '—'}{b.reference ? ` · ${b.reference}` : ''}</div>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">₹{rupees(b.tds_amount)}</td>
                  <td className="px-2 py-1.5 text-right"><Button variant="secondary" size="sm" disabled={pair.isPending} onClick={() => pair.mutate(x.id)}>Pair</Button></td>
                </tr>
              );
            })}
          </tbody></table>
        )}
      </div>
    </Dialog>
  );
}

function Deductors({ jobId, onShow }: { jobId: string; onShow: (key: string) => void }) {
  const q = useQuery({ queryKey: ['tds.deductors', jobId], queryFn: () => tdsApi.deductors(jobId) });
  const [edit, setEdit] = useState<TdsDeductor | null>(null);
  const [onlyOpen, setOnlyOpen] = useState(true);
  if (q.isLoading) return <Box>Loading deductors…</Box>;
  if (q.error) return <Box><span className="text-danger">{(q.error as Error).message}</span></Box>;
  const items = (q.data?.items ?? []).filter((d) => !onlyOpen || d.open > 0 || d.shortfall !== 0);
  return (
    <>
      <label className="mt-3 inline-flex items-center gap-1.5 text-13 text-neutral-700"><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Only deductors with something open</label>
      <div className="mt-2 bg-white border border-neutral-200 rounded overflow-x-auto">
        <table className="w-full text-13 min-w-[980px]">
          <thead>
            <tr className="text-left text-11 text-neutral-500 tracking-[0.06em]">
              <th className="px-3 py-2 font-normal">DEDUCTOR</th>
              <th className="px-3 py-2 font-normal text-right">26AS</th>
              <th className="px-3 py-2 font-normal text-right">BOOKS</th>
              <th className="px-3 py-2 font-normal text-right">SHORT IN 26AS</th>
              <th className="px-3 py-2 font-normal">ISSUES</th>
              <th className="px-3 py-2 font-normal">FOLLOW-UP</th>
              <th className="px-3 py-2 font-normal" />
            </tr>
          </thead>
          <tbody>
            {!items.length ? <tr><td colSpan={7} className="px-3 py-4 text-neutral-500">Nothing open — every deductor agrees.</td></tr> : items.map((d) => {
              const overdue = d.follow_up?.due_date && d.follow_up.status !== 'resolved' && d.follow_up.status !== 'written_off' && d.follow_up.due_date < new Date().toISOString().slice(0, 10);
              return (
                <tr key={d.key} className="border-t border-neutral-100 align-top">
                  <td className="px-3 py-2">
                    <div className="text-neutral-900">{d.name ?? '—'}</div>
                    <div className="text-11 font-mono text-neutral-500">{d.tan ?? 'no TAN'}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">₹{rupees(d.tds_26as)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">₹{rupees(d.tds_books)}</td>
                  <td className={'px-3 py-2 text-right tabular-nums ' + (d.shortfall > 0 ? 'text-danger font-medium' : 'text-neutral-500')}>{d.shortfall > 0 ? `₹${rupees(d.shortfall)}` : d.shortfall < 0 ? `−₹${rupees(-d.shortfall)}` : '—'}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1 max-w-[240px]">
                      {Object.entries(d.status_counts).filter(([k]) => k !== 'verified').map(([k, n]) => <span key={k} className="text-11 px-1.5 py-0.5 rounded bg-amber/10">{STATUS[k as TdsMatchStatus].label} {n}</span>)}
                      {Object.entries(d.flags).map(([k, n]) => <span key={k} className="text-11 px-1.5 py-0.5 rounded bg-danger/10 text-danger">{FLAG[k] ?? k} {n}</span>)}
                      {d.open ? <span className="text-11 text-neutral-500">{d.open} open</span> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {d.follow_up ? (
                      <>
                        <div className="text-12">{FOLLOW[d.follow_up.status]}{d.follow_up.due_date ? <span className={overdue ? ' text-danger' : ' text-neutral-500'}> · due {d.follow_up.due_date}{overdue ? ' (overdue)' : ''}</span> : null}</div>
                        {d.follow_up.last_contacted_at ? <div className="text-11 text-neutral-500">contacted {new Date(d.follow_up.last_contacted_at).toLocaleDateString('en-IN', { dateStyle: 'medium' })}</div> : null}
                        {d.follow_up.note ? <div className="text-11 text-neutral-700 max-w-[200px] truncate" title={d.follow_up.note}>{d.follow_up.note}</div> : null}
                      </>
                    ) : <span className="text-12 text-neutral-400">Not started</span>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    <Button variant="secondary" size="sm" onClick={() => setEdit(d)}>Follow up</Button>
                    <button type="button" className="ml-2 text-12 text-primary" onClick={() => onShow(d.key)}>Entries</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {edit ? <FollowUpModal jobId={jobId} d={edit} onClose={() => setEdit(null)} onSaved={() => q.refetch().then(() => undefined)} /> : null}
    </>
  );
}

function FollowUpModal({ jobId, d, onClose, onSaved }: { jobId: string; d: TdsDeductor; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const qc = useQueryClient();
  const f = d.follow_up;
  const [form, setForm] = useState({ status: f?.status ?? 'open' as FollowUpStatus, due_date: f?.due_date ?? '', contact_email: f?.contact_email ?? '', contact_phone: f?.contact_phone ?? '', note: f?.note ?? '' });
  const [showHistory, setShowHistory] = useState(false);
  const history = useQuery({ queryKey: ['tds.fu', f?.id], enabled: Boolean(f?.id) && showHistory, queryFn: () => tdsApi.followUpEvents(f!.id) });
  const save = useMutation({
    mutationFn: (contacted?: boolean) => tdsApi.saveFollowUp(jobId, d.key, { ...form, due_date: form.due_date || null, contact_email: form.contact_email || null, contact_phone: form.contact_phone || null, note: form.note || null, contacted }),
    onSuccess: async () => { toast.push('success', 'Follow-up saved.'); await onSaved(); await qc.invalidateQueries({ queryKey: ['tds.fu'] }); onClose(); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const setAll = useMutation({
    mutationFn: (a: TdsActionStatus) => tdsApi.deductorAction(jobId, d.key, a),
    onSuccess: async (r) => { toast.push('success', `${r.updated} row(s) updated.`); await qc.invalidateQueries({ queryKey: ['tds.rows', jobId] }); await onSaved(); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const letter = useMutation({
    mutationFn: () => tdsApi.chaseLetter(jobId, d.key),
    onError: (e: Error) => toast.push('error', e.message),
  });
  const input = 'mt-1 h-8 w-full px-2 text-13 border border-neutral-300 rounded focus:outline-none focus:border-gold';
  return (
    <Dialog title={`Follow up — ${d.name ?? d.tan ?? d.key}`} onClose={onClose} wide>
      <div className="text-12 text-neutral-600 mb-3">26AS ₹{rupees(d.tds_26as)} · books ₹{rupees(d.tds_books)}{d.shortfall > 0 ? ` · ₹${rupees(d.shortfall)} short in 26AS` : ''} · {d.open} open row(s)</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-12 text-neutral-600">Status
          <select className={input} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as FollowUpStatus })}>
            {(Object.keys(FOLLOW) as FollowUpStatus[]).map((k) => <option key={k} value={k}>{FOLLOW[k]}</option>)}
          </select>
        </label>
        <label className="text-12 text-neutral-600">Next follow-up / promised by
          <input type="date" className={input} value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
        </label>
        <label className="text-12 text-neutral-600">Deductor email
          <input type="email" className={input} value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} />
        </label>
        <label className="text-12 text-neutral-600">Deductor phone
          <input className={input} value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} />
        </label>
        <label className="text-12 text-neutral-600 sm:col-span-2">Note
          <textarea rows={3} maxLength={2000} className="mt-1 w-full px-2 py-1.5 text-13 border border-neutral-300 rounded focus:outline-none focus:border-gold" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </label>
      </div>
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <Button variant="secondary" size="sm" onClick={() => letter.mutate()} disabled={letter.isPending}><Mail size={14} strokeWidth={1.75} className="mr-1" /> Draft request letter</Button>
        <Button variant="secondary" size="sm" onClick={() => setAll.mutate('chase_deductor')}>Mark open rows “Chase deductor”</Button>
        {f ? <Button variant="secondary" size="sm" onClick={() => setShowHistory(!showHistory)}><History size={14} strokeWidth={1.75} className="mr-1" /> History ({f.events})</Button> : null}
      </div>
      {letter.data ? (
        <div className="mt-3 border border-neutral-200 rounded p-2">
          <div className="text-12 font-medium">{letter.data.subject}</div>
          <pre className="mt-1 text-12 whitespace-pre-wrap font-sans text-neutral-800 max-h-[180px] overflow-y-auto">{letter.data.body}</pre>
          <div className="mt-2 flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => { void navigator.clipboard?.writeText(`${letter.data!.subject}\n\n${letter.data!.body}`).then(() => toast.push('success', 'Copied.')); }}>Copy</Button>
            <Button variant="secondary" size="sm" onClick={() => { window.location.href = `mailto:${form.contact_email}?subject=${encodeURIComponent(letter.data!.subject)}&body=${encodeURIComponent(letter.data!.body)}`; }}>Open in email</Button>
          </div>
        </div>
      ) : null}
      {showHistory ? (
        <ul className="mt-3 max-h-[160px] overflow-y-auto border border-neutral-200 rounded divide-y divide-neutral-100 text-12">
          {history.isLoading ? <li className="p-2 text-neutral-500">Loading…</li> : !history.data?.items.length ? <li className="p-2 text-neutral-500">No history yet.</li> : history.data.items.map((e) => (
            <li key={e.id} className="p-2">
              <span className="text-neutral-500">{new Date(e.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · {e.by ?? '—'} · </span>
              {e.kind === 'status' ? `status ${e.from_status ? FOLLOW[e.from_status as FollowUpStatus] ?? e.from_status : 'new'} → ${FOLLOW[e.to_status as FollowUpStatus] ?? e.to_status}` : e.kind === 'contacted' ? `contacted${e.note ? `: ${e.note}` : ''}` : e.kind === 'due_date' ? `due date ${e.note}` : `note: ${e.note ?? ''}`}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" onClick={() => save.mutate(true)} disabled={save.isPending}>Save & log contact</Button>
        <Button variant="primary" onClick={() => save.mutate(false)} disabled={save.isPending}>Save</Button>
      </div>
    </Dialog>
  );
}

function Dialog({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-label={title}>
      <div className={'bg-white rounded shadow-lg w-full p-4 max-h-[90vh] overflow-y-auto ' + (wide ? 'max-w-2xl' : 'max-w-md')}>
        <div className="flex items-center justify-between mb-3">
          <div className="text-14 font-medium text-neutral-900">{title}</div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-neutral-500 hover:text-neutral-900"><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function rupees(p: number): string {
  return (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
