import { useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Upload, X, Check, ArrowRight } from 'lucide-react';
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

  const [file26AS, setFile26AS] = useState<File | null>(null);
  const [filing26ASId, setFiling26ASId] = useState<string | null>(null);
  const [uploading26AS, setUploading26AS] = useState(false);
  const [error26AS, setError26AS] = useState<string | null>(null);

  const [fileBooks, setFileBooks] = useState<File | null>(null);
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

  async function do26ASUpload(file: File) {
    if (!clientId) { setError26AS('Pick a client first.'); return; }
    setUploading26AS(true); setError26AS(null);
    try {
      const r = await tdsApi.upload26AS({ clientId, assessmentYear, file });
      setFile26AS(file); setFiling26ASId(r.filing_id);
      toast.push('success', `26AS parsed — ${r.entry_count} entries.`);
    } catch (err) { setError26AS((err as ApiError).message); }
    finally { setUploading26AS(false); }
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
        toast.push('success', `Books parsed — ${r.entry_count ?? 0} entries.`);
      }
    } catch (err) { setErrorBooks((err as ApiError).message); }
    finally { setUploadingBooks(false); }
  }

  async function confirmColumnMap() {
    if (!fileBooks || !clientId) return;
    const map = columnMap as TdsBooksColumnMap;
    const required: (keyof TdsBooksColumnMap)[] = ['deductorTan', 'section', 'tdsAmount', 'tdsDate'];
    for (const k of required) {
      if (!map[k]) { setErrorBooks(`Map the ${k} column before continuing.`); return; }
    }
    setUploadingBooks(true); setErrorBooks(null);
    try {
      const r = await tdsApi.uploadBooks({ clientId, assessmentYear, file: fileBooks, columnMap: map });
      if (r.books_id) {
        setBooksId(r.books_id); setPreview(null);
        toast.push('success', `Books parsed — ${r.entry_count ?? 0} entries.`);
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
              onChange={(e) => setClientId(e.target.value)}
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
              {yearOptions.map((y) => <option key={y} value={y}>AY {y}-{String((y + 1) % 100).padStart(2, '0')}</option>)}
            </select>
          </div>
        </section>

        <section>
          <StepTitle n={2} title="Form 26AS" done={Boolean(filing26ASId)} />
          <p className="text-12 text-neutral-500 mt-1">Download the text or Excel from TRACES.</p>
          {filing26ASId ? (
            <ChosenFile file={file26AS!} onRemove={() => { setFile26AS(null); setFiling26ASId(null); }} note="26AS parsed" />
          ) : (
            <Dropzone
              accept=".txt,.xlsx,.xls,.csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onFile={do26ASUpload}
              busy={uploading26AS}
              label="Drop the 26AS here, or browse"
              hint="Text or Excel · max 25 MB"
              testId="tds-26as-dropzone"
            />
          )}
          {error26AS ? <InlineError message={error26AS} /> : null}
        </section>

        <section>
          <StepTitle n={3} title="Books TDS register" done={Boolean(booksId)} />
          <p className="text-12 text-neutral-500 mt-1">Client's book — Excel with any layout, or Tally XML export.</p>
          {booksId ? (
            <ChosenFile file={fileBooks!} onRemove={() => { setFileBooks(null); setBooksId(null); setPreview(null); setBooksFormat(null); }} note={`${booksFormat === 'tally_xml' ? 'Tally XML' : 'Excel'} parsed`} />
          ) : preview && booksFormat === 'excel' ? (
            <ColumnMapping preview={preview} value={columnMap} onChange={setColumnMap} onConfirm={confirmColumnMap} busy={uploadingBooks} />
          ) : (
            <Dropzone
              accept=".xlsx,.xls,.xml,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/xml,application/xml"
              onFile={doBooksUploadPreview}
              busy={uploadingBooks}
              label="Drop the TDS book here, or browse"
              hint="Excel or Tally XML · max 25 MB"
              testId="tds-books-dropzone"
            />
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
        (done ? 'bg-green-100 text-green-700' : 'bg-neutral-100 text-neutral-600')
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

function ChosenFile({ file, onRemove, note }: { file: File; onRemove: () => void; note: string }) {
  return (
    <div className="mt-2 flex items-center gap-3 bg-neutral-50 border border-neutral-200 rounded px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-13 text-neutral-900 truncate">{file.name}</div>
        <div className="text-12 text-neutral-500">{(file.size / 1024).toFixed(0)} KB · {note}</div>
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
  { key: 'deductorTan', label: 'Deductor TAN', required: true },
  { key: 'deductorName', label: 'Deductor Name', required: false },
  { key: 'section', label: 'Section', required: true },
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
