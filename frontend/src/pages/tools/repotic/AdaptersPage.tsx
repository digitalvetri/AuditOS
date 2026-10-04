/**
 * /audit-automation/ecommerce/adapters — Repotic adapter registry.
 *
 * One row per adapter version. Each adapter decides whether a file from a
 * given marketplace × report_kind fingerprints as `matched`, so this page is
 * what firms use to add Flipkart / Meesho / Myntra / etc. without a
 * developer seeding code. Workflow:
 *
 *   1. "New adapter" → pick marketplace + report_kind + upload sample file.
 *   2. Headers come back; staffer maps each standard field to a header via
 *      a dropdown. A sample row preview sits next to the mapping so the
 *      staffer can see which column actually holds "invoice amount" when a
 *      marketplace labels it "Order Value".
 *   3. Save → next upload for that scope auto-matches the new adapter.
 *
 * Versioning: v2 is created alongside v1 (not replacing it) so already-
 * uploaded files against v1 stay interpretable. Toggle active on an old
 * version to retire it.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, X, Upload as UploadIcon, Check, Info } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { repoticApi, type AdapterEntry, type AdapterPreviewResult } from '@/modules/tools/repotic/api';

/** The standard field vocabulary the GSTR-1 builder understands. Changing
 *  this list changes what a staffer can map. Each entry = one dropdown
 *  row in the mapping step. */
const STANDARD_FIELDS: Array<{ key: string; label: string; required?: boolean; hint?: string }> = [
  { key: 'invoice_number', label: 'Invoice number', required: true, hint: 'B2CL / 9B entries key off this' },
  { key: 'invoice_date', label: 'Invoice date', required: true },
  { key: 'invoice_amount', label: 'Invoice amount (gross)', required: true, hint: 'B2CL threshold is tested against this' },
  { key: 'taxable_value', label: 'Taxable value', required: true },
  { key: 'transaction_type', label: 'Transaction type', hint: 'Shipment / Cancel / Refund / FreeReplacement' },
  { key: 'ship_to_state', label: 'Ship-to state' },
  { key: 'seller_gstin', label: 'Seller GSTIN' },
  { key: 'cgst_tax', label: 'CGST tax amount' },
  { key: 'sgst_tax', label: 'SGST tax amount' },
  { key: 'igst_tax', label: 'IGST tax amount' },
  { key: 'cess_tax', label: 'Cess tax amount' },
  { key: 'cgst_rate', label: 'CGST rate' },
  { key: 'sgst_rate', label: 'SGST rate' },
  { key: 'igst_rate', label: 'IGST rate' },
  { key: 'hsn', label: 'HSN code', hint: 'Table 12 keys off this' },
  { key: 'quantity', label: 'Quantity' },
  { key: 'credit_note_number', label: 'Credit note number', hint: 'Table 9B keys off this' },
  { key: 'credit_note_date', label: 'Credit note date' },
];

const MARKETPLACES = [
  { key: 'amazon', label: 'Amazon' },
  { key: 'flipkart', label: 'Flipkart' },
  { key: 'meesho', label: 'Meesho' },
  { key: 'myntra', label: 'Myntra' },
  { key: 'ajio', label: 'Ajio' },
  { key: 'glowroad', label: 'GlowRoad' },
  { key: 'jiomart', label: 'JioMart' },
  { key: 'limeroad', label: 'LimeRoad' },
  { key: 'shop101', label: 'Shop101' },
  { key: 'citymall', label: 'CityMall' },
  { key: 'paytm', label: 'Paytm' },
  { key: 'snapdeal', label: 'Snapdeal' },
  { key: 'gov_excel', label: 'Govt. Excel template' },
  { key: 'other', label: 'Other' },
];

