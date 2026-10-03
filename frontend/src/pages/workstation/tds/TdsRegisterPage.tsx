/**
 * TDS deductee register — Workstation → Services → TDS → Deductions & deductees.
 *
 * Where the TDS itself is worked out: each payment the client makes, to
 * whom, under which section, and the TDS on it. The server proposes the
 * TDS (rates, thresholds, no-PAN s. 206AA, 15G / 15H, Form 13 lower-deduction
 * certificates — backend/src/modules/tds/sections.ts) and keeps it beside
 * what was actually deducted, so short deduction shows on the row, the
 * month total feeds that month's challan, and the quarter exports as CSV
 * for the return software (KDK / Winman / ClearTDS).
 *
 * Scope comes from the URL (?client, ?fy, ?tan), as on every TDS screen.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Pencil, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { useToast } from '@/components/Toast';
import {
  tdsApi, type TdsBasis, type TdsDeclaration, type TdsDeduction, type TdsDeductee, type TdsLowerCertificate, type TdsPreview, type TdsRegister,
} from '@/modules/tds/api';
import { fyLabelForDate } from './config';
import { fmtDate, monthLabel, todayIso } from './status';

const btn = 'inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-neutral-700 border border-neutral-200 rounded-md hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed';
const primaryBtn = 'inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-white bg-primary hover:bg-primaryHover rounded-md disabled:opacity-50 disabled:cursor-not-allowed';
const inputCls = 'w-full h-9 px-3 text-13 bg-white border border-neutral-300 rounded-md focus:outline-none focus:border-gold';
const rupees = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);

type Tab = 'deductions' | 'deductees' | 'certificates' | 'declarations' | 'export';
const TABS: { key: Tab; label: string }[] = [
  { key: 'deductions', label: 'Deductions' },
  { key: 'deductees', label: 'Deductees' },
  { key: 'certificates', label: 'Lower-deduction certificates (Form 13)' },
  { key: 'declarations', label: '15G / 15H' },
  { key: 'export', label: 'Quarter export' },
];

const BASIS: Record<TdsBasis, { label: string; bg: string; fg: string }> = {
  normal:            { label: 'Normal rate', bg: '#EEF0F3', fg: '#475569' },
  no_pan:            { label: 'No PAN · 206AA', bg: '#FDE7EA', fg: '#B91C1C' },
  lower_certificate: { label: 'Form 13 cert.', bg: '#E2EAF5', fg: '#1A4B8C' },
  declaration:       { label: '15G / 15H', bg: '#E7F5EE', fg: '#166534' },
  below_threshold:   { label: 'Below threshold', bg: '#E7F5EE', fg: '#166534' },
  manual:            { label: 'Entered by hand', bg: '#FEF3C7', fg: '#B45309' },
};

function errText(e: unknown): string {
  const err = e as Error & { details?: Record<string, string> };
  const d = err.details && typeof err.details === 'object' ? Object.values(err.details).filter((v) => typeof v === 'string') : [];
  return d.length ? d.join('\n') : err.message;
}

export function TdsRegisterPage() {
  const [params] = useSearchParams();
  const clientId = params.get('client') ?? '';
  const fy = params.get('fy') ?? fyLabelForDate(new Date());
  const tan = params.get('tan') || null;
  const [tab, setTab] = useState<Tab>('deductions');
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'workstation.service.manage', 'self');

  const tdsQ = useQuery({ queryKey: ['tds', clientId, fy, tan ?? ''], queryFn: () => tdsApi.get(clientId, fy, tan), enabled: !!clientId });
  const regQ = useQuery({ queryKey: ['tds-register', clientId, fy, tan], queryFn: () => tdsApi.register(clientId, fy, tan), enabled: !!clientId });
  if (!clientId) return <Navigate to="/workstation/services/tds" replace />;
  const back = `/workstation/services/tds?${new URLSearchParams({ client: clientId, fy, ...(tan ? { tan } : {}) })}`;
  const reg = regQ.data;

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link to={back} className="inline-flex items-center gap-1 text-12 text-neutral-500 hover:text-neutral-900"><ArrowLeft size={14} /> TDS</Link>
          <h1 className="text-18 font-semibold text-neutral-900 mt-1">Deductions & deductees</h1>
          <div className="text-12 text-neutral-500">
            {tdsQ.data?.client.company_name ?? '…'} · FY {fy} · TAN <span className="font-mono">{reg?.active_tan ?? tdsQ.data?.active_tan ?? '—'}</span>
          </div>
        </div>
      </header>

      <div className="flex flex-wrap gap-1 bg-neutral-100 rounded-lg p-1 w-fit" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={'h-8 px-3 text-13 rounded-md ' + (tab === t.key ? 'bg-white text-neutral-900 font-medium shadow-sm' : 'text-neutral-600 hover:text-neutral-900')}>
            {t.label}
          </button>
        ))}
      </div>

      {regQ.isLoading ? <Panel><div className="text-13 text-neutral-500">Loading the register…</div></Panel>
        : regQ.isError ? <Panel><div className="text-13 text-danger">{(regQ.error as Error).message}</div></Panel>
        : reg ? (
          tab === 'deductions' ? <DeductionsTab clientId={clientId} tan={tan} reg={reg} canManage={canManage} onNeedDeductee={() => setTab('deductees')} />
          : tab === 'deductees' ? <DeducteesTab clientId={clientId} reg={reg} canManage={canManage} />
          : tab === 'certificates' ? <CertificatesTab clientId={clientId} reg={reg} canManage={canManage} />
          : tab === 'declarations' ? <DeclarationsTab clientId={clientId} reg={reg} canManage={canManage} fy={fy} />
          : <ExportTab clientId={clientId} reg={reg} fy={fy} tan={tan} />
        ) : null}

      <p className="text-11 text-neutral-500">
        Rates and thresholds follow the Finance Act, 2025 using the Income-tax Act, 1961 section numbers most return software still uses.
        From FY 2026-27 the Income-tax Act, 2025 renumbers these provisions; check any figure you rely on. The proposed TDS never overrides what you enter.
      </p>
    </div>
  );
}

function Panel({ children, title, right }: { children: React.ReactNode; title?: string; right?: React.ReactNode }) {
  return (
    <section className="bg-white border border-neutral-200 rounded-lg shadow-card p-4">
      {title || right ? <div className="flex items-center justify-between gap-2 mb-3 flex-wrap"><div className="text-14 font-medium text-neutral-900">{title}</div>{right}</div> : null}
      {children}
    </section>
  );
}

function Field({ label, children, hint, wide }: { label: string; children: React.ReactNode; hint?: React.ReactNode; wide?: boolean }) {
  return (
    <label className={'block' + (wide ? ' sm:col-span-2' : '')}>
      <span className="block text-11 text-neutral-500 mb-1">{label}</span>
      {children}
      {hint ? <span className="block text-11 text-neutral-500 mt-1">{hint}</span> : null}
    </label>
  );
}

function useSaver(clientId: string, kind: 'deductees' | 'lower-certificates' | 'declarations' | 'deductions', onDone: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['tds-register', clientId] }); void qc.invalidateQueries({ queryKey: ['tds', clientId] }); void qc.invalidateQueries({ queryKey: ['tds-overview'] }); };
  const save = useMutation({
    mutationFn: ({ input, id }: { input: Record<string, unknown>; id?: string }) => tdsApi.save(clientId, kind, input, id),
    onSuccess: () => { invalidate(); toast.push('success', 'Saved.'); onDone(); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => tdsApi.removeItem(clientId, kind, id),
    onSuccess: () => { invalidate(); toast.push('success', 'Deleted.'); onDone(); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  return { save, remove };
}

function FormActions({ pending, onCancel, onDelete, error }: { pending: boolean; onCancel: () => void; onDelete?: () => void; error: unknown }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      {error ? <div className="text-12 text-danger whitespace-pre-line sm:col-span-2">{errText(error)}</div> : null}
      <div className="flex items-center gap-2 flex-wrap sm:col-span-2">
        <button type="button" className={btn} onClick={onCancel} disabled={pending}>Cancel</button>
        <button type="submit" className={primaryBtn} disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>
        {onDelete ? (confirm
          ? <span className="ml-auto inline-flex items-center gap-2 text-12">Delete this?<button type="button" className={btn} onClick={() => setConfirm(false)}>No</button>
              <button type="button" onClick={onDelete} className="inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-white bg-danger hover:opacity-90 rounded-md"><Trash2 size={12} /> Delete</button></span>
          : <button type="button" className={btn + ' ml-auto'} onClick={() => setConfirm(true)}><Trash2 size={12} /> Delete</button>) : null}
      </div>
    </>
  );
}

// ── deductions ─────────────────────────────────────────────────────────────
function DeductionsTab({ clientId, tan, reg, canManage, onNeedDeductee }: { clientId: string; tan: string | null; reg: TdsRegister; canManage: boolean; onNeedDeductee: () => void }) {
  const [month, setMonth] = useState<string>('');
  const [editing, setEditing] = useState<TdsDeduction | 'new' | null>(null);
  const byId = useMemo(() => new Map(reg.deductees.map((d) => [d.id, d])), [reg.deductees]);
  const rows = reg.deductions.filter((d) => !month || d.month === month);
  const shortRows = reg.deductions.filter((d) => d.shortfall >= 1);

  return (
    <div className="space-y-4">
      <Panel title="Month by month" right={<span className="text-11 text-neutral-500">Deducted (register) against deposited (challan) — click a month to filter</span>}>
        <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
          {reg.months.map((m) => {
            const mismatch = m.difference !== null && Math.abs(m.difference) >= 1;
            const undeposited = m.deposited === null && m.deducted > 0 && todayIso() > `${m.month}-31`;
            return (
              <button key={m.month} type="button" onClick={() => setMonth(month === m.month ? '' : m.month)}
                className={'text-left rounded-md border p-2 ' + (month === m.month ? 'border-primary bg-neutral-50' : 'border-neutral-200 hover:bg-neutral-50')}>
                <div className="text-12 font-medium text-neutral-900">{monthLabel(m.month)}</div>
                <div className="text-11 text-neutral-500">Deducted {rupees(m.deducted)}</div>
                <div className={'text-11 ' + (mismatch || undeposited ? 'text-danger' : 'text-neutral-500')}>
                  {m.deposited === null ? (m.deducted > 0 ? 'No challan recorded' : 'Deposited —') : `Deposited ${rupees(m.deposited)}`}
                </div>
                {mismatch ? <div className="text-11 text-danger">{m.difference! < 0 ? 'Short' : 'Excess'} {rupees(Math.abs(m.difference!))}</div> : null}
              </button>
            );
          })}
        </div>
      </Panel>

      {shortRows.length ? (
        <div className="p-3 rounded-md border border-danger/40 bg-[#FDE7EA] text-12 text-[#B91C1C]">
          {shortRows.length} payment{shortRows.length === 1 ? '' : 's'} with short deduction — total {rupees(shortRows.reduce((s, d) => s + d.shortfall, 0))} less than the rules give.
          Short deduction attracts interest at 1% a month (s. 201(1A)) and can disallow the expense (s. 40(a)(ia)).
        </div>
      ) : null}

      <Panel
        title={month ? `Deductions · ${monthLabel(month)}` : 'All deductions this FY'}
        right={canManage ? (
          <button type="button" className={primaryBtn} onClick={() => (reg.deductees.length ? setEditing('new') : onNeedDeductee())}>
            <Plus size={12} /> {reg.deductees.length ? 'Record payment' : 'Add a deductee first'}
          </button>
        ) : null}
      >
        {editing === 'new' ? <div className="mb-3"><DeductionForm clientId={clientId} tan={tan} reg={reg} row={null} onClose={() => setEditing(null)} /></div> : null}
        {rows.length === 0 ? (
          <div className="text-13 text-neutral-500">{reg.deductees.length ? 'No payments recorded here yet.' : 'Add the client’s payees under Deductees, then record each payment here.'}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="hr-float w-full min-w-[860px] text-13">
              <thead>
                <tr className="text-11 uppercase tracking-[0.06em] text-neutral-500 border-b border-neutral-100">
                  <th className="text-left font-medium py-2 pr-3">Date</th><th className="text-left font-medium py-2 pr-3">Deductee</th>
                  <th className="text-left font-medium py-2 pr-3">Section</th><th className="text-right font-medium py-2 pr-3">Paid</th>
                  <th className="text-right font-medium py-2 pr-3">Rate</th><th className="text-right font-medium py-2 pr-3">TDS</th>
                  <th className="text-right font-medium py-2 pr-3">Rules give</th><th className="text-left font-medium py-2 pr-3">Basis</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const who = byId.get(d.deductee_id);
                  const b = BASIS[d.basis];
                  return (
                    <FragmentRow key={d.id}>
                      <tr className="border-b border-neutral-100">
                        <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(d.deduction_date)}</td>
                        <td className="py-2 pr-3"><div className="font-medium text-neutral-900">{who?.name ?? '—'}</div><div className="text-11 text-neutral-500 font-mono">{who?.pan ?? 'No PAN'}</div></td>
                        <td className="py-2 pr-3 font-mono">{d.section}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{rupees(d.amount_paid)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{d.rate_pct === null ? '—' : `${d.rate_pct}%`}</td>
                        <td className="py-2 pr-3 text-right tabular-nums font-medium">{rupees(d.tds_amount)}</td>
                        <td className={'py-2 pr-3 text-right tabular-nums ' + (d.shortfall >= 1 ? 'text-danger' : d.shortfall <= -1 ? 'text-[#B45309]' : 'text-neutral-500')}>
                          {rupees(d.expected_tds)}{d.shortfall >= 1 ? <div className="text-11">short {rupees(d.shortfall)}</div> : d.shortfall <= -1 ? <div className="text-11">excess {rupees(-d.shortfall)}</div> : null}
                        </td>
                        <td className="py-2 pr-3"><span className="inline-flex items-center h-6 px-2 text-11 rounded-md whitespace-nowrap" style={{ backgroundColor: b.bg, color: b.fg }}>{b.label}</span></td>
                        <td className="py-2 text-right">{canManage ? <button type="button" className={btn} onClick={() => setEditing(d)}><Pencil size={12} /> Edit</button> : null}</td>
                      </tr>
                      {editing !== 'new' && editing?.id === d.id ? <tr><td colSpan={9} className="py-2"><DeductionForm clientId={clientId} tan={tan} reg={reg} row={d} onClose={() => setEditing(null)} /></td></tr> : null}
                    </FragmentRow>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) { return <>{children}</>; }

function DeductionForm({ clientId, tan, reg, row, onClose }: { clientId: string; tan: string | null; reg: TdsRegister; row: TdsDeduction | null; onClose: () => void }) {
  const today = todayIso();
  const [v, setV] = useState({
    deductee_id: row?.deductee_id ?? '', section: row?.section ?? '', payment_date: row?.payment_date ?? today,
    deduction_date: row?.deduction_date ?? today, amount_paid: row ? String(row.amount_paid) : '', tds_amount: row ? String(row.tds_amount) : '',
    invoice_ref: row?.invoice_ref ?? '', notes: row?.notes ?? '',
  });
  const [tdsTouched, setTdsTouched] = useState(!!row);
  const [preview, setPreview] = useState<TdsPreview | null>(null);
  const { save, remove } = useSaver(clientId, 'deductions', onClose);
  const amount = Number(v.amount_paid);

  // Live proposal from the server's rules — debounced as the firm types.
  useEffect(() => {
    if (!v.deductee_id || !v.section || !v.deduction_date || !(amount > 0)) { setPreview(null); return; }
    const t = setTimeout(() => {
      tdsApi.preview(clientId, { deductee_id: v.deductee_id, section: v.section, deduction_date: v.deduction_date, amount_paid: amount, except_id: row?.id })
        .then((p) => { setPreview(p); if (!tdsTouched && p.expected_tds !== null) setV((s) => ({ ...s, tds_amount: String(p.expected_tds) })); })
        .catch(() => setPreview(null));
    }, 300);
    return () => clearTimeout(t);
  }, [clientId, v.deductee_id, v.section, v.deduction_date, amount, row?.id, tdsTouched]);

  const set = (k: keyof typeof v) => (x: string) => setV((s) => ({ ...s, [k]: x }));
  const submit = () => save.mutate({
    id: row?.id,
    input: {
      ...(row ? {} : { for_tan: tan }), deductee_id: v.deductee_id, section: v.section, payment_date: v.payment_date,
      deduction_date: v.deduction_date, amount_paid: v.amount_paid, tds_amount: v.tds_amount === '' ? null : v.tds_amount,
      invoice_ref: v.invoice_ref || null, notes: v.notes || null,
    },
  });
  const tds = Number(v.tds_amount);
  const short = preview?.expected_tds !== null && preview?.expected_tds !== undefined && v.tds_amount !== '' && tds < preview.expected_tds - 0.5;

  return (
    <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 p-3 border border-neutral-200 rounded-md bg-neutral-50" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <Field label="Deductee *">
        <select className={inputCls} value={v.deductee_id} onChange={(e) => set('deductee_id')(e.target.value)} required>
          <option value="">— Select —</option>
          {reg.deductees.map((d) => <option key={d.id} value={d.id}>{d.name}{d.pan ? ` · ${d.pan}` : ' · no PAN'}</option>)}
        </select>
      </Field>
      <Field label="Section *">
        <select className={inputCls} value={v.section} onChange={(e) => set('section')(e.target.value)} required>
          <option value="">— Select —</option>
          {reg.sections.map((s) => <option key={s.code} value={s.code}>{s.code} — {s.label}</option>)}
        </select>
      </Field>
      <Field label="Amount paid / credited (₹) *"><input className={inputCls} type="number" min={0} step="0.01" value={v.amount_paid} onChange={(e) => set('amount_paid')(e.target.value)} required /></Field>
      <Field label="Invoice / bill ref"><input className={inputCls} value={v.invoice_ref} onChange={(e) => set('invoice_ref')(e.target.value)} /></Field>
      <Field label="Payment / credit date *"><input className={inputCls} type="date" max={today} value={v.payment_date} onChange={(e) => { set('payment_date')(e.target.value); if (!row && v.deduction_date === v.payment_date) set('deduction_date')(e.target.value); }} required /></Field>
      <Field label="Deduction date *" hint="Usually the earlier of credit and payment"><input className={inputCls} type="date" max={today} value={v.deduction_date} onChange={(e) => set('deduction_date')(e.target.value)} required /></Field>
      <Field label="TDS deducted (₹)" hint={preview?.expected_tds === null ? 'Enter the TDS — this section is computed case by case' : 'Filled with the rules’ figure; change it if you deducted something else'}>
        <input className={inputCls + (short ? ' border-danger' : '')} type="number" min={0} step="0.01" value={v.tds_amount} onChange={(e) => { setTdsTouched(true); set('tds_amount')(e.target.value); }} />
      </Field>
      <div className="text-12 rounded-md border border-neutral-200 bg-white p-2 self-end">
        {!preview ? <span className="text-neutral-500">Choose deductee, section and amount to see the TDS the rules give.</span> : (
          <>
            <div className="text-neutral-900">Rules give <span className="font-semibold">{preview.expected_tds === null ? '—' : rupees(preview.expected_tds)}</span>{preview.rate !== null ? ` at ${preview.rate}%` : ''}</div>
            <div className="text-neutral-500">{preview.note} Goes in {preview.return_form}.</div>
            {short ? <div className="text-danger">Short deduction of {rupees(preview.expected_tds! - tds)}.</div> : null}
            {tdsTouched && preview.expected_tds !== null && Number(v.tds_amount) !== preview.expected_tds
              ? <button type="button" className="text-11 underline text-primary" onClick={() => { setTdsTouched(false); set('tds_amount')(String(preview.expected_tds)); }}>Use {rupees(preview.expected_tds)}</button> : null}
          </>
        )}
      </div>
      <Field label="Notes" wide><input className={inputCls} value={v.notes} onChange={(e) => set('notes')(e.target.value)} /></Field>
      <FormActions pending={save.isPending || remove.isPending} error={save.error} onCancel={onClose} onDelete={row ? () => remove.mutate(row.id) : undefined} />
    </form>
  );
}

// ── deductees ──────────────────────────────────────────────────────────────
function DeducteesTab({ clientId, reg, canManage }: { clientId: string; reg: TdsRegister; canManage: boolean }) {
  const [editing, setEditing] = useState<TdsDeductee | 'new' | null>(null);
  const used = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of reg.deductions) m.set(d.deductee_id, (m.get(d.deductee_id) ?? 0) + d.tds_amount);
    return m;
  }, [reg.deductions]);
  return (
    <Panel title={`Deductees (${reg.deductees.length})`} right={canManage ? <button type="button" className={primaryBtn} onClick={() => setEditing('new')}><Plus size={12} /> Add deductee</button> : null}>
      {editing === 'new' ? <div className="mb-3"><DeducteeForm clientId={clientId} row={null} onClose={() => setEditing(null)} /></div> : null}
      {reg.deductees.length === 0 ? <div className="text-13 text-neutral-500">No deductees yet — add the contractors, professionals, landlords and others the client pays.</div> : (
        <div className="overflow-x-auto">
          <table className="hr-float w-full min-w-[640px] text-13">
            <thead><tr className="text-11 uppercase tracking-[0.06em] text-neutral-500 border-b border-neutral-100">
              <th className="text-left font-medium py-2 pr-3">Name</th><th className="text-left font-medium py-2 pr-3">PAN</th><th className="text-left font-medium py-2 pr-3">Type</th>
              <th className="text-left font-medium py-2 pr-3">Residency</th><th className="text-right font-medium py-2 pr-3">TDS this FY</th><th />
            </tr></thead>
            <tbody>
              {reg.deductees.map((d) => (
                <FragmentRow key={d.id}>
                  <tr className="border-b border-neutral-100">
                    <td className="py-2 pr-3 font-medium text-neutral-900">{d.name}</td>
                    <td className="py-2 pr-3 font-mono">{d.pan ?? <span className="text-danger">No PAN — 20% applies</span>}</td>
                    <td className="py-2 pr-3">{d.category === 'individual_huf' ? 'Individual / HUF' : 'Company / firm / other'}</td>
                    <td className="py-2 pr-3">{d.residency === 'non_resident' ? 'Non-resident (27Q)' : 'Resident'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{rupees(used.get(d.id) ?? 0)}</td>
                    <td className="py-2 text-right">{canManage ? <button type="button" className={btn} onClick={() => setEditing(d)}><Pencil size={12} /> Edit</button> : null}</td>
                  </tr>
                  {editing !== 'new' && editing?.id === d.id ? <tr><td colSpan={6} className="py-2"><DeducteeForm clientId={clientId} row={d} onClose={() => setEditing(null)} /></td></tr> : null}
                </FragmentRow>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function DeducteeForm({ clientId, row, onClose }: { clientId: string; row: TdsDeductee | null; onClose: () => void }) {
  const [v, setV] = useState({ name: row?.name ?? '', pan: row?.pan ?? '', category: row?.category ?? 'other', residency: row?.residency ?? 'resident', email: row?.email ?? '', notes: row?.notes ?? '' });
  const { save, remove } = useSaver(clientId, 'deductees', onClose);
  const set = (k: keyof typeof v) => (x: string) => setV((s) => ({ ...s, [k]: x }));
  return (
    <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 p-3 border border-neutral-200 rounded-md bg-neutral-50"
      onSubmit={(e) => { e.preventDefault(); save.mutate({ id: row?.id, input: { ...v, pan: v.pan.trim() || null, email: v.email || null, notes: v.notes || null } }); }}>
      <Field label="Name *"><input className={inputCls} value={v.name} onChange={(e) => set('name')(e.target.value)} required /></Field>
      <Field label="PAN" hint="Without a PAN, TDS is at least 20% (s. 206AA)"><input className={inputCls + ' font-mono'} value={v.pan} maxLength={10} onChange={(e) => set('pan')(e.target.value.toUpperCase())} placeholder="ABCDE1234F" /></Field>
      <Field label="Type *" hint="Decides the 194C / 194D rate">
        <select className={inputCls} value={v.category} onChange={(e) => set('category')(e.target.value)}>
          <option value="individual_huf">Individual / HUF</option><option value="other">Company / firm / other</option>
        </select>
      </Field>
      <Field label="Residency">
        <select className={inputCls} value={v.residency} onChange={(e) => set('residency')(e.target.value)}>
          <option value="resident">Resident (24Q / 26Q)</option><option value="non_resident">Non-resident (27Q)</option>
        </select>
      </Field>
      <Field label="Email (for certificates)"><input className={inputCls} type="email" value={v.email} onChange={(e) => set('email')(e.target.value)} /></Field>
      <Field label="Notes"><input className={inputCls} value={v.notes} onChange={(e) => set('notes')(e.target.value)} /></Field>
      <FormActions pending={save.isPending || remove.isPending} error={save.error ?? remove.error} onCancel={onClose} onDelete={row ? () => remove.mutate(row.id) : undefined} />
    </form>
  );
}

// ── Form 13 certificates ───────────────────────────────────────────────────
function CertificatesTab({ clientId, reg, canManage }: { clientId: string; reg: TdsRegister; canManage: boolean }) {
  const [editing, setEditing] = useState<TdsLowerCertificate | 'new' | null>(null);
  const name = (id: string) => reg.deductees.find((d) => d.id === id)?.name ?? '—';
  const today = todayIso();
  return (
    <Panel title="Lower / nil deduction certificates" right={canManage && reg.deductees.length ? <button type="button" className={primaryBtn} onClick={() => setEditing('new')}><Plus size={12} /> Add certificate</button> : null}>
      <p className="text-12 text-neutral-500 mb-3">A deductee’s certificate from the Assessing Officer (Form 13, s. 197). Within its dates and limit, payments under its section use its rate automatically.</p>
      {editing === 'new' ? <div className="mb-3"><CertificateForm clientId={clientId} reg={reg} row={null} onClose={() => setEditing(null)} /></div> : null}
      {reg.lower_certificates.length === 0 ? <div className="text-13 text-neutral-500">No certificates on file.</div> : (
        <table className="hr-float w-full text-13">
          <thead><tr className="text-11 uppercase tracking-[0.06em] text-neutral-500 border-b border-neutral-100">
            <th className="text-left font-medium py-2 pr-3">Deductee</th><th className="text-left font-medium py-2 pr-3">Certificate</th><th className="text-left font-medium py-2 pr-3">Section · rate</th>
            <th className="text-left font-medium py-2 pr-3">Valid</th><th className="text-right font-medium py-2 pr-3">Limit</th><th />
          </tr></thead>
          <tbody>
            {reg.lower_certificates.map((c) => (
              <FragmentRow key={c.id}>
                <tr className="border-b border-neutral-100">
                  <td className="py-2 pr-3">{name(c.deductee_id)}</td><td className="py-2 pr-3 font-mono">{c.certificate_no}</td>
                  <td className="py-2 pr-3">{c.section} · {c.rate}%</td>
                  <td className={'py-2 pr-3 ' + (c.valid_to < today ? 'text-neutral-400' : '')}>{fmtDate(c.valid_from)} – {fmtDate(c.valid_to)}{c.valid_to < today ? ' (expired)' : ''}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{c.amount_limit === null ? 'No limit' : rupees(c.amount_limit)}</td>
                  <td className="py-2 text-right">{canManage ? <button type="button" className={btn} onClick={() => setEditing(c)}><Pencil size={12} /> Edit</button> : null}</td>
                </tr>
                {editing !== 'new' && editing?.id === c.id ? <tr><td colSpan={6} className="py-2"><CertificateForm clientId={clientId} reg={reg} row={c} onClose={() => setEditing(null)} /></td></tr> : null}
              </FragmentRow>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function CertificateForm({ clientId, reg, row, onClose }: { clientId: string; reg: TdsRegister; row: TdsLowerCertificate | null; onClose: () => void }) {
  const [v, setV] = useState({
    deductee_id: row?.deductee_id ?? '', certificate_no: row?.certificate_no ?? '', section: row?.section ?? '', rate: row ? String(row.rate) : '',
    valid_from: row?.valid_from ?? '', valid_to: row?.valid_to ?? '', amount_limit: row?.amount_limit === null || row?.amount_limit === undefined ? '' : String(row.amount_limit),
  });
  const { save, remove } = useSaver(clientId, 'lower-certificates', onClose);
  const set = (k: keyof typeof v) => (x: string) => setV((s) => ({ ...s, [k]: x }));
  return (
    <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 p-3 border border-neutral-200 rounded-md bg-neutral-50"
      onSubmit={(e) => { e.preventDefault(); save.mutate({ id: row?.id, input: { ...v, amount_limit: v.amount_limit === '' ? null : v.amount_limit } }); }}>
      <Field label="Deductee *"><select className={inputCls} value={v.deductee_id} onChange={(e) => set('deductee_id')(e.target.value)} required>
        <option value="">— Select —</option>{reg.deductees.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
      <Field label="Certificate number *"><input className={inputCls + ' font-mono'} value={v.certificate_no} onChange={(e) => set('certificate_no')(e.target.value.toUpperCase())} required /></Field>
      <Field label="Section *"><select className={inputCls} value={v.section} onChange={(e) => set('section')(e.target.value)} required>
        <option value="">— Select —</option>{reg.sections.map((s) => <option key={s.code} value={s.code}>{s.code} — {s.label}</option>)}</select></Field>
      <Field label="Rate allowed (%) *"><input className={inputCls} type="number" min={0} max={100} step="0.01" value={v.rate} onChange={(e) => set('rate')(e.target.value)} required /></Field>
      <Field label="Valid from *"><input className={inputCls} type="date" value={v.valid_from} onChange={(e) => set('valid_from')(e.target.value)} required /></Field>
      <Field label="Valid to *"><input className={inputCls} type="date" value={v.valid_to} onChange={(e) => set('valid_to')(e.target.value)} required /></Field>
      <Field label="Amount limit (₹)" hint="Leave blank if the certificate states none"><input className={inputCls} type="number" min={0} step="0.01" value={v.amount_limit} onChange={(e) => set('amount_limit')(e.target.value)} /></Field>
      <FormActions pending={save.isPending || remove.isPending} error={save.error} onCancel={onClose} onDelete={row ? () => remove.mutate(row.id) : undefined} />
    </form>
  );
}

// ── 15G / 15H ──────────────────────────────────────────────────────────────
function DeclarationsTab({ clientId, reg, canManage, fy }: { clientId: string; reg: TdsRegister; canManage: boolean; fy: string }) {
  const [editing, setEditing] = useState<TdsDeclaration | 'new' | null>(null);
  const name = (id: string) => reg.deductees.find((d) => d.id === id)?.name ?? '—';
  const list = reg.declarations.filter((d) => d.fy === fy);
  return (
    <Panel title={`15G / 15H declarations · FY ${fy}`} right={canManage && reg.deductees.length ? <button type="button" className={primaryBtn} onClick={() => setEditing('new')}><Plus size={12} /> Add declaration</button> : null}>
      <p className="text-12 text-neutral-500 mb-3">
        With a 15G (under 60) or 15H (60 and over) on file for the FY, interest and dividend payments (193, 194, 194A) to that deductee need no TDS.
        Remember to upload them on the e-Filing portal each quarter and quote the UIN.
      </p>
      {editing === 'new' ? <div className="mb-3"><DeclarationForm clientId={clientId} reg={reg} row={null} fy={fy} onClose={() => setEditing(null)} /></div> : null}
      {list.length === 0 ? <div className="text-13 text-neutral-500">No declarations for this FY.</div> : (
        <table className="hr-float w-full text-13">
          <thead><tr className="text-11 uppercase tracking-[0.06em] text-neutral-500 border-b border-neutral-100">
            <th className="text-left font-medium py-2 pr-3">Deductee</th><th className="text-left font-medium py-2 pr-3">Form</th><th className="text-left font-medium py-2 pr-3">Received</th>
            <th className="text-right font-medium py-2 pr-3">Estimated income</th><th className="text-left font-medium py-2 pr-3">UIN</th><th />
          </tr></thead>
          <tbody>
            {list.map((d) => (
              <FragmentRow key={d.id}>
                <tr className="border-b border-neutral-100">
                  <td className="py-2 pr-3">{name(d.deductee_id)}</td><td className="py-2 pr-3">{d.form}</td><td className="py-2 pr-3">{fmtDate(d.received_on)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{rupees(d.estimated_income)}</td><td className="py-2 pr-3 font-mono">{d.uin ?? '—'}</td>
                  <td className="py-2 text-right">{canManage ? <button type="button" className={btn} onClick={() => setEditing(d)}><Pencil size={12} /> Edit</button> : null}</td>
                </tr>
                {editing !== 'new' && editing?.id === d.id ? <tr><td colSpan={6} className="py-2"><DeclarationForm clientId={clientId} reg={reg} row={d} fy={fy} onClose={() => setEditing(null)} /></td></tr> : null}
              </FragmentRow>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function DeclarationForm({ clientId, reg, row, fy, onClose }: { clientId: string; reg: TdsRegister; row: TdsDeclaration | null; fy: string; onClose: () => void }) {
  const [v, setV] = useState({
    deductee_id: row?.deductee_id ?? '', fy: row?.fy ?? fy, form: row?.form ?? '15G', received_on: row?.received_on ?? todayIso(),
    estimated_income: row?.estimated_income === null || row?.estimated_income === undefined ? '' : String(row.estimated_income), uin: row?.uin ?? '',
  });
  const { save, remove } = useSaver(clientId, 'declarations', onClose);
  const set = (k: keyof typeof v) => (x: string) => setV((s) => ({ ...s, [k]: x }));
  return (
    <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 p-3 border border-neutral-200 rounded-md bg-neutral-50"
      onSubmit={(e) => { e.preventDefault(); save.mutate({ id: row?.id, input: { ...v, estimated_income: v.estimated_income === '' ? null : v.estimated_income, uin: v.uin || null } }); }}>
      <Field label="Deductee *"><select className={inputCls} value={v.deductee_id} onChange={(e) => set('deductee_id')(e.target.value)} required>
        <option value="">— Select —</option>{reg.deductees.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
      <Field label="Form *"><select className={inputCls} value={v.form} onChange={(e) => set('form')(e.target.value)}>
        <option value="15G">15G — under 60</option><option value="15H">15H — 60 and over</option></select></Field>
      <Field label="Received on *"><input className={inputCls} type="date" max={todayIso()} value={v.received_on} onChange={(e) => set('received_on')(e.target.value)} required /></Field>
      <Field label="Estimated income (₹)"><input className={inputCls} type="number" min={0} step="0.01" value={v.estimated_income} onChange={(e) => set('estimated_income')(e.target.value)} /></Field>
      <Field label="UIN" hint="Allotted when you upload the declaration"><input className={inputCls + ' font-mono'} value={v.uin} onChange={(e) => set('uin')(e.target.value.toUpperCase())} /></Field>
      <FormActions pending={save.isPending || remove.isPending} error={save.error} onCancel={onClose} onDelete={row ? () => remove.mutate(row.id) : undefined} />
    </form>
  );
}

// ── export ─────────────────────────────────────────────────────────────────
function ExportTab({ clientId, reg, fy, tan }: { clientId: string; reg: TdsRegister; fy: string; tan: string | null }) {
  const [quarter, setQuarter] = useState('Q1');
  const [form, setForm] = useState('26Q');
  const qMonths = reg.months.slice(['Q1', 'Q2', 'Q3', 'Q4'].indexOf(quarter) * 3, ['Q1', 'Q2', 'Q3', 'Q4'].indexOf(quarter) * 3 + 3);
  const count = reg.deductions.filter((d) => qMonths.some((m) => m.month === d.month)).length;
  const undeposited = qMonths.filter((m) => m.deducted > 0 && m.deposited === null);
  return (
    <Panel title="Quarter export for the return software">
      <p className="text-12 text-neutral-500 mb-3">
        One CSV row per deduction, with PAN, section, dates, amounts, remark codes (A lower-deduction certificate · B 15G/15H · C no PAN) and the matching challan (BSR, date, serial).
        Import it into KDK Spectrum, Winman or ClearTDS to prepare the .fvu file, then record the filed return under TDS Return Filing.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Quarter"><select className={inputCls} value={quarter} onChange={(e) => setQuarter(e.target.value)}>
          {['Q1', 'Q2', 'Q3', 'Q4'].map((q) => <option key={q} value={q}>{q}</option>)}</select></Field>
        <Field label="Return"><select className={inputCls} value={form} onChange={(e) => setForm(e.target.value)}>
          <option value="26Q">26Q — residents, non-salary</option><option value="24Q">24Q — salary</option><option value="27Q">27Q — non-residents</option></select></Field>
        <a className={primaryBtn + ' h-9'} href={tdsApi.exportUrl(clientId, { fy, quarter, form, tan })} download><Download size={14} /> Download CSV</a>
        <span className="text-12 text-neutral-500">{count} deduction{count === 1 ? '' : 's'} in {quarter} (all forms)</span>
      </div>
      {undeposited.length ? (
        <div className="mt-3 text-12 text-danger">
          No challan recorded yet for {undeposited.map((m) => monthLabel(m.month)).join(', ')} — record the deposits under Challan Payment so the export can quote them.
        </div>
      ) : null}
    </Panel>
  );
}
