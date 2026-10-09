import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Download, Link2, MessageSquare, Trash2, Unlink, X } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import {
  gstApi,
  type ItcClassification,
  type MatchStatus,
  type ReconJob,
  type ReconRow,
  type ReconRowEntry,
} from '@/modules/tools/audit-automation/gst';
import { confirmAction } from '@/components/ConfirmDialog';

/**
 * /audit-automation/gst/jobs/:jobId — one GSTR-2B vs purchase-register
 * reconciliation: every category with counts, search, ITC filter, the ITC
 * call and its reason per row, reviewer notes, manual pairing of rows the
 * matcher couldn't connect, and the workbook / CSV exports.
 */

const PAGE = 100;

const STATUS: Record<MatchStatus, { label: string; hint: string; cls: string }> = {
  matched: { label: 'Matched', hint: 'Same invoice and amounts on both sides', cls: 'border-l-success text-success' },
  partial: { label: 'Partial', hint: 'Paired, but the invoice number or date differs', cls: 'border-l-amber text-amber' },
  variance: { label: 'Variance', hint: 'Paired, but taxable value or tax differs', cls: 'border-l-danger text-danger' },
  only_2b: { label: 'Missing in books', hint: 'In GSTR-2B, not in the purchase register', cls: 'border-l-primary text-primary' },
  only_pr: { label: 'Missing in 2B', hint: 'Booked, but the supplier has not filed it', cls: 'border-l-primary text-primary' },
  duplicate: { label: 'Duplicate', hint: 'The same invoice appears twice on one side', cls: 'border-l-neutral-400 text-neutral-700' },
};
const ORDER: MatchStatus[] = ['matched', 'partial', 'variance', 'only_2b', 'only_pr', 'duplicate'];

const ITC: Record<ItcClassification, string> = {
  eligible: 'Eligible',
  ineligible: 'Ineligible',
  blocked: 'Blocked s.17(5)',
  reversal: 'Reversal',
  rcm: 'Reverse charge',
};

const FLAG_TEXT: Record<string, string> = {
  PERIOD_MISMATCH: 'The GSTR-2B and the purchase register are for different periods.',
  INVALID_GSTINS: 'Some supplier GSTINs fail the checksum. They are marked in the table.',
  AMENDMENTS_APPLIED: 'Amended invoices in GSTR-2B (B2BA/CDNRA) replaced their originals before matching.',
};

const MISMATCH_TEXT: Record<string, string> = {
  taxable_value: 'Taxable', igst: 'IGST', cgst: 'CGST', sgst: 'SGST', cess: 'Cess',
  invoice_date: 'Date', invoice_number: 'Invoice no.', invoice_number_format: 'Invoice no. format',
  supplier_gstin: 'GSTIN', doc_type: 'Doc type', duplicate_in_2b: 'Twice in 2B', duplicate_in_books: 'Twice in books',
  manual_pair: 'Paired by hand', unpaired: 'Unpaired by hand',
};

