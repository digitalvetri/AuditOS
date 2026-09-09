import { useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Upload, X, Check, ArrowRight } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { workstationApi } from '@/modules/workstation/api';
import type { ClientListItem } from '@/modules/workstation/types';
import { gstApi, type ColumnMap, type RegisterPreview } from '@/modules/tools/audit-automation/gst';
import type { ApiError } from '@/services/api';

/**
 * /audit-automation/gst/new — three-step reconciliation wizard.
 *
 *   1. Client + period (month + FY)
 *   2. GSTR-2B — drag-drop; format auto-detected (JSON | XLSX)
 *   3. Purchase Register — drag-drop; if Excel, show column-mapping
 *      table using the preview endpoint
 *
 * On submit, POSTs /recon and navigates to the detail page.
 */
export function GstNewReconPage() {
  const nav = useNavigate();
  const toast = useToast();

  const [clientId, setClientId] = useState('');
  const [periodMonth, setPeriodMonth] = useState<number>(new Date().getMonth() + 1);
  const [periodYear, setPeriodYear] = useState<number>(new Date().getFullYear());

  const [file2B, setFile2B] = useState<File | null>(null);
  const [filing2BId, setFiling2BId] = useState<string | null>(null);
  const [uploading2B, setUploading2B] = useState(false);
  const [error2B, setError2B] = useState<string | null>(null);

  const [filePR, setFilePR] = useState<File | null>(null);
  const [registerId, setRegisterId] = useState<string | null>(null);
  const [preview, setPreview] = useState<RegisterPreview | null>(null);
  const [uploadingPR, setUploadingPR] = useState(false);
  const [errorPR, setErrorPR] = useState<string | null>(null);
  const [prFormat, setPrFormat] = useState<'excel' | 'tally_xml' | null>(null);
  const [columnMap, setColumnMap] = useState<Partial<ColumnMap>>({});

  const [submitting, setSubmitting] = useState(false);

  const clientsQ = useQuery({
    queryKey: ['workstation.clients.for-aa'],
    queryFn: () => workstationApi.listClients(),
  });

  const readyToRecon = Boolean(clientId && filing2BId && registerId);

  async function do2BUpload(file: File) {
    if (!clientId) { setError2B('Pick a client first.'); return; }
    setUploading2B(true); setError2B(null);
    try {
      const result = await gstApi.upload2B({ clientId, periodMonth, periodYear, file });
      setFile2B(file);
      setFiling2BId(result.filing_id);
      toast.push('success', `2B parsed — ${result.entry_count} entries.`);
    } catch (err) {
      const e = err as ApiError;
      setError2B(e.message);
    } finally {
      setUploading2B(false);
    }
  }

  async function doPRUploadPreview(file: File) {
    if (!clientId) { setErrorPR('Pick a client first.'); return; }
    setUploadingPR(true); setErrorPR(null); setPreview(null); setRegisterId(null);
    try {
      const result = await gstApi.uploadPR({ clientId, periodMonth, periodYear, file });
      setPrFormat(result.source_format);
      setFilePR(file);
      if (result.preview) {
        setPreview(result.preview);
        setColumnMap({});
      } else if (result.register_id) {
        setRegisterId(result.register_id);
        toast.push('success', `Purchase register parsed — ${result.entry_count ?? 0} entries.`);
      }
    } catch (err) {
      const e = err as ApiError;
      setErrorPR(e.message);
    } finally {
      setUploadingPR(false);
    }
  }

  async function confirmColumnMap() {
    if (!filePR || !clientId) return;
    // Excel-step-2: send the file again with the column map. Server dedupes
    // on sha256 — the mid-upload scratch key was only for preview.
    // (In practice we'd cache the file server-side; for the first slice
    // re-uploading is simple and reliable.)
    const map = columnMap as ColumnMap;
    const required: (keyof ColumnMap)[] = ['supplierGstin', 'invoiceNumber', 'invoiceDate', 'taxableValue'];
    for (const k of required) {
      if (!map[k]) { setErrorPR(`Map the ${k} column before continuing.`); return; }
    }
    setUploadingPR(true); setErrorPR(null);
    try {
      const result = await gstApi.uploadPR({ clientId, periodMonth, periodYear, file: filePR, columnMap: map });
      if (result.register_id) {
        setRegisterId(result.register_id);
        setPreview(null);
        toast.push('success', `Purchase register parsed — ${result.entry_count ?? 0} entries.`);
      }
    } catch (err) {
      const e = err as ApiError;
      setErrorPR(e.message);
    } finally {
      setUploadingPR(false);
    }
  }

  async function runRecon(e: FormEvent) {
    e.preventDefault();
    if (!readyToRecon) return;
    setSubmitting(true);
    try {
      const job = await gstApi.createRecon({
        client_id: clientId, filing_2b_id: filing2BId!, purchase_register_id: registerId!,
      });
      toast.push('success', 'Reconciliation complete.');
      nav(`/audit-automation/gst/jobs/${job.id}`);
    } catch (err) {
      toast.push('error', (err as ApiError).message);
    } finally {
      setSubmitting(false);
    }
  }

  const yearOptions = useMemo(() => {
    const y = new Date().getFullYear();
    return [y - 2, y - 1, y, y + 1];
  }, []);

  return (
    <div className="max-w-[1000px] mx-auto" data-testid="gst-new">
      <div className="mb-4">
        <Link to="/audit-automation/gst" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900">
          <ArrowLeft size={14} strokeWidth={1.75} /> GST reconciliation
        </Link>
      </div>
      <header className="mb-5">
        <h1 className="text-20 font-semibold text-neutral-900">New GST reconciliation</h1>
        <p className="text-13 text-neutral-500 mt-1">Match a GSTR-2B against the client's Purchase Register.</p>
      </header>

      <form onSubmit={runRecon} className="bg-white border border-neutral-200 rounded p-5 md:p-6 space-y-6">
        {/* Client + period ─────────────────────────────────────────────── */}
        <section>
          <StepTitle n={1} title="Client & period" />
          <div className="grid grid-cols-1 md:grid-cols-[1fr_160px_140px] gap-3 mt-2">
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="h-9 px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
              data-testid="gst-client-select"
            >
              <option value="">Select client…</option>
              {(clientsQ.data?.items ?? []).map((c: ClientListItem) => (
                <option key={c.id} value={c.id}>
                  {c.company_name} · {c.client_id}
                </option>
              ))}
            </select>
            <select
              value={periodMonth}
              onChange={(e) => setPeriodMonth(Number(e.target.value))}
              className="h-9 px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>{monthName(m)}</option>
              ))}
            </select>
            <select
              value={periodYear}
              onChange={(e) => setPeriodYear(Number(e.target.value))}
              className="h-9 px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
            >
              {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </section>

        {/* GSTR-2B ─────────────────────────────────────────────────────── */}
        <section>
          <StepTitle n={2} title="GSTR-2B" done={Boolean(filing2BId)} />
          <p className="text-12 text-neutral-500 mt-1">Download the offline JSON or portal Excel from gst.gov.in.</p>
          {filing2BId ? (
            <ChosenFile file={file2B!} onRemove={() => { setFile2B(null); setFiling2BId(null); }} note="2B parsed" />
          ) : (
            <Dropzone
              accept=".json,.xlsx,.xls,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onFile={do2BUpload}
              busy={uploading2B}
              label="Drop the GSTR-2B here, or browse"
              hint="JSON or XLSX · max 25 MB"
              testId="gst-2b-dropzone"
            />
          )}
          {error2B ? <InlineError message={error2B} /> : null}
        </section>

        {/* Purchase Register ───────────────────────────────────────────── */}
        <section>
          <StepTitle n={3} title="Purchase Register" done={Boolean(registerId)} />
          <p className="text-12 text-neutral-500 mt-1">Client's book — Excel with any layout, or Tally XML export.</p>
          {registerId ? (
            <ChosenFile file={filePR!} onRemove={() => { setFilePR(null); setRegisterId(null); setPreview(null); setPrFormat(null); }} note={`${prFormat === 'tally_xml' ? 'Tally XML' : 'Excel'} parsed`} />
          ) : preview && prFormat === 'excel' ? (
            <ColumnMapping preview={preview} value={columnMap} onChange={setColumnMap} onConfirm={confirmColumnMap} busy={uploadingPR} />
          ) : (
            <Dropzone
              accept=".xlsx,.xls,.xml,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/xml,application/xml"
              onFile={doPRUploadPreview}
              busy={uploadingPR}
              label="Drop the Purchase Register here, or browse"
              hint="Excel or Tally XML · max 25 MB"
              testId="gst-pr-dropzone"
            />
          )}
          {errorPR ? <InlineError message={errorPR} /> : null}
        </section>

        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={!readyToRecon || submitting}>
            {submitting ? 'Running…' : (<>Run reconciliation <ArrowRight size={14} strokeWidth={2} className="ml-1" /></>)}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────

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

const TARGETS: { key: keyof ColumnMap; label: string; required: boolean }[] = [
  { key: 'supplierGstin', label: 'Supplier GSTIN', required: true },
  { key: 'supplierName', label: 'Supplier Name', required: false },
  { key: 'invoiceNumber', label: 'Invoice number', required: true },
  { key: 'invoiceDate', label: 'Invoice date', required: true },
  { key: 'taxableValue', label: 'Taxable value', required: true },
  { key: 'igst', label: 'IGST', required: false },
  { key: 'cgst', label: 'CGST', required: false },
  { key: 'sgst', label: 'SGST', required: false },
  { key: 'cess', label: 'Cess', required: false },
  { key: 'glCode', label: 'GL code', required: false },
];

function ColumnMapping({ preview, value, onChange, onConfirm, busy }: {
  preview: RegisterPreview;
  value: Partial<ColumnMap>;
  onChange: (v: Partial<ColumnMap>) => void;
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

function monthName(m: number): string {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
}
