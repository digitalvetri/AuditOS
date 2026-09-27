import { useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Upload, X, Check, ArrowRight, Trash2 } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { workstationApi } from '@/modules/workstation/api';
import type { ClientListItem } from '@/modules/workstation/types';
import { tdsApi, type TdsBooksColumnMap, type TdsBooksPreview } from '@/modules/tools/audit-automation/tds';
import type { ApiError } from '@/services/api';

/**
 * /audit-automation/tds/new — 3-step TDS recon wizard.
 * Structure mirrors GstNewRecon.tsx exactly; only the fields and
 * column-mapping targets change.
 */
export function TdsNewReconPage() {
  const nav = useNavigate();
  const toast = useToast();

  const [clientId, setClientId] = useState('');
  const now = new Date();
  // Default AY is the current FY's AY: FY 2026-27 → AY 2027-28 → year 2027
  const [assessmentYear, setAssessmentYear] = useState<number>(now.getMonth() + 1 >= 4 ? now.getFullYear() + 1 : now.getFullYear());

  const qc = useQueryClient();
  const [file26AS, setFile26AS] = useState<{ name: string; note: string } | null>(null);
  const [pending26AS, setPending26AS] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [authorised, setAuthorised] = useState(false);
  const [filing26ASId, setFiling26ASId] = useState<string | null>(null);
  const [uploading26AS, setUploading26AS] = useState(false);
  const [error26AS, setError26AS] = useState<string | null>(null);

  const [fileBooks, setFileBooks] = useState<File | null>(null);
  const [chosenBooks, setChosenBooks] = useState<{ name: string; note: string } | null>(null);
  const [booksId, setBooksId] = useState<string | null>(null);
  const [preview, setPreview] = useState<TdsBooksPreview | null>(null);
  const [uploadingBooks, setUploadingBooks] = useState(false);
  const [errorBooks, setErrorBooks] = useState<string | null>(null);
  const [booksFormat, setBooksFormat] = useState<'excel' | 'tally_xml' | null>(null);
  const [columnMap, setColumnMap] = useState<Partial<TdsBooksColumnMap>>({});

  const [submitting, setSubmitting] = useState(false);

  const clientsQ = useQuery({
    queryKey: ['workstation.clients.for-aa'],
    queryFn: () => workstationApi.listClients(),
  });

  const ready = Boolean(clientId && filing26ASId && booksId);
  const earlier26Q = useQuery({ queryKey: ['tds.26as', clientId], enabled: Boolean(clientId), queryFn: () => tdsApi.list26AS(clientId) });
  const earlierBkQ = useQuery({ queryKey: ['tds.books', clientId], enabled: Boolean(clientId), queryFn: () => tdsApi.listBooks(clientId) });
  const ayText = (y: number) => `AY ${y}-${String((y + 1) % 100).padStart(2, '0')}`;

  async function do26ASUpload(file: File) {
    if (!clientId) { setError26AS('Pick a client first.'); return; }
    setUploading26AS(true); setError26AS(null);
    try {
      const r = await tdsApi.upload26AS({ clientId, assessmentYear, file, password: password || undefined, authorised });
      setFile26AS({ name: file.name, note: `${r.entry_count} credits · ${r.pan ?? 'PAN not read'}${r.assessee_name ? ` · ${r.assessee_name}` : ''}${r.out_of_year ? ` · ${r.out_of_year} outside the FY` : ''}` });
      setFiling26ASId(r.filing_id); setPending26AS(null); setPassword('');
      void qc.invalidateQueries({ queryKey: ['tds.26as', clientId] });
      toast.push('success', `26AS read — ${r.entry_count} credits.`);
    } catch (err) {
      const e = err as ApiError;
      const existing = (e.details as { existing_filing_id?: string } | undefined)?.existing_filing_id;
      if (e.code === 'duplicate_upload' && existing) {
        setFiling26ASId(existing); setFile26AS({ name: file.name, note: 'already uploaded — using the earlier copy' });
      } else {
        if (e.code === 'password_required' || e.code === 'wrong_password' || e.code === 'authorisation_required') setPending26AS(file);
        setError26AS(e.message);
      }
    }
    finally { setUploading26AS(false); }
  }
  async function remove26AS(id: string, name: string) {
    if (!window.confirm(`Delete the 26AS “${name}”?`)) return;
    try { await tdsApi.delete26AS(id); if (filing26ASId === id) { setFiling26ASId(null); setFile26AS(null); } await qc.invalidateQueries({ queryKey: ['tds.26as', clientId] }); }
    catch (err) { toast.push('error', (err as ApiError).message); }
  }
  async function removeBooks(id: string, name: string) {
    if (!window.confirm(`Delete the TDS book “${name}”?`)) return;
    try { await tdsApi.deleteBooks(id); if (booksId === id) { setBooksId(null); setChosenBooks(null); } await qc.invalidateQueries({ queryKey: ['tds.books', clientId] }); }
    catch (err) { toast.push('error', (err as ApiError).message); }
  }

  async function doBooksUploadPreview(file: File) {
    if (!clientId) { setErrorBooks('Pick a client first.'); return; }
    setUploadingBooks(true); setErrorBooks(null); setPreview(null); setBooksId(null);
    try {
      const r = await tdsApi.uploadBooks({ clientId, assessmentYear, file });
      setBooksFormat(r.source_format);
      setFileBooks(file);
      if (r.preview) { setPreview(r.preview); setColumnMap({}); }
      else if (r.books_id) {
        setBooksId(r.books_id);
        setChosenBooks({ name: file.name, note: booksNote(r) });
        void qc.invalidateQueries({ queryKey: ['tds.books', clientId] });
        toast.push('success', `Books read — ${r.entry_count ?? 0} TDS entries.`);
      }
    } catch (err) {
      const e = err as ApiError;
      const existing = (e.details as { existing_books_id?: string } | undefined)?.existing_books_id;
      if (e.code === 'duplicate_upload' && existing) { setBooksId(existing); setChosenBooks({ name: file.name, note: 'already uploaded — using the earlier copy' }); }
      else setErrorBooks(e.message);
    }
    finally { setUploadingBooks(false); }
  }

  async function confirmColumnMap() {
    if (!fileBooks || !clientId) return;
    const map = columnMap as TdsBooksColumnMap;
    if (!map.deductorTan && !map.deductorName) { setErrorBooks('Map the deductor TAN or the deductor name.'); return; }
    if (!map.tdsAmount || !map.tdsDate) { setErrorBooks('Map the TDS amount and the date.'); return; }
    setUploadingBooks(true); setErrorBooks(null);
    try {
      const r = await tdsApi.uploadBooks({ clientId, assessmentYear, file: fileBooks, columnMap: map });
      if (r.books_id) {
        setBooksId(r.books_id); setPreview(null);
        setChosenBooks({ name: fileBooks.name, note: booksNote(r) });
        void qc.invalidateQueries({ queryKey: ['tds.books', clientId] });
        toast.push('success', `Books read — ${r.entry_count ?? 0} TDS entries.`);
      }
    } catch (err) { setErrorBooks((err as ApiError).message); }
    finally { setUploadingBooks(false); }
  }

  async function runRecon(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setSubmitting(true);
    try {
      const job = await tdsApi.createRecon({
        client_id: clientId, filing_26as_id: filing26ASId!, books_id: booksId!,
      });
      if (job.status === 'failed') { toast.push('error', job.error_message ?? 'Reconciliation failed.'); return; }
      toast.push('success', 'Reconciliation complete.');
      nav(`/audit-automation/tds/jobs/${job.id}`);
    } catch (err) { toast.push('error', (err as ApiError).message); }
    finally { setSubmitting(false); }
  }

  const yearOptions = useMemo(() => {
    const y = new Date().getFullYear();
    return [y - 1, y, y + 1, y + 2];
  }, []);

  return (
    <div className="max-w-[1000px] mx-auto" data-testid="tds-new">
      <div className="mb-4">
        <Link to="/audit-automation/tds" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900">
          <ArrowLeft size={14} strokeWidth={1.75} /> TDS reconciliation
        </Link>
      </div>
      <header className="mb-5">
        <h1 className="text-20 font-semibold text-neutral-900">New TDS reconciliation</h1>
        <p className="text-13 text-neutral-500 mt-1">Match Form 26AS against the client's TDS book.</p>
      </header>

      <form onSubmit={runRecon} className="bg-white border border-neutral-200 rounded p-5 md:p-6 space-y-6">
        <section>
          <StepTitle n={1} title="Client & assessment year" />
          <div className="grid grid-cols-1 md:grid-cols-[1fr_160px] gap-3 mt-2">
            <select
              value={clientId}
              onChange={(e) => { setClientId(e.target.value); setFiling26ASId(null); setFile26AS(null); setBooksId(null); setChosenBooks(null); setPreview(null); }}
              className="h-9 px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
              data-testid="tds-client-select"
            >
              <option value="">Select client…</option>
              {(clientsQ.data?.items ?? []).map((c: ClientListItem) => (
                <option key={c.id} value={c.id}>{c.company_name} · {c.client_id}</option>
              ))}
            </select>
            <select
              value={assessmentYear}
              onChange={(e) => setAssessmentYear(Number(e.target.value))}
              className="h-9 px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
            >
              {yearOptions.map((y) => <option key={y} value={y}>{ayText(y)} (FY {y - 1}-{String(y % 100).padStart(2, '0')})</option>)}
            </select>
          </div>
        </section>

        <section>
          <StepTitle n={2} title="Form 26AS" done={Boolean(filing26ASId)} />
          <p className="text-12 text-neutral-500 mt-1">TRACES → View Tax Credit (Form 26AS): download as Text or PDF. The PDF password is the date of birth / incorporation (DDMMYYYY).</p>
          {filing26ASId ? (
            <ChosenFile name={file26AS?.name ?? ''} note={file26AS?.note ?? ''} onRemove={() => { setFile26AS(null); setFiling26ASId(null); }} />
          ) : (
            <>
              <Earlier items={(earlier26Q.data?.items ?? []).map((f) => ({
                id: f.id, name: f.original_filename, meta: `${ayText(f.assessment_year)} · ${f.entry_count} credits · ${f.source_format.toUpperCase()}${f.pan ? ` · ${f.pan}` : ''}`,
                same: f.assessment_year === assessmentYear,
                onUse: () => { if (f.assessment_year !== assessmentYear) { setError26AS(`That 26AS is for ${ayText(f.assessment_year)}.`); return; } setFiling26ASId(f.id); setFile26AS({ name: f.original_filename, note: `${f.entry_count} credits${f.pan ? ` · ${f.pan}` : ''}` }); setError26AS(null); },
                onDelete: () => remove26AS(f.id, f.original_filename),
              }))} />
              {pending26AS ? (
                <div className="mt-2 border border-amber/40 bg-amber/10 rounded p-3 space-y-2">
                  <div className="text-13">{pending26AS.name} is password-protected.</div>
                  <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (DDMMYYYY)" className="h-8 w-56 px-2 text-13 border border-neutral-300 rounded bg-white" />
                  <label className="flex items-center gap-1.5 text-12 text-neutral-700"><input type="checkbox" checked={authorised} onChange={(e) => setAuthorised(e.target.checked)} /> I am authorised by the client to open this statement.</label>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" variant="primary" disabled={!password || !authorised || uploading26AS} onClick={() => void do26ASUpload(pending26AS)}>{uploading26AS ? 'Opening…' : 'Open'}</Button>
                    <Button type="button" size="sm" variant="secondary" onClick={() => { setPending26AS(null); setPassword(''); setError26AS(null); }}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <Dropzone
                  accept=".txt,.pdf,.xlsx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onFile={do26ASUpload}
                  busy={uploading26AS}
                  label="Drop the 26AS here, or browse"
                  hint="TRACES text (.txt), PDF or Excel · max 25 MB"
                  testId="tds-26as-dropzone"
                />
              )}
            </>
          )}
          {error26AS ? <InlineError message={error26AS} /> : null}
        </section>

        <section>
          <StepTitle n={3} title="Books — TDS receivable" done={Boolean(booksId)} />
          <p className="text-12 text-neutral-500 mt-1">The TDS customers deducted from the client, as booked: a Tally XML export of the receipts / journals that debit the TDS receivable ledger, or an Excel register.</p>
          {booksId ? (
            <ChosenFile name={chosenBooks?.name ?? fileBooks?.name ?? ''} note={chosenBooks?.note ?? ''} onRemove={() => { setFileBooks(null); setChosenBooks(null); setBooksId(null); setPreview(null); setBooksFormat(null); }} />
          ) : preview && booksFormat === 'excel' ? (
            <ColumnMapping preview={preview} value={columnMap} onChange={setColumnMap} onConfirm={confirmColumnMap} busy={uploadingBooks} />
          ) : (
            <>
            <Earlier items={(earlierBkQ.data?.items ?? []).map((b) => ({
              id: b.id, name: b.original_filename, meta: `${ayText(b.assessment_year)} · ${b.entry_count} entries · ${b.source_format === 'tally_xml' ? 'Tally XML' : 'Excel'}`,
              same: b.assessment_year === assessmentYear,
              onUse: () => { if (b.assessment_year !== assessmentYear) { setErrorBooks(`That book is for ${ayText(b.assessment_year)}.`); return; } setBooksId(b.id); setChosenBooks({ name: b.original_filename, note: `${b.entry_count} entries` }); setErrorBooks(null); },
              onDelete: () => removeBooks(b.id, b.original_filename),
            }))} />
            <Dropzone
              accept=".xlsx,.xml,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/xml,application/xml"
              onFile={doBooksUploadPreview}
              busy={uploadingBooks}
              label="Drop the TDS book here, or browse"
              hint="Excel or Tally XML · max 25 MB"
              testId="tds-books-dropzone"
            />
            </>
          )}
          {errorBooks ? <InlineError message={errorBooks} /> : null}
        </section>

        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={!ready || submitting}>
            {submitting ? 'Running…' : (<>Run reconciliation <ArrowRight size={14} strokeWidth={2} className="ml-1" /></>)}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ── Shared minor components (copied from GstNewRecon shape) ────────────

function StepTitle({ n, title, done }: { n: number; title: string; done?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={
        'inline-flex items-center justify-center w-5 h-5 rounded-full text-11 font-semibold ' +
        (done ? 'bg-success/10 text-success' : 'bg-neutral-100 text-neutral-600')
      }>
        {done ? <Check size={12} strokeWidth={2.5} /> : n}
      </span>
      <h2 className="text-13 font-semibold text-neutral-900">{title}</h2>
    </div>
  );
}

function Dropzone({ accept, onFile, busy, label, hint, testId }: {
  accept: string; onFile: (f: File) => void; busy?: boolean; label: string; hint: string; testId?: string;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => {
    e.preventDefault(); setOver(false);
    const f = Array.from(e.dataTransfer.files)[0];
    if (f) onFile(f);
  };
  return (
    <div
      role="button" tabIndex={0}
      onClick={() => !busy && ref.current?.click()}
      onKeyDown={(e) => { if (!busy && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ref.current?.click(); } }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={
        'w-full mt-2 rounded border border-dashed text-center px-4 py-6 transition-colors ' +
        (busy ? 'opacity-60 cursor-wait ' : 'cursor-pointer ') +
        (over ? 'border-gold bg-neutral-50' : 'border-neutral-300 bg-white hover:bg-neutral-50')
      }
      data-testid={testId}
    >
      <input ref={ref} type="file" accept={accept} className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      <Upload size={20} strokeWidth={1.5} className="text-neutral-400 mx-auto mb-2" />
      <div className="text-13 text-neutral-900">{busy ? 'Uploading…' : label}</div>
      <div className="text-12 text-neutral-500 mt-1">{hint}</div>
    </div>
  );
}

function booksNote(r: { source_format: string; entry_count?: number; out_of_year?: number; without_tan?: number }) {
  return [`${r.source_format === 'tally_xml' ? 'Tally XML' : 'Excel'} · ${r.entry_count ?? 0} TDS entries`,
    r.without_tan ? `${r.without_tan} without TAN (matched by name)` : '', r.out_of_year ? `${r.out_of_year} outside the FY` : ''].filter(Boolean).join(' · ');
}

function Earlier({ items }: { items: { id: string; name: string; meta: string; same: boolean; onUse: () => void; onDelete: () => void }[] }) {
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => Number(b.same) - Number(a.same));
  return (
    <div className="mt-2 border border-neutral-200 rounded">
      <div className="px-3 py-1.5 text-11 tracking-[0.06em] text-neutral-500 border-b border-neutral-100">UPLOADED EARLIER FOR THIS CLIENT</div>
      <ul className="max-h-[180px] overflow-y-auto">
        {sorted.map((i) => (
          <li key={i.id} className="flex items-center gap-3 px-3 py-1.5 border-t border-neutral-100 first:border-t-0">
            <div className="min-w-0 flex-1">
              <div className="text-13 text-neutral-900 truncate">{i.name}</div>
              <div className="text-11 text-neutral-500">{i.meta}{i.same ? ' · this year' : ''}</div>
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={i.onUse}>Use</Button>
            <button type="button" onClick={i.onDelete} aria-label={`Delete ${i.name}`} title="Delete" className="text-neutral-400 hover:text-danger"><Trash2 size={14} strokeWidth={1.75} /></button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChosenFile({ name, onRemove, note }: { name: string; onRemove: () => void; note: string }) {
  return (
    <div className="mt-2 flex items-center gap-3 bg-neutral-50 border border-neutral-200 rounded px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-13 text-neutral-900 truncate">{name}</div>
        <div className="text-12 text-neutral-500">{note}</div>
      </div>
      <button type="button" onClick={onRemove} aria-label="Remove file" className="text-neutral-400 hover:text-neutral-700">
        <X size={16} strokeWidth={1.75} />
      </button>
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  return <div className="mt-2 border-l-2 border-danger bg-canvas px-3 py-2 text-13 text-neutral-900">{message}</div>;
}

const TARGETS: { key: keyof TdsBooksColumnMap; label: string; required: boolean }[] = [
  { key: 'deductorTan', label: 'Deductor TAN (or name)', required: false },
  { key: 'deductorName', label: 'Deductor name (or TAN)', required: false },
  { key: 'section', label: 'Section', required: false },
  { key: 'reference', label: 'Invoice / voucher no.', required: false },
  { key: 'quarter', label: 'Quarter', required: false },
  { key: 'amountPaid', label: 'Amount Paid', required: false },
  { key: 'tdsAmount', label: 'TDS Amount', required: true },
  { key: 'tdsDate', label: 'TDS Date', required: true },
  { key: 'glCode', label: 'GL code', required: false },
];

function ColumnMapping({ preview, value, onChange, onConfirm, busy }: {
  preview: TdsBooksPreview;
  value: Partial<TdsBooksColumnMap>;
  onChange: (v: Partial<TdsBooksColumnMap>) => void;
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <div className="mt-3 border border-neutral-200 rounded overflow-hidden">
      <div className="px-4 py-2 bg-neutral-50 border-b border-neutral-200 text-13 text-neutral-900 font-medium">
        Map spreadsheet columns → target fields
      </div>
      <div className="p-4 space-y-3">
        <div className="grid grid-cols-[180px_1fr] gap-2 items-center">
          {TARGETS.map((t) => (
            <div key={t.key} className="contents">
              <label className="text-13 text-neutral-900">
                {t.label}{t.required ? <span className="text-danger ml-0.5">*</span> : null}
              </label>
              <select
                value={value[t.key] ?? ''}
                onChange={(e) => {
                  const next = { ...value };
                  if (e.target.value) (next as Record<string, string>)[t.key] = e.target.value;
                  else delete (next as Record<string, string>)[t.key];
                  onChange(next);
                }}
                className="h-8 px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
              >
                <option value="">— None —</option>
                {preview.columns.map((col, i) => (
                  <option key={col} value={col}>{col}{preview.headerRow[i] ? ` · ${preview.headerRow[i]}` : ''}</option>
                ))}
              </select>
            </div>
          ))}
        </div>

        <div className="mt-4 overflow-x-auto">
          <div className="text-11 text-neutral-500 tracking-[0.06em] mb-1">PREVIEW · FIRST {preview.rows.length} ROWS · SHEET “{preview.sheetName}”</div>
          <table className="text-12 border border-neutral-200 rounded">
            <thead>
              <tr>
                {preview.columns.map((c) => (
                  <th key={c} className="px-2 py-1 bg-neutral-50 border-b border-neutral-200 text-left font-medium text-neutral-600">{c}</th>
                ))}
              </tr>
              <tr>
                {preview.headerRow.map((h, i) => (
                  <th key={i} className="px-2 py-1 bg-neutral-50 border-b border-neutral-200 text-left font-normal text-neutral-500">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((r, i) => (
                <tr key={i} className="border-t border-neutral-100">
                  {r.map((cell, j) => <td key={j} className="px-2 py-1 text-neutral-900">{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex justify-end">
          <Button type="button" size="sm" variant="primary" onClick={onConfirm} disabled={busy}>
            {busy ? 'Parsing…' : 'Confirm mapping'}
          </Button>
        </div>
      </div>
    </div>
  );
}