const REPORT_KINDS_BY_MARKETPLACE: Record<string, Array<{ key: string; label: string }>> = {
  amazon: [{ key: 'mtr_b2c', label: 'MTR B2C' }, { key: 'mtr_b2b', label: 'MTR B2B' }],
  flipkart: [{ key: 'sales', label: 'Sales report' }, { key: 'gst', label: 'GST report' }],
  meesho: [{ key: 'sales', label: 'Sales report' }],
  myntra: [{ key: 'sales', label: 'Sales report' }],
  ajio: [{ key: 'sales', label: 'Sales report' }],
  glowroad: [{ key: 'b2c_tcs', label: 'B2C TCS' }, { key: 'b2b_tcs', label: 'B2B TCS' }],
  jiomart: [{ key: 'sales', label: 'Sales report' }],
  limeroad: [{ key: 'sales', label: 'Sales report' }],
  shop101: [{ key: 'sales', label: 'Sales report' }],
  citymall: [{ key: 'sales', label: 'Sales report' }],
  paytm: [{ key: 'sales', label: 'Sales report' }],
  snapdeal: [{ key: 'sales', label: 'Sales report' }],
  gov_excel: [{ key: 'summary', label: 'Summary' }],
  other: [{ key: 'b2c_sheet', label: 'B2C sheet' }, { key: 'b2b_sheet', label: 'B2B sheet' }],
};