export function GstReconDetailPage() {
  const { jobId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'all' | MatchStatus>('all');
  const [itc, setItc] = useState<'' | ItcClassification>('');
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchText.trim()); setOffset(0); }, 300);
    return () => clearTimeout(t);
  }, [searchText]);

  const jobQ = useQuery({
    queryKey: ['gst.job', jobId],
    enabled: Boolean(jobId),
    queryFn: () => gstApi.getRecon(jobId),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'queued' || s === 'matching' ? 1500 : false;
    },
  });
  const rowsQ = useQuery({
    queryKey: ['gst.rows', jobId, tab, itc, search, offset],
    enabled: Boolean(jobId) && jobQ.data?.status === 'matched',
    queryFn: () => gstApi.getReconRows(jobId, {
      status: tab, ...(itc ? { itc } : {}), ...(search ? { search } : {}), limit: PAGE, offset,
    }),
    placeholderData: (prev) => prev,
  });

  const remove = useMutation({
    mutationFn: () => gstApi.deleteRecon(jobId),
    onSuccess: () => {
      toast.push('success', 'Reconciliation deleted. The GSTR-2B and purchase register are kept.');
      qc.invalidateQueries({ queryKey: ['gst.jobs'] });
      navigate('/audit-automation/gst');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['gst.rows', jobId] }),
      qc.invalidateQueries({ queryKey: ['gst.job', jobId] }),
    ]);
  };

  const job = jobQ.data;
  const counts = rowsQ.data?.counts ?? {};
  const all = ORDER.reduce((n, s) => n + (counts[s] ?? 0), 0);
  const total = rowsQ.data?.total ?? 0;

  return (
    <div className="max-w-[1400px] mx-auto" data-testid="gst-detail">
      <div className="mb-4 flex items-center justify-between gap-2 flex-wrap">
        <Link to="/audit-automation/gst" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900">
          <ArrowLeft size={14} strokeWidth={1.75} /> GST reconciliation
        </Link>
        {job ? (
          <div className="flex items-center gap-2 flex-wrap">
            {job.status === 'matched' ? (
              <>
                <a href={gstApi.exportUrl(job.id)} download className="inline-flex items-center gap-1 h-8 px-3 text-13 border border-neutral-300 rounded bg-white hover:bg-neutral-50">
                  <Download size={14} strokeWidth={1.75} /> Workbook (.xlsx)
                </a>
                <a href={gstApi.exportCsvUrl(job.id)} download className="inline-flex items-center gap-1 h-8 px-3 text-13 border border-neutral-300 rounded bg-white hover:bg-neutral-50">
                  <Download size={14} strokeWidth={1.75} /> CSV
                </a>
              </>
            ) : null}
            <Button variant="secondary" size="sm" disabled={remove.isPending}
              onClick={async () => { if (await confirmAction('Delete this reconciliation and your review on it? The uploaded GSTR-2B and purchase register stay.')) remove.mutate(); }}>
              <Trash2 size={14} strokeWidth={1.75} className="mr-1" /> Delete
            </Button>
          </div>
        ) : null}
      </div>

      {jobQ.isLoading ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">Loading…</div>
      ) : jobQ.error ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-danger">Could not load this reconciliation: {(jobQ.error as Error).message}</div>
      ) : job ? (
        <>
          <Flags job={job} />
          <SummaryCards job={job} onPick={(s) => { setTab(s); setOffset(0); }} />
          {job.status !== 'matched' ? (
            <div className="bg-white border border-neutral-200 rounded p-6 mt-4 text-13 text-neutral-500">
              {job.status === 'failed' ? <span className="text-danger">{job.error_message || 'Reconciliation failed.'}</span> : `Matching… ${job.progress}%`}
            </div>
          ) : (
            <>
              <div className="mt-4 flex items-end justify-between gap-3 flex-wrap border-b border-neutral-200">
                <div className="flex gap-1 flex-wrap">
                  {(['all', ...ORDER] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => { setTab(k); setOffset(0); }}
                      title={k === 'all' ? undefined : STATUS[k].hint}
                      className={'px-3 py-2 text-13 border-b-2 -mb-px transition-colors ' +
                        (tab === k ? 'border-gold text-neutral-900 font-medium' : 'border-transparent text-neutral-500 hover:text-neutral-900')}
                    >
                      {k === 'all' ? 'All' : STATUS[k].label}
                      <span className="text-11 text-neutral-400 ml-1">{k === 'all' ? all : counts[k] ?? 0}</span>
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2 pb-2">
                  <input
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    placeholder="Search GSTIN, supplier, invoice no."
                    className="h-8 w-64 px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
                  />
                  <select
                    value={itc}
                    onChange={(e) => { setItc(e.target.value as '' | ItcClassification); setOffset(0); }}
                    className="h-8 px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
                    aria-label="Filter by ITC"
                  >
                    <option value="">All ITC</option>
                    {(Object.keys(ITC) as ItcClassification[]).map((k) => <option key={k} value={k}>{ITC[k]}</option>)}
                  </select>
                </div>
              </div>
              <RowsTable jobId={jobId} rows={rowsQ.data?.items ?? []} loading={rowsQ.isLoading} onChanged={refresh} />
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
      ) : null}
    </div>
  );
}

function Flags({ job }: { job: ReconJob }) {
  if (!job.flags?.length) return null;
  return (
    <div className="mb-3 border border-amber/40 bg-amber/10 rounded p-3 space-y-1">
      {job.flags.map((f) => (
        <div key={f} className="flex items-start gap-2 text-13 text-neutral-800">
          <AlertTriangle size={14} strokeWidth={1.75} className="text-amber mt-0.5 shrink-0" />
          <span>{FLAG_TEXT[f] ?? f}</span>
        </div>
      ))}
    </div>
  );
}

function SummaryCards({ job, onPick }: { job: ReconJob; onPick: (s: MatchStatus) => void }) {
  const count: Record<MatchStatus, number> = {
    matched: job.matched_count, partial: job.partial_count, variance: job.variance_count ?? 0,
    only_2b: job.only_2b_count, only_pr: job.only_pr_count, duplicate: job.duplicate_count ?? 0,
  };
  const all = ORDER.reduce((n, s) => n + count[s], 0);
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {ORDER.map((s) => {
        const t = job.totals?.[s];
        const tax = t ? t.igst + t.cgst + t.sgst + t.cess : 0;
        return (
          <button key={s} type="button" onClick={() => onPick(s)} title={STATUS[s].hint}
            className="text-left bg-white border border-neutral-200 rounded p-3 hover:border-gold">
            <div className="text-11 tracking-[0.06em] text-neutral-500">{STATUS[s].label.toUpperCase()}</div>
            <div className={'text-20 font-semibold mt-1 ' + STATUS[s].cls.split(' ')[1]}>{count[s]}</div>
            <div className="text-11 text-neutral-500 mt-1">
              {all ? `${Math.round((count[s] / all) * 100)}% · ` : ''}tax ₹{rupees(tax)}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function RowsTable({ jobId, rows, loading, onChanged }: { jobId: string; rows: ReconRow[]; loading?: boolean; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [noteFor, setNoteFor] = useState<ReconRow | null>(null);
  const [pairFor, setPairFor] = useState<ReconRow | null>(null);

  const setItc = useMutation({
    mutationFn: (v: { id: string; cls: ItcClassification }) => gstApi.updateRow(v.id, { itc_classification: v.cls }),
    onSuccess: async () => { toast.push('success', 'ITC classification updated.'); await onChanged(); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const unpair = useMutation({
    mutationFn: (id: string) => gstApi.unpair(id),
    onSuccess: async () => { toast.push('success', 'Split into “missing in books” and “missing in 2B”.'); await onChanged(); },
    onError: (e: Error) => toast.push('error', e.message),
  });

  if (loading) return <div className="mt-3 bg-white border border-neutral-200 rounded p-4 text-13 text-neutral-500">Loading rows…</div>;
  if (rows.length === 0) return <div className="mt-3 bg-white border border-neutral-200 rounded p-4 text-13 text-neutral-500">No rows here.</div>;

  return (
    <>
      <div className="mt-3 bg-white border border-neutral-200 rounded overflow-x-auto">
        <table className="w-full text-13 min-w-[1080px]">
          <thead>
            <tr className="text-left text-11 text-neutral-500 tracking-[0.06em]">
              <th className="px-3 py-2 font-normal">STATUS</th>
              <th className="px-3 py-2 font-normal">SUPPLIER</th>
              <th className="px-3 py-2 font-normal">INVOICE</th>
              <th className="px-3 py-2 font-normal text-right">GSTR-2B</th>
              <th className="px-3 py-2 font-normal text-right">BOOKS</th>
              <th className="px-3 py-2 font-normal">DIFFERENCES</th>
              <th className="px-3 py-2 font-normal">ITC · ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const two = r.filing_2b_entry;
              const pr = r.purchase_register_entry;
              const e = (two ?? pr)!;
              const paired = Boolean(two && pr);
              return (
                <tr key={r.id} className="border-t border-neutral-100 align-top">
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={'inline-flex items-center pl-2 pr-1 border-l-2 text-11 font-medium ' + STATUS[r.match_status].cls}>
                      {STATUS[r.match_status].label}
                    </span>
                    {r.match_method ? <div className="text-11 text-neutral-400 mt-0.5 pl-2">{methodText(r.match_method)}</div> : null}
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-neutral-900 truncate max-w-[200px]" title={e.supplier_name ?? ''}>{e.supplier_name ?? '—'}</div>
                    <div className="text-11 font-mono text-neutral-500">
                      {e.supplier_gstin}
                      {e.gstin_valid === false ? <span className="ml-1 text-danger font-sans" title="GSTIN fails the checksum">invalid</span> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <InvoiceCell two={two} pr={pr} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{two ? <Amounts e={two} /> : <span className="text-neutral-400">—</span>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{pr ? <Amounts e={pr} /> : <span className="text-neutral-400">—</span>}</td>
                  <td className="px-3 py-2">
                    {r.mismatch_fields.length === 0 ? <span className="text-neutral-400">—</span> : (
                      <div className="flex flex-wrap gap-1 max-w-[200px]">
                        {r.mismatch_fields.map((f) => (
                          <span key={f} className="text-11 px-1.5 py-0.5 rounded bg-amber/10 text-neutral-800">{MISMATCH_TEXT[f] ?? f}</span>
                        ))}
                      </div>
                    )}
                    {paired && diff(two!, pr!) !== 0 ? (
                      <div className="text-11 text-neutral-500 mt-1">tax diff ₹{rupees(diff(two!, pr!))}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 w-[270px]">
                    <div className="flex items-center gap-1">
                    <select
                      value={r.itc_classification}
                      onChange={(ev) => setItc.mutate({ id: r.id, cls: ev.target.value as ItcClassification })}
                      className="h-7 px-2 text-12 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold mr-1"
                      aria-label="ITC classification"
                    >
                      {(Object.keys(ITC) as ItcClassification[]).map((k) => <option key={k} value={k}>{ITC[k]}</option>)}
                    </select>
                      {r.match_status === 'only_2b' ? (
                        <IconButton title="Pair with an invoice from the books" onClick={() => setPairFor(r)}><Link2 size={14} strokeWidth={1.75} /></IconButton>
                      ) : null}
                      {paired && r.match_status !== 'duplicate' ? (
                        <IconButton title="Unpair" onClick={async () => { if (await confirmAction('Split this pair into “missing in books” and “missing in 2B”?')) unpair.mutate(r.id); }}>
                          <Unlink size={14} strokeWidth={1.75} />
                        </IconButton>
                      ) : null}
                      <IconButton title={r.auditor_note ? `Note: ${r.auditor_note}` : 'Add a note'} onClick={() => setNoteFor(r)} active={Boolean(r.auditor_note)}>
                        <MessageSquare size={14} strokeWidth={1.75} />
                      </IconButton>
                    </div>
                    {r.itc_reason ? <div className="text-11 text-neutral-500 mt-1">{r.itc_reason}</div> : null}
                    {r.auditor_note ? <div className="text-11 text-neutral-800 mt-1 border-l-2 border-gold pl-1.5" title={r.auditor_note}>Note: {r.auditor_note}</div> : null}
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

function InvoiceCell({ two, pr }: { two: ReconRowEntry | null; pr: ReconRowEntry | null }) {
  const a = two ?? pr!;
  const differs = two && pr && (two.invoice_number !== pr.invoice_number || two.invoice_date !== pr.invoice_date);
  return (
    <div>
      <div className="text-neutral-900">
        {a.invoice_number}
        {a.doc_type && a.doc_type !== 'INV' ? <span className="ml-1 text-11 px-1 rounded bg-neutral-100 text-neutral-600">{docText(a.doc_type)}</span> : null}
        {a.reverse_charge ? <span className="ml-1 text-11 px-1 rounded bg-primary/10 text-primary">RCM</span> : null}
      </div>
      <div className="text-11 text-neutral-500">{a.invoice_date}{two?.section ? ` · ${two.section.toUpperCase()}` : ''}</div>
      {two?.original_invoice_number ? <div className="text-11 text-neutral-500">amends {two.original_invoice_number}</div> : null}
      {differs ? <div className="text-11 text-neutral-500">books: {pr!.invoice_number} · {pr!.invoice_date}</div> : null}
      {two && two.itc_available === false ? <div className="text-11 text-danger">2B: ITC not available{two.itc_reason ? ` (${two.itc_reason})` : ''}</div> : null}
    </div>
  );
}

function Amounts({ e }: { e: ReconRowEntry }) {
  const tax = e.igst + e.cgst + e.sgst + e.cess;
  const heads = [e.igst ? `I ${rupees(e.igst)}` : '', e.cgst ? `C ${rupees(e.cgst)}` : '', e.sgst ? `S ${rupees(e.sgst)}` : '', e.cess ? `Cess ${rupees(e.cess)}` : ''].filter(Boolean).join(' · ');
  return (
    <div className="whitespace-nowrap">
      <div className="text-neutral-900">{rupees(e.taxable_value)}</div>
      <div className="text-11 text-neutral-500" title={heads}>tax {rupees(tax)}</div>
      {e.gl_code ? <div className="text-11 text-neutral-400 truncate max-w-[140px] ml-auto" title={e.gl_code}>{e.gl_code}</div> : null}
    </div>
  );
}

function IconButton({ title, onClick, active, children }: { title: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick}
      className={'h-7 w-7 inline-flex items-center justify-center rounded border ' +
        (active ? 'border-gold text-gold bg-gold/10' : 'border-neutral-200 text-neutral-500 hover:text-neutral-900 hover:border-neutral-400')}>
      {children}
    </button>
  );
}

function NoteModal({ row, onClose, onSaved }: { row: ReconRow; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [note, setNote] = useState(row.auditor_note ?? '');
  const [reason, setReason] = useState(row.itc_reason ?? '');
  const save = useMutation({
    mutationFn: () => gstApi.updateRow(row.id, {
      auditor_note: note.trim() || null,
      ...(reason.trim() !== (row.itc_reason ?? '') ? { itc_reason: reason.trim() || null } : {}),
    }),
    onSuccess: async () => { toast.push('success', 'Saved.'); await onSaved(); onClose(); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const inv = (row.filing_2b_entry ?? row.purchase_register_entry)!;
  return (
    <Dialog title={`Note — ${inv.invoice_number}`} onClose={onClose}>
      <label className="block text-12 text-neutral-600">Reviewer note
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} maxLength={2000}
          className="mt-1 w-full px-2 py-1.5 text-13 border border-neutral-300 rounded focus:outline-none focus:border-gold"
          placeholder="e.g. Supplier confirmed they will file in next month’s GSTR-1" />
      </label>
      <label className="block text-12 text-neutral-600 mt-3">ITC reason ({ITC[row.itc_classification]})
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
          className="mt-1 h-8 w-full px-2 text-13 border border-neutral-300 rounded focus:outline-none focus:border-gold" />
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
      </div>
    </Dialog>
  );
}

function PairModal({ jobId, row, onClose, onSaved }: { jobId: string; row: ReconRow; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const two = row.filing_2b_entry!;
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => { const t = setTimeout(() => setSearch(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const candidates = useQuery({
    queryKey: ['gst.rows', jobId, 'pair', search],
    queryFn: () => gstApi.getReconRows(jobId, { status: 'only_pr', ...(search ? { search } : {}), limit: 50 }),
  });
  const pair = useMutation({
    mutationFn: (prRowId: string) => gstApi.pair(jobId, row.id, prRowId),
    onSuccess: async (r) => { toast.push('success', `Paired — ${STATUS[r.match_status].label.toLowerCase()}.`); await onSaved(); onClose(); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  return (
    <Dialog title="Pair with an invoice from the books" onClose={onClose} wide>
      <div className="text-13 text-neutral-700 border border-neutral-200 rounded p-2 bg-neutral-50">
        <span className="text-11 text-neutral-500 mr-2">GSTR-2B</span>
        {two.supplier_name ?? two.supplier_gstin} · {two.invoice_number} · {two.invoice_date} · taxable ₹{rupees(two.taxable_value)} · tax ₹{rupees(two.igst + two.cgst + two.sgst + two.cess)}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search books-only invoices (GSTIN, supplier, invoice no.)"
        className="mt-3 h-8 w-full px-2 text-13 border border-neutral-300 rounded focus:outline-none focus:border-gold" />
      <div className="mt-2 max-h-[340px] overflow-y-auto border border-neutral-200 rounded">
        {candidates.isLoading ? <div className="p-3 text-13 text-neutral-500">Loading…</div>
          : !candidates.data?.items.length ? <div className="p-3 text-13 text-neutral-500">No books-only invoices match. Clear the search to see them all.</div>
          : (
            <table className="w-full text-13">
              <tbody>
                {[...candidates.data.items]
                  .sort((x, y) => Number(y.purchase_register_entry?.supplier_gstin === two.supplier_gstin) - Number(x.purchase_register_entry?.supplier_gstin === two.supplier_gstin))
                  .map((c) => {
                  const p = c.purchase_register_entry!;
                  return (
                    <tr key={c.id} className="border-t border-neutral-100 first:border-t-0">
                      <td className="px-2 py-1.5">
                        <div className="text-neutral-900">{p.invoice_number} <span className="text-11 text-neutral-500">{p.invoice_date}</span></div>
                        <div className="text-11 text-neutral-500">{p.supplier_name ?? '—'} · <span className="font-mono">{p.supplier_gstin}</span>
                          {p.supplier_gstin === two.supplier_gstin ? <span className="ml-1 text-success">same GSTIN</span> : null}</div>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        <div>{rupees(p.taxable_value)}</div>
                        <div className="text-11 text-neutral-500">tax {rupees(p.igst + p.cgst + p.sgst + p.cess)}</div>
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Button variant="secondary" size="sm" disabled={pair.isPending} onClick={() => pair.mutate(c.id)}>Pair</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </div>
    </Dialog>
  );
}

function Dialog({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-label={title}>
      <div className={'bg-white rounded shadow-lg w-full p-4 ' + (wide ? 'max-w-2xl' : 'max-w-md')}>
        <div className="flex items-center justify-between mb-3">
          <div className="text-14 font-medium text-neutral-900">{title}</div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-neutral-500 hover:text-neutral-900"><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function methodText(m: string): string {
  return ({ exact: 'exact match', invoice: 'by invoice no.', invoice_loose: 'invoice no. (loose)', amount_date: 'by amount + date', manual: 'paired by hand' } as Record<string, string>)[m] ?? m;
}
function docText(t: string): string {
  return ({ CRN: 'Credit note', DBN: 'Debit note', BOE: 'Bill of entry', ISD: 'ISD' } as Record<string, string>)[t] ?? t;
}
function diff(a: ReconRowEntry, b: ReconRowEntry): number {
  return (a.igst + a.cgst + a.sgst + a.cess) - (b.igst + b.cgst + b.sgst + b.cess);
}
function rupees(p: number): string {
  return (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