export function AdaptersPage() {
  const [wizardOpen, setWizardOpen] = useState(false);
  const adaptersQ = useQuery({ queryKey: ['repotic.adapters'], queryFn: () => repoticApi.adapters() });
  const qc = useQueryClient();
  const toast = useToast();

  const toggleActive = useMutation({
    mutationFn: (v: { id: string; active: boolean }) => repoticApi.adapterUpdate(v.id, { active: v.active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repotic.adapters'] }),
    onError: (e: Error) => toast.push('error', e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => repoticApi.adapterDelete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['repotic.adapters'] });
      toast.push('success', 'Adapter deleted.');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const grouped = useMemo(() => {
    const by: Record<string, AdapterEntry[]> = {};
    for (const a of adaptersQ.data?.items ?? []) {
      const key = `${a.marketplace}:${a.report_kind}`;
      (by[key] ||= []).push(a);
    }
    return by;
  }, [adaptersQ.data]);

  return (
    <div className="max-w-[1240px] mx-auto">
      <div className="mb-4">
        <Link to="/audit-automation/ecommerce" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900">
          <ArrowLeft size={14} strokeWidth={1.75} /> Ecommerce GSTR-1
        </Link>
      </div>

      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-20 font-semibold text-neutral-900">Marketplace adapters</h1>
          <p className="text-13 text-neutral-500 mt-1">
            One adapter per marketplace × report kind. Each defines the header fingerprint used to detect the format, and the column map that turns rows into GSTR-1-ready fields.
          </p>
        </div>
        <button type="button" onClick={() => setWizardOpen(true)}
          className="h-9 px-3 inline-flex items-center gap-1.5 text-13 font-medium bg-neutral-900 text-white rounded hover:bg-neutral-700">
          <Plus size={14} strokeWidth={2} /> New adapter
        </button>
      </header>

      <section className="bg-white border border-neutral-200 rounded overflow-hidden">
        {adaptersQ.isLoading ? (
          <div className="p-6 text-13 text-neutral-500">Loading…</div>
        ) : Object.keys(grouped).length === 0 ? (
          <div className="p-6 text-13 text-neutral-500">
            No adapters yet. Upload a sample marketplace file via "New adapter" above to seed the first one.
          </div>
        ) : (
          <table className="w-full text-13">
            <thead>
              <tr className="text-11 uppercase tracking-[0.06em] text-neutral-500 border-b border-neutral-200">
                <th className="text-left px-4 h-8 font-medium">Marketplace / Report</th>
                <th className="text-left px-2 font-medium w-[80px]">Version</th>
                <th className="text-left px-2 font-medium">Columns detected</th>
                <th className="text-left px-2 font-medium">Covers</th>
                <th className="text-left px-2 font-medium w-[120px]">Status</th>
                <th className="text-right px-4 font-medium w-[80px]"></th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(grouped).flatMap(([, versions]) =>
                versions.map((a, idx) => (
                  <tr key={a.id} className="border-b border-neutral-100">
                    <td className="px-4 py-2.5 text-neutral-800">
                      {idx === 0 ? (
                        <>
                          <div className="font-medium">{marketplaceLabel(a.marketplace)}</div>
                          <div className="text-11 text-neutral-500 mt-0.5">{reportKindLabel(a.marketplace, a.report_kind)}</div>
                        </>
                      ) : <span className="text-neutral-400">·</span>}
                    </td>
                    <td className="px-2 py-2.5 text-neutral-700">v{a.version}</td>
                    <td className="px-2 py-2.5 text-11 text-neutral-500">
                      {a.detect_columns.length} columns · {Object.keys(a.column_map).length} mapped
                    </td>
                    <td className="px-2 py-2.5 text-11 text-neutral-500">
                      {coverageSummary(a.coverage)}
                    </td>
                    <td className="px-2 py-2.5">
                      <label className="inline-flex items-center gap-1 text-12">
                        <input type="checkbox" checked={a.active}
                          onChange={(e) => toggleActive.mutate({ id: a.id, active: e.target.checked })} />
                        <span className={a.active ? 'text-success' : 'text-neutral-500'}>
                          {a.active ? 'Active' : 'Retired'}
                        </span>
                      </label>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button type="button"
                        onClick={() => { if (confirm(`Delete v${a.version} of this ${marketplaceLabel(a.marketplace)} adapter?`)) del.mutate(a.id); }}
                        className="text-11 text-neutral-500 hover:text-danger inline-flex items-center gap-1">
                        <Trash2 size={12} /> Delete
                      </button>
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        )}
      </section>

      {wizardOpen ? (
        <NewAdapterWizard onClose={() => setWizardOpen(false)}
          onCreated={() => { setWizardOpen(false); qc.invalidateQueries({ queryKey: ['repotic.adapters'] }); toast.push('success', 'Adapter saved.'); }} />
      ) : null}
    </div>
  );
}

function marketplaceLabel(key: string): string {
  return MARKETPLACES.find((m) => m.key === key)?.label ?? key;
}
function reportKindLabel(marketplace: string, key: string): string {
  return REPORT_KINDS_BY_MARKETPLACE[marketplace]?.find((r) => r.key === key)?.label ?? key;
}
function coverageSummary(cov: Record<string, boolean>): string {
  const yes = Object.entries(cov).filter(([, v]) => v).map(([k]) => k);
  if (yes.length === 0) return '—';
  return yes.join(', ');
}

/**
 * Three-step wizard — pick marketplace+file → map columns → review+save.
 * Kept inline in one modal rather than three routes because the user is
 * reading the sample row while mapping; splitting across pages would hide
 * context exactly when it is needed.
 */
function NewAdapterWizard({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [marketplace, setMarketplace] = useState('');
  const [reportKind, setReportKind] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<AdapterPreviewResult | null>(null);
  const [columnMap, setColumnMap] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const toast = useToast();

  const previewing = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Pick a file first.');
      const fd = new FormData();
      fd.append('file', file);
      fd.append('marketplace', marketplace);
      fd.append('report_kind', reportKind);
      return repoticApi.adapterPreview(fd);
    },
    onSuccess: (r) => { setPreview(r); setStep(2); },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error('No preview.');
      return repoticApi.adapterCreate({
        marketplace, report_kind: reportKind,
        detect_columns: preview.headers,
        column_map: columnMap,
        notes: notes || undefined,
      });
    },
    onSuccess: onCreated,
    onError: (e: Error) => toast.push('error', e.message),
  });

  const kinds = REPORT_KINDS_BY_MARKETPLACE[marketplace] ?? [];
  const requiredMissing = STANDARD_FIELDS.filter((f) => f.required && !columnMap[f.key]).map((f) => f.label);

  return (
    <div role="dialog" aria-label="New adapter" className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-6 overflow-y-auto">
      <div className="w-full max-w-[920px] bg-white rounded shadow-xl mt-6">
        <div className="flex items-center justify-between p-4 border-b border-neutral-200">
          <div>
            <div className="text-11 tracking-[0.06em] text-neutral-500">STEP {step} OF 3</div>
            <div className="text-14 font-semibold text-neutral-900">
              {step === 1 ? 'Choose marketplace and upload sample' : step === 2 ? 'Map columns' : 'Review and save'}
            </div>
          </div>
          <button type="button" onClick={onClose} className="h-8 w-8 inline-flex items-center justify-center text-neutral-500 hover:text-neutral-900 rounded">
            <X size={16} />
          </button>
        </div>
        <div className="p-4">
          {step === 1 ? (
            <Step1
              marketplace={marketplace} setMarketplace={(k) => { setMarketplace(k); setReportKind(''); }}
              reportKind={reportKind} setReportKind={setReportKind}
              kinds={kinds} file={file} setFile={setFile}
            />
          ) : step === 2 && preview ? (
            <Step2 preview={preview} columnMap={columnMap} setColumnMap={setColumnMap} />
          ) : step === 3 && preview ? (
            <Step3 preview={preview} columnMap={columnMap} notes={notes} setNotes={setNotes} />
          ) : null}
        </div>
        <div className="p-4 border-t border-neutral-200 flex items-center justify-between gap-3">
          <div className="text-11 text-neutral-500">
            {step === 2 && requiredMissing.length > 0
              ? <>Still to map: <strong>{requiredMissing.join(', ')}</strong></>
              : null}
          </div>
          <div className="flex items-center gap-2">
            {step > 1 ? <button type="button" onClick={() => setStep((step - 1) as 1 | 2)} className="h-9 px-3 text-13 border border-neutral-300 rounded hover:bg-neutral-50">Back</button> : null}
            {step === 1 ? (
              <button type="button" disabled={!marketplace || !reportKind || !file || previewing.isPending}
                onClick={() => previewing.mutate()}
                className="h-9 px-3 text-13 bg-neutral-900 text-white rounded hover:bg-neutral-700 disabled:opacity-50">
                {previewing.isPending ? 'Reading file…' : 'Next → read headers'}
              </button>
            ) : step === 2 ? (
              <button type="button" disabled={requiredMissing.length > 0}
                onClick={() => setStep(3)}
                className="h-9 px-3 text-13 bg-neutral-900 text-white rounded hover:bg-neutral-700 disabled:opacity-50">
                Next → review
              </button>
            ) : (
              <button type="button" disabled={create.isPending} onClick={() => create.mutate()}
                className="h-9 px-3 text-13 bg-neutral-900 text-white rounded hover:bg-neutral-700 disabled:opacity-50">
                {create.isPending ? 'Saving…' : 'Save adapter'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Step1({ marketplace, setMarketplace, reportKind, setReportKind, kinds, file, setFile }: {
  marketplace: string; setMarketplace: (k: string) => void;
  reportKind: string; setReportKind: (k: string) => void;
  kinds: Array<{ key: string; label: string }>;
  file: File | null; setFile: (f: File | null) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="text-11 text-neutral-500">
          Marketplace
          <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)}
            className="mt-1 h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white">
            <option value="">— pick —</option>
            {MARKETPLACES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </label>
        <label className="text-11 text-neutral-500">
          Report kind
          <select value={reportKind} onChange={(e) => setReportKind(e.target.value)}
            disabled={!marketplace}
            className="mt-1 h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white disabled:bg-neutral-50">
            <option value="">— pick —</option>
            {kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </label>
      </div>
      <label className="block text-11 text-neutral-500">
        Sample file (.xlsx / .csv / .tsv)
        <div className="mt-1 border-2 border-dashed border-neutral-300 rounded p-4 flex items-center gap-3">
          <UploadIcon size={16} className="text-neutral-400" />
          <input type="file" accept=".xlsx,.xls,.csv,.tsv,.txt"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-12 flex-1" />
          {file ? <span className="text-12 text-neutral-500">{(file.size / 1024).toFixed(1)} KB</span> : null}
        </div>
      </label>
      <div className="text-11 text-neutral-500 flex items-start gap-1.5">
        <Info size={11} className="mt-0.5" />
        <span>Use a real file from this marketplace with a few rows of data. Only the header row is used for fingerprinting; the first five data rows show up on the next step so you can see which column contains what.</span>
      </div>
    </div>
  );
}

function Step2({ preview, columnMap, setColumnMap }: {
  preview: AdapterPreviewResult;
  columnMap: Record<string, string>;
  setColumnMap: (m: Record<string, string>) => void;
}) {
  // Auto-suggest: for each standard field, if a header matches the common
  // names (case- and punctuation-insensitive) pre-fill the dropdown. The
  // staffer can override; this just saves clicks on the obvious ones.
  const suggestions = useMemo(() => autoSuggest(preview.headers), [preview.headers]);
  // Pre-fill the map once from suggestions, if not yet set.
  useMemo(() => {
    const next: Record<string, string> = { ...columnMap };
    let changed = false;
    for (const [k, v] of Object.entries(suggestions)) {
      if (!next[k] && v) { next[k] = v; changed = true; }
    }
    if (changed) setColumnMap(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.headers]);

  return (
    <div>
      <div className="mb-3 text-11 text-neutral-500 flex items-start gap-1.5">
        <Info size={11} className="mt-0.5" />
        <span>Starred fields are required — without them, the GSTR-1 builder cannot produce B2CL / B2CS tables. Common names auto-match; override anything that looks off.</span>
      </div>
      <div className="border border-neutral-200 rounded overflow-hidden">
        <table className="w-full text-13">
          <thead>
            <tr className="text-11 uppercase tracking-[0.06em] text-neutral-500 border-b border-neutral-200 bg-neutral-50">
              <th className="text-left px-3 h-8 font-medium w-[200px]">Standard field</th>
              <th className="text-left px-3 font-medium w-[260px]">Mapped to</th>
              <th className="text-left px-3 font-medium">Sample values</th>
            </tr>
          </thead>
          <tbody>
            {STANDARD_FIELDS.map((f) => {
              const chosen = columnMap[f.key] ?? '';
              const colIdx = preview.headers.indexOf(chosen);
              const samples = colIdx >= 0 ? preview.sample_rows.map((r) => r[colIdx] ?? '').filter((s) => s !== '').slice(0, 3) : [];
              return (
                <tr key={f.key} className="border-b border-neutral-100 align-top">
                  <td className="px-3 py-2 text-neutral-800">
                    {f.label}{f.required ? <span className="text-red ml-0.5">*</span> : null}
                    {f.hint ? <div className="text-11 text-neutral-500 mt-0.5">{f.hint}</div> : null}
                  </td>
                  <td className="px-3 py-2">
                    <select value={chosen}
                      onChange={(e) => {
                        const v = e.target.value;
                        const next = { ...columnMap };
                        if (v) next[f.key] = v; else delete next[f.key];
                        setColumnMap(next);
                      }}
                      className="h-8 w-full px-2 text-12 border border-neutral-300 rounded bg-white">
                      <option value="">— (not mapped) —</option>
                      {preview.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-11 text-neutral-500 font-mono">
                    {samples.length ? samples.join(' · ') : <span className="text-neutral-400">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Step3({ preview, columnMap, notes, setNotes }: {
  preview: AdapterPreviewResult;
  columnMap: Record<string, string>;
  notes: string;
  setNotes: (s: string) => void;
}) {
  const mappedCount = Object.keys(columnMap).length;
  const covers = computeCoverage(columnMap);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 text-13">
        <div><span className="text-neutral-500">Marketplace / report:</span> {preview.marketplace} · {preview.report_kind}</div>
        <div><span className="text-neutral-500">Headers detected:</span> {preview.headers.length}</div>
        <div><span className="text-neutral-500">Fields mapped:</span> {mappedCount} / {STANDARD_FIELDS.length}</div>
        <div><span className="text-neutral-500">Will produce:</span> {covers.length ? covers.join(', ') : '— none'}</div>
      </div>
      <label className="block text-11 text-neutral-500">
        Notes (optional)
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. seeded from the Dec 2025 sample · Amazon added TCS columns on Nov 2025"
          className="mt-1 w-full h-20 px-2 py-1.5 text-13 border border-neutral-300 rounded resize-none" />
      </label>
      <div className="text-11 text-neutral-500 flex items-start gap-1.5">
        <Check size={11} className="mt-0.5 text-success" />
        <span>Saving creates the next version (v2, v3, …). Older versions stay active until you retire them, so files already uploaded against the earlier format keep parsing.</span>
      </div>
    </div>
  );
}

/** Heuristic header matcher — common Amazon / Flipkart / Meesho header names.
 *  Case- and punctuation-insensitive. A miss here just means the staffer
 *  picks manually, so this errs on the side of fewer matches rather than
 *  wrong ones. */
function autoSuggest(headers: string[]): Record<string, string> {
  const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  const guesses: Record<string, string[]> = {
    invoice_number: ['invoicenumber', 'invoiceno', 'invno', 'invoiceid', 'orderid'],
    invoice_date: ['invoicedate', 'invdate', 'date', 'orderdate'],
    invoice_amount: ['invoiceamount', 'invamount', 'invoiceamt', 'invoicetotal', 'finalinvoiceamount', 'ordervalue'],
    taxable_value: ['taxexclusivegross', 'taxablevalue', 'taxableamount', 'taxableval'],
    cgst_tax: ['cgsttax', 'cgst', 'cgstamount'],
    sgst_tax: ['sgsttax', 'sgst', 'sgstamount'],
    igst_tax: ['igsttax', 'igst', 'igstamount'],
    cess_tax: ['compensatorycesstax', 'cesstax', 'cess'],
    cgst_rate: ['cgstrate', 'cgstpct'],
    sgst_rate: ['sgstrate', 'sgstpct'],
    igst_rate: ['igstrate', 'igstpct'],
    hsn: ['hsnsac', 'hsnsc', 'hsn', 'hsncode'],
    quantity: ['quantity', 'qty'],
    ship_to_state: ['shiptostate', 'shippingstate', 'customerstate', 'buyerstate'],
    seller_gstin: ['sellergstin', 'gstin', 'suppliergstin'],
    transaction_type: ['transactiontype', 'txntype', 'orderstatus'],
    credit_note_number: ['creditnoteno', 'creditnotenumber', 'cnno', 'creditnotenbr'],
    credit_note_date: ['creditnotedate', 'cndate'],
  };
  const out: Record<string, string> = {};
  for (const [field, candidates] of Object.entries(guesses)) {
    for (const c of candidates) {
      const hit = byNorm.get(c);
      if (hit) { out[field] = hit; break; }
    }
  }
  return out;
}

function computeCoverage(columnMap: Record<string, string>): string[] {
  const covers: string[] = [];
  const hasInvoice = Boolean(columnMap.invoice_amount && columnMap.taxable_value);
  const hasShipState = Boolean(columnMap.ship_to_state);
  if (hasInvoice && hasShipState) { covers.push('5A', '7'); }
  if (columnMap.credit_note_number) covers.push('9B');
  if (columnMap.hsn) covers.push('12');
  return covers;
}
