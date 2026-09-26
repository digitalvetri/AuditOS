/**
 * "Record back after filing" — the persisted half of each TDS sub-service.
 *
 * Every sub-service shows what is expected for the FY (from status.ts —
 * statutory calendar × what is already recorded) and lets the firm record,
 * edit or delete the evidence: challan serial + BSR, return token, new
 * correction token, certificate issue, notice checks and defaults.
 * Registration also holds the client's TDS profile (return forms, deductor
 * type, responsible person) and writes the allotted TAN onto the client.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Paperclip, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { useToast } from '@/components/Toast';
import {
  PROFILE_TEXT_KEYS, RETURN_FORMS, tdsApi,
  type ProfileTextKey, type TdsData, type TdsKind, type TdsRecord, type TdsRecordInput,
} from '@/modules/tds/api';
import { FORM_49B_LIMITS } from './config';
import type { TdsSubServiceSlug } from './services';
import {
  challanInterest, expectedCertificates, expectedChallans, expectedReturns, fmtDate, lastNoticeCheck,
  lateFee234E, monthLabel, QUARTERS, todayIso, type ExpectedItem,
} from './status';

const btn = 'inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-neutral-700 border border-neutral-200 rounded-md hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed';
const primaryBtn = 'inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-white bg-primary hover:bg-primaryHover rounded-md disabled:opacity-50 disabled:cursor-not-allowed';
const inputCls = 'w-full h-9 px-3 text-13 bg-white border border-neutral-300 rounded-md focus:outline-none focus:border-gold';

type FieldType = 'text' | 'date' | 'month' | 'money' | 'select' | 'textarea';
interface FieldSpec {
  key: keyof TdsRecordInput;
  label: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  hint?: string;
  /** Required when the record is marked done (the evidence gate). */
  required?: boolean;
  /** Fixed by the row the form was opened from. */
  locked?: boolean;
}

const STATUS_OPTIONS = {
  work: [{ value: 'done', label: 'Filed' }, { value: 'in_progress', label: 'In progress' }],
  paid: [{ value: 'done', label: 'Paid' }, { value: 'in_progress', label: 'In progress' }],
  issued: [{ value: 'done', label: 'Issued' }, { value: 'in_progress', label: 'In progress' }],
  notice: [{ value: 'pending', label: 'Open' }, { value: 'in_progress', label: 'Responding' }, { value: 'done', label: 'Closed' }],
};

const SLUG_KIND: Record<TdsSubServiceSlug, TdsKind> = {
  'registration': 'registration',
  'challan-payment': 'challan',
  'return-filing': 'return',
  'correction-filing': 'correction',
  'form-16': 'certificate',
  'notices': 'notice',
};

function fieldsFor(kind: TdsKind, data: TdsData, fy: string): FieldSpec[] {
  switch (kind) {
    case 'registration':
      return [
        { key: 'reference', label: '14-digit acknowledgement number', type: 'text', required: true, hint: 'Form 49B ack' },
        { key: 'event_date', label: 'Submission date', type: 'date', required: true },
        { key: 'amount_fee', label: 'Fee paid (₹)', type: 'money' },
        { key: 'tan', label: 'TAN (once allotted)', type: 'text', hint: '4 letters, 5 digits, 1 letter — saved on the client' },
        { key: 'notes', label: 'Notes', type: 'textarea' },
      ];
    case 'challan':
      return [
        { key: 'period', label: 'Deduction month', type: 'month', required: true, locked: true },
        { key: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS.paid },
        { key: 'bsr_code', label: 'BSR code', type: 'text', required: true, hint: '7 digits' },
        { key: 'event_date', label: 'Deposit date', type: 'date', required: true },
        { key: 'reference', label: 'Challan serial number', type: 'text', required: true },
        { key: 'amount_tax', label: 'Tax (₹)', type: 'money', required: true, hint: 'Enter 0 for a nil month' },
        { key: 'amount_interest', label: 'Interest (₹)', type: 'money' },
        { key: 'amount_fee', label: 'Fee (₹)', type: 'money' },
        { key: 'notes', label: 'Notes', type: 'textarea' },
      ];
    case 'return':
      return [
        { key: 'form_type', label: 'Form', type: 'select', locked: true, options: data.profile.return_forms.map((f) => ({ value: f, label: f })) },
        { key: 'period', label: 'Quarter', type: 'select', locked: true, options: QUARTERS.map((q) => ({ value: q, label: q })) },
        { key: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS.work },
        { key: 'reference', label: 'Token number', type: 'text', required: true, hint: '15 digits, from the provisional receipt' },
        { key: 'event_date', label: 'Filing date', type: 'date', required: true },
        { key: 'filed_by', label: 'Filed by', type: 'text' },
        { key: 'notes', label: 'Notes', type: 'textarea' },
      ];
    case 'correction': {
      const originals = data.records.filter((r) => r.kind === 'return' && r.status === 'done' && r.fy === fy);
      return [
        {
          key: 'original_id', label: 'Original return', type: 'select', locked: true,
          options: originals.map((r) => ({ value: r.id, label: `${r.form_type} · ${r.period} · token ${r.reference}` })),
        },
        { key: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS.work },
        { key: 'reference', label: 'New token number', type: 'text', required: true, hint: '15 digits — the original stays untouched' },
        { key: 'event_date', label: 'Filing date', type: 'date', required: true },
        { key: 'notes', label: 'Correction type / what changed', type: 'textarea' },
      ];
    }
    case 'certificate':
      return [
        { key: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS.issued },
        { key: 'event_date', label: 'Issue date', type: 'date', required: true },
        { key: 'notes', label: 'Issuance register', type: 'textarea', hint: 'Which deductee got which certificate, when, how' },
      ];
    case 'notice':
      return [
        { key: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS.notice },
        { key: 'reference', label: 'Notice / default reference', type: 'text' },
        { key: 'event_date', label: 'Notice date', type: 'date' },
        { key: 'amount_tax', label: 'Demand (₹)', type: 'money' },
        { key: 'notes', label: 'Default summary', type: 'textarea', hint: 'Short deduction, short payment, late filing fee (234E), interest…' },
      ];
    default:
      return [];
  }
}

type FormState = { recordId: string | null; values: Record<string, string> };

function toValues(r: TdsRecord | null, preset: TdsRecordInput): Record<string, string> {
  const src: Record<string, unknown> = { ...(r ?? {}), ...preset };
  return Object.fromEntries(Object.entries(src).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]));
}

export function TdsRecordsPanel({ slug, data, fy }: { slug: TdsSubServiceSlug; data: TdsData; fy: string }) {
  const kind = SLUG_KIND[slug];
  const qc = useQueryClient();
  const toast = useToast();
  const clientId = data.client.id;
  const { session } = useAuth();
  // Mirrors the server: recording needs workstation.service.manage (any scope — the server applies client scope).
  const canManage = can(session?.role.code, 'workstation.service.manage', 'self');
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['tds', clientId] });

  const save = useMutation({
    mutationFn: async (f: FormState) => {
      const specs = fieldsFor(kind, data, fy);
      const input: Record<string, unknown> = {};
      for (const s of specs) {
        if (s.locked && f.recordId) continue; // period / form / original are fixed once recorded
        const v = (f.values[s.key] ?? '').trim();
        input[s.key] = v === '' ? null : s.key === 'tan' ? v.toUpperCase() : v;
      }
      if (f.recordId) return tdsApi.update(clientId, f.recordId, input as TdsRecordInput);
      return tdsApi.create(clientId, {
        kind, fy: kind === 'registration' || kind === 'notice' ? null : fy,
        for_tan: data.active_tan,
        status: kind === 'notice' ? 'pending' : 'done',
        ...Object.fromEntries(Object.entries(f.values).filter(([k]) => ['period', 'form_type'].includes(k))),
        ...input,
      } as TdsRecordInput);
    },
    onSuccess: () => { setForm(null); setError(null); invalidate(); toast.push('success', 'Saved.'); },
    onError: (e: Error & { details?: unknown }) => setError(fieldErrorText(e)),
  });

  const del = useMutation({
    mutationFn: (id: string) => tdsApi.remove(clientId, id),
    onSuccess: () => { setForm(null); invalidate(); toast.push('success', 'Record deleted.'); },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const markChecked = useMutation({
    mutationFn: () => tdsApi.create(clientId, { kind: 'notice_check', fy: null, event_date: todayIso(), status: 'done', for_tan: data.active_tan }),
    onSuccess: () => { invalidate(); toast.push('success', 'Notice check recorded for today.'); },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const open = (record: TdsRecord | null, preset: TdsRecordInput = {}) => {
    setError(null);
    setForm({ recordId: record?.id ?? null, values: toValues(record, preset) });
  };

  const formEl = form ? (
    <RecordForm
      specs={fieldsFor(kind, data, fy)}
      state={form}
      editing={!!form.recordId}
      error={error}
      pending={save.isPending}
      onChange={(values) => setForm({ ...form, values })}
      onCancel={() => { setForm(null); setError(null); }}
      onSubmit={() => save.mutate(form)}
      onDelete={form.recordId ? () => del.mutate(form.recordId!) : undefined}
    />
  ) : null;

  const expected: ExpectedItem[] | null =
    kind === 'challan' ? expectedChallans(data, fy)
    : kind === 'return' ? expectedReturns(data, fy)
    : kind === 'certificate' ? expectedCertificates(data, fy)
    : null;

  return (
    <div className="space-y-4">
      {slug === 'registration' ? <ProfileEditor data={data} canManage={canManage} /> : null}

      <div>
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="text-13 font-medium text-neutral-900">
            {expected ? `FY ${fy}` : 'Records'}
          </div>
          <div className="flex gap-2 flex-wrap">
            {!canManage ? <span className="text-12 text-neutral-500">View only — you can’t record TDS work.</span> : null}
            {canManage && kind === 'notice' ? (
              <button type="button" className={btn} onClick={() => markChecked.mutate()} disabled={markChecked.isPending}>
                <CheckCircle2 size={12} strokeWidth={2} /> Mark checked today
              </button>
            ) : null}
            {canManage && kind === 'challan' ? <AddChallanMonth fy={fy} data={data} onPick={(ym) => open(null, { period: ym })} /> : null}
            {canManage && (kind === 'registration' || kind === 'notice') ? (
              <button type="button" className={primaryBtn} onClick={() => open(null)}>
                <Plus size={12} strokeWidth={2} /> {kind === 'notice' ? 'Record notice / default' : 'Record registration'}
              </button>
            ) : null}
            {canManage && kind === 'correction' ? (
              <CorrectionStart data={data} fy={fy} onPick={(id) => open(null, { original_id: id })} />
            ) : null}
          </div>
        </div>

        {form && !form.recordId && !expected ? <div className="mb-3">{formEl}</div> : null}

        {expected ? (
          expected.length === 0 ? (
            <Empty text={emptyText(kind)} />
          ) : (
            <ul className="border border-neutral-200 rounded-md divide-y divide-neutral-100">
              {expected.map((it) => {
                const editingThis = form && (form.recordId ? form.recordId === it.record?.id : form.values.period === it.period && (form.values.form_type ?? '') === (it.formType ?? ''));
                return (
                  <li key={`${it.period}-${it.formType}`}>
                    <div className="flex items-center gap-3 px-3 py-2 flex-wrap">
                      <div className="w-44 text-13 font-medium text-neutral-900">{it.label}</div>
                      <StatePill state={it.state} kind={kind} />
                      <div className="flex-1 min-w-[160px] text-12 text-neutral-500 truncate">
                        {it.record ? summarize(it.record) : `Due ${fmtDate(it.due)}`}
                        <Penalty data={data} item={it} />
                      </div>
                      {it.record ? <FileCell clientId={clientId} record={it.record} canManage={canManage} /> : null}
                      <button
                        type="button"
                        hidden={!canManage}
                        className={btn}
                        onClick={() => (it.record ? open(it.record) : open(null, kind === 'certificate'
                          ? { period: it.period, form_type: it.formType }
                          : { period: it.period, form_type: it.formType }))}
                      >
                        {it.record ? <><Pencil size={12} strokeWidth={2} /> Edit</> : <><Plus size={12} strokeWidth={2} /> Record</>}
                      </button>
                    </div>
                    {editingThis ? <div className="px-3 pb-3">{formEl}</div> : null}
                  </li>
                );
              })}
            </ul>
          )
        ) : (
          <RecordList
            records={data.records.filter((r) => r.kind === kind && (kind !== 'correction' || r.fy === fy))}
            kind={kind}
            data={data}
            canManage={canManage}
            form={form}
            formEl={formEl}
            onEdit={(r) => open(r)}
          />
        )}

        {kind === 'notice' ? <NoticeChecks data={data} /> : null}
      </div>
    </div>
  );
}

function emptyText(kind: TdsKind): string {
  if (kind === 'challan') return 'No deduction month of this FY has closed yet.';
  if (kind === 'return') return 'No quarter of this FY has closed yet.';
  return 'No certificates are owed yet — they follow filed returns (26Q/27Q → 16A, 27EQ → 27D, 24Q Q4 → Form 16).';
}

function summarize(r: TdsRecord): string {
  const parts: string[] = [];
  if (r.kind === 'challan') {
    if (r.reference) parts.push(`Serial ${r.reference}`);
    if (r.bsr_code) parts.push(`BSR ${r.bsr_code}`);
    const total = (r.amount_tax ?? 0) + (r.amount_interest ?? 0) + (r.amount_fee ?? 0);
    parts.push(`₹${total.toLocaleString('en-IN')}`);
  } else if (r.reference) {
    parts.push(r.kind === 'registration' ? `Ack ${r.reference}` : r.kind === 'notice' ? r.reference : `Token ${r.reference}`);
  }
  if (r.event_date) parts.push(fmtDate(r.event_date));
  if (r.filed_by) parts.push(`by ${r.filed_by}`);
  if (r.kind === 'notice' && r.amount_tax) parts.push(`Demand ₹${r.amount_tax.toLocaleString('en-IN')}`);
  return parts.join(' · ');
}

const PILL: Record<ExpectedItem['state'], { bg: string; fg: string }> = {
  done:        { bg: '#E7F5EE', fg: '#166534' },
  in_progress: { bg: '#E6EEFC', fg: '#1D4ED8' },
  due:         { bg: '#FEF3C7', fg: '#B45309' },
  overdue:     { bg: '#FDE7EA', fg: '#B91C1C' },
};
function StatePill({ state, kind }: { state: ExpectedItem['state']; kind: TdsKind }) {
  const doneLabel = kind === 'challan' ? 'Paid' : kind === 'certificate' ? 'Issued' : 'Filed';
  const label = { done: doneLabel, in_progress: 'In progress', due: kind === 'challan' ? 'Unpaid' : 'Due', overdue: 'Overdue' }[state];
  const t = PILL[state];
  return (
    <span className="inline-flex items-center justify-center w-24 h-6 text-11 font-medium rounded-md" style={{ backgroundColor: t.bg, color: t.fg }}>
      {label}
    </span>
  );
}

function RecordList({
  records, kind, data, form, formEl, onEdit, canManage,
}: {
  records: TdsRecord[];
  kind: TdsKind;
  data: TdsData;
  canManage: boolean;
  form: FormState | null;
  formEl: React.ReactNode;
  onEdit: (r: TdsRecord) => void;
}) {
  if (records.length === 0) {
    return <Empty text={kind === 'registration'
      ? data.active_tan ? `TAN ${data.active_tan} is on record. No Form 49B filing recorded here.` : 'No registration recorded yet.'
      : kind === 'correction' ? 'No corrections recorded for this FY.' : 'No notices or defaults recorded.'} />;
  }
  const original = (id: string | null) => data.records.find((r) => r.id === id);
  return (
    <ul className="border border-neutral-200 rounded-md divide-y divide-neutral-100">
      {records.map((r) => {
        const o = r.kind === 'correction' ? original(r.original_id) : null;
        return (
          <li key={r.id}>
            <div className="flex items-center gap-3 px-3 py-2 flex-wrap">
              <div className="w-44 text-13 font-medium text-neutral-900 truncate">
                {o ? `${o.form_type} · ${o.period}` : r.kind === 'notice' ? (r.reference || 'Notice') : r.kind === 'registration' ? 'Form 49B' : monthLabel(r.period ?? '')}
              </div>
              <span className="inline-flex items-center justify-center w-24 h-6 text-11 font-medium rounded-md"
                style={{ backgroundColor: PILL[r.status === 'done' ? 'done' : r.status === 'in_progress' ? 'in_progress' : 'overdue'].bg, color: PILL[r.status === 'done' ? 'done' : r.status === 'in_progress' ? 'in_progress' : 'overdue'].fg }}>
                {r.kind === 'notice' ? { pending: 'Open', in_progress: 'Responding', done: 'Closed' }[r.status] : r.status === 'done' ? 'Filed' : 'In progress'}
              </span>
              <div className="flex-1 min-w-[160px] text-12 text-neutral-500 truncate" title={r.notes ?? undefined}>
                {summarize(r)}{r.notes ? ` · ${r.notes}` : ''}
              </div>
              {r.kind !== 'notice_check' ? <FileCell clientId={data.client.id} record={r} canManage={canManage} /> : null}
              {canManage ? <button type="button" className={btn} onClick={() => onEdit(r)}><Pencil size={12} strokeWidth={2} /> Edit</button> : null}
            </div>
            {form?.recordId === r.id ? <div className="px-3 pb-3">{formEl}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}

function RecordForm({
  specs, state, editing, error, pending, onChange, onCancel, onSubmit, onDelete,
}: {
  specs: FieldSpec[];
  state: FormState;
  editing: boolean;
  error: string | null;
  pending: boolean;
  onChange: (v: Record<string, string>) => void;
  onCancel: () => void;
  onSubmit: () => void;
  onDelete?: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const v = state.values;
  const done = (v.status || 'done') === 'done';
  const missing = specs.filter((s) => s.required && done && !(v[s.key] ?? '').trim());
  return (
    <form
      className="p-3 border border-neutral-200 rounded-md bg-neutral-50 space-y-3"
      onSubmit={(e) => { e.preventDefault(); if (!missing.length) onSubmit(); }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {specs.map((s) => {
          const val = v[s.key] ?? '';
          const set = (x: string) => onChange({ ...v, [s.key]: x });
          const locked = s.locked && (editing || !!val);
          const common = { id: `tds-f-${s.key}`, value: val, disabled: locked };
          return (
            <label key={s.key} className={s.type === 'textarea' ? 'block sm:col-span-2' : 'block'} htmlFor={common.id}>
              <span className="block text-11 text-neutral-500 mb-1">
                {s.label}
                {s.required && done ? <span className="text-danger ml-1">*</span> : null}
              </span>
              {s.type === 'select' ? (
                <select {...common} className={inputCls} onChange={(e) => set(e.target.value)}>
                  {!s.options?.some((o) => o.value === val) ? <option value="">— Select —</option> : null}
                  {s.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : s.type === 'textarea' ? (
                <textarea {...common} rows={2} className={inputCls + ' h-auto py-2'} onChange={(e) => set(e.target.value)} />
              ) : (
                <input
                  {...common}
                  type={s.type === 'money' ? 'number' : s.type}
                  min={s.type === 'money' ? 0 : undefined}
                  step={s.type === 'money' ? '0.01' : undefined}
                  className={inputCls + (s.type === 'text' ? ' font-mono' : '')}
                  onChange={(e) => set(e.target.value)}
                />
              )}
              {s.hint ? <span className="block text-11 text-neutral-500 mt-1">{s.hint}</span> : null}
            </label>
          );
        })}
      </div>
      {error ? <div className="text-12 text-danger whitespace-pre-line">{error}</div> : null}
      {confirmDelete ? (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-12 text-neutral-700">Delete this record? The client and other records are not affected.</span>
          <button type="button" className={btn} onClick={() => setConfirmDelete(false)}>Cancel</button>
          <button type="button" onClick={onDelete}
            className="inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-white bg-red-600 hover:bg-red-700 rounded-md">
            <Trash2 size={12} strokeWidth={2} /> Delete
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" className={btn} onClick={onCancel} disabled={pending}>Cancel</button>
          <button type="submit" className={primaryBtn} disabled={pending || missing.length > 0}
            title={missing.length ? `Required: ${missing.map((m) => m.label).join(', ')}` : undefined}>
            {pending ? 'Saving…' : 'Save'}
          </button>
          {onDelete ? (
            <button type="button" className={btn + ' ml-auto'} onClick={() => setConfirmDelete(true)}>
              <Trash2 size={12} strokeWidth={2} /> Delete
            </button>
          ) : null}
        </div>
      )}
    </form>
  );
}

function AddChallanMonth({ fy, data, onPick }: { fy: string; data: TdsData; onPick: (ym: string) => void }) {
  // Lets the firm record a challan for the running month (paid early) — closed months already have rows.
  const shown = new Set(expectedChallans(data, fy).map((i) => i.period));
  const start = Number(fy.split('-')[0]);
  const months = Array.from({ length: 12 }, (_, i) => {
    const m0 = (3 + i) % 12;
    return `${m0 < 3 ? start + 1 : start}-${String(m0 + 1).padStart(2, '0')}`;
  }).filter((m) => !shown.has(m));
  if (months.length === 0) return null;
  return (
    <select className="h-8 px-2 text-12 border border-neutral-200 rounded-md bg-white" value=""
      onChange={(e) => e.target.value && onPick(e.target.value)} aria-label="Record challan for another month">
      <option value="">+ Record another month…</option>
      {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
    </select>
  );
}

function CorrectionStart({ data, fy, onPick }: { data: TdsData; fy: string; onPick: (originalId: string) => void }) {
  const originals = data.records.filter((r) => r.kind === 'return' && r.status === 'done' && r.fy === fy);
  if (originals.length === 0) return <span className="text-12 text-neutral-500">No filed return in FY {fy} to correct.</span>;
  return (
    <select className="h-8 px-2 text-12 border border-neutral-200 rounded-md bg-white" value=""
      onChange={(e) => e.target.value && onPick(e.target.value)} aria-label="Start a correction">
      <option value="">+ New correction for…</option>
      {originals.map((r) => <option key={r.id} value={r.id}>{r.form_type} · {r.period} · token {r.reference}</option>)}
    </select>
  );
}

function NoticeChecks({ data }: { data: TdsData }) {
  const last = lastNoticeCheck(data);
  const checks = data.records.filter((r) => r.kind === 'notice_check').slice(0, 5);
  return (
    <div className="mt-3 text-12 text-neutral-500">
      {last ? `Last checked on TRACES: ${fmtDate(last)}` : 'Never checked on TRACES.'}
      {checks.length > 1 ? ` · earlier: ${checks.slice(1).map((c) => fmtDate(c.event_date!)).join(', ')}` : ''}
    </div>
  );
}

const DEDUCTOR_TYPES = [
  ['company', 'Company'], ['firm', 'Firm / LLP'], ['individual', 'Individual / HUF'], ['government', 'Government'],
  ['trust', 'Trust'], ['aop', 'AOP / BOI'], ['other', 'Other'],
] as const;

/** Profile inputs, in Form 49B order. `limit` mirrors FORM_49B_LIMITS — over it warns, never truncates. */
const PROFILE_INPUTS: { key: ProfileTextKey; label: string; limit?: number; hint?: string; upper?: boolean }[] = [
  { key: 'responsible_person', label: 'Responsible person name', limit: FORM_49B_LIMITS.responsiblePersonName },
  { key: 'rp_designation', label: 'Designation' },
  { key: 'rp_pan', label: 'PAN', upper: true, hint: 'ABCDE1234F' },
  { key: 'rp_email', label: 'Email' },
  { key: 'rp_mobile', label: 'Mobile', hint: '10 digits' },
  { key: 'addr_flat', label: 'Flat / door / block no.', limit: FORM_49B_LIMITS.flatDoorBlockNo },
  { key: 'addr_building', label: 'Building name', limit: FORM_49B_LIMITS.buildingName },
  { key: 'addr_road', label: 'Road / street', limit: FORM_49B_LIMITS.roadStreet },
  { key: 'addr_area', label: 'Area / locality', limit: FORM_49B_LIMITS.areaLocality },
  { key: 'addr_city', label: 'City / district', limit: FORM_49B_LIMITS.cityDistrict },
  { key: 'addr_pin', label: 'Pin code', limit: FORM_49B_LIMITS.pinCode },
  { key: 'ao_code', label: 'AO code', hint: 'Area code · AO type · Range code · AO number — e.g. CHE W 51 1' },
];

function ProfileEditor({ data, canManage }: { data: TdsData; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const initial = () => ({
    forms: data.profile.return_forms as string[],
    deductor: data.profile.deductor_type ?? '',
    tans: data.profile.additional_tans.join(', '),
    text: Object.fromEntries(PROFILE_TEXT_KEYS.map((k) => [k, data.profile[k] ?? ''])) as Record<ProfileTextKey, string>,
  });
  const [st, setSt] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const base = initial();
  const tanList = st.tans.split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
  const dirty = st.forms.join() !== base.forms.join() || st.deductor !== base.deductor || tanList.join(', ') !== base.tans
    || PROFILE_TEXT_KEYS.some((k) => st.text[k].trim() !== base.text[k]);
  const save = useMutation({
    mutationFn: () => tdsApi.saveProfile(data.client.id, {
      return_forms: st.forms as TdsData['profile']['return_forms'],
      deductor_type: st.deductor || null,
      additional_tans: tanList,
      ...Object.fromEntries(PROFILE_TEXT_KEYS.map((k) => [k, st.text[k].trim() || null])),
    }),
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: ['tds', data.client.id] }); toast.push('success', 'TDS profile saved.'); },
    onError: (e: Error) => setError(fieldErrorText(e)),
  });
  const setText = (k: ProfileTextKey, v: string) => setSt({ ...st, text: { ...st.text, [k]: v } });
  return (
    <div className="p-3 border border-neutral-200 rounded-md">
      <div className="text-13 font-medium text-neutral-900 mb-3">TDS profile</div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <span className="block text-11 text-neutral-500 mb-1">Quarterly returns filed</span>
          <div className="flex flex-wrap gap-3 h-9 items-center">
            {RETURN_FORMS.map((f) => (
              <label key={f} className="inline-flex items-center gap-1 text-13">
                <input type="checkbox" checked={st.forms.includes(f)}
                  onChange={(e) => setSt({ ...st, forms: e.target.checked ? [...st.forms, f] : st.forms.filter((x) => x !== f) })} />
                {f}
              </label>
            ))}
          </div>
        </div>
        <label className="block">
          <span className="block text-11 text-neutral-500 mb-1">Deductor type</span>
          <select className={inputCls} value={st.deductor} onChange={(e) => setSt({ ...st, deductor: e.target.value })}>
            <option value="">— Not set —</option>
            {DEDUCTOR_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="block text-11 text-neutral-500 mb-1">Additional TANs (branches)</span>
          <input className={inputCls + ' font-mono'} value={st.tans} placeholder="e.g. CHEA12345C, MUMA67890D"
            onChange={(e) => setSt({ ...st, tans: e.target.value.toUpperCase() })} />
          <span className="block text-11 text-neutral-500 mt-1">
            Primary: {data.client.tan ?? 'not recorded yet'}. Each TAN gets its own challans, returns and certificates.
          </span>
        </label>
      </div>

      <div className="text-12 font-medium text-neutral-700 mt-4 mb-2">Form 49B details · responsible person, address, AO code</div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PROFILE_INPUTS.map((f) => {
          const v = st.text[f.key];
          const over = !!(f.limit && v.trim().length > f.limit);
          return (
            <label key={f.key} className="block">
              <span className="block text-11 text-neutral-500 mb-1">{f.label}</span>
              <input
                className={inputCls + (over ? ' border-danger' : '')}
                value={v}
                onChange={(e) => setText(f.key, f.upper ? e.target.value.toUpperCase() : e.target.value)}
              />
              {over ? (
                <span className="block text-11 text-danger mt-1">{v.trim().length}/{f.limit} — over the portal limit; shorten it, don’t let the portal truncate.</span>
              ) : f.hint ? <span className="block text-11 text-neutral-500 mt-1">{f.hint}</span> : null}
            </label>
          );
        })}
      </div>
      {error ? <div className="text-12 text-danger whitespace-pre-line mt-3">{error}</div> : null}
      <div className="mt-3" hidden={!canManage}>
        <button type="button" className={primaryBtn} disabled={!dirty || st.forms.length === 0 || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </div>
  );
}

/** Interest (late challan) / 234E fee (late return) — computed guidance shown under the row. */
function Penalty({ data, item }: { data: TdsData; item: ExpectedItem }) {
  if (item.kind === 'challan' && item.record) {
    const i = challanInterest(item.record);
    if (!i) return null;
    const paid = item.record.amount_interest ?? 0;
    return (
      <span className={'block ' + (paid < i.amount ? 'text-danger' : 'text-neutral-500')}
        title="1.5% per month or part, u/s 201(1A)(ii), assuming deduction on the 1st of the month (maximum). Use actual deduction dates for the exact figure.">
        Late deposit — interest up to ₹{i.amount.toLocaleString('en-IN')} ({i.months} mo × 1.5%)
        {paid < i.amount ? ` · recorded ₹${paid.toLocaleString('en-IN')}` : ''}
      </span>
    );
  }
  if (item.kind === 'return' && (item.state === 'overdue' || item.record?.status === 'done')) {
    const f = lateFee234E(data, item);
    if (!f) return null;
    const paid = item.record?.amount_fee ?? 0;
    return (
      <span className={'block ' + (paid < f.amount ? 'text-danger' : 'text-neutral-500')}
        title="₹200 per day of delay u/s 234E, capped at the TDS deposited for the quarter (from recorded challans).">
        234E fee ₹{f.amount.toLocaleString('en-IN')} ({f.days} day{f.days > 1 ? 's' : ''}{f.capped ? ', capped at quarter TDS' : ''})
        {item.record?.status === 'done' && paid < f.amount ? ` · recorded ₹${paid.toLocaleString('en-IN')}` : ''}
      </span>
    );
  }
  return null;
}

/** Attached receipt / certificate: open link + attach / replace. */
function FileCell({ clientId, record, canManage }: { clientId: string; record: TdsRecord; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const up = useMutation({
    mutationFn: (file: File) => tdsApi.uploadFile(clientId, record.id, file),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tds', clientId] }); toast.push('success', 'File attached.'); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const doc = record.document;
  return (
    <span className="inline-flex items-center gap-1">
      {doc ? (
        <a href={tdsApi.fileUrl(clientId, record.id, true)} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 h-8 px-2 text-12 text-neutral-700 hover:text-gold max-w-[160px]"
          title={`${doc.original_name ?? 'File'} · v${doc.version} · ${Math.ceil(doc.size_bytes / 1024)} KB`}>
          <Paperclip size={12} strokeWidth={2} className="shrink-0" />
          <span className="truncate">{doc.original_name ?? 'File'}</span>
        </a>
      ) : null}
      {canManage ? (
        <label className={btn + ' cursor-pointer'} title={doc ? 'Replace the file (keeps the old version)' : 'Attach receipt / certificate (PDF, JPG, PNG, ZIP, TXT)'}>
          <Upload size={12} strokeWidth={2} />
          {up.isPending ? 'Uploading…' : doc ? 'Replace' : 'Attach'}
          <input type="file" className="sr-only" accept=".pdf,.jpg,.jpeg,.png,.zip,.txt,.csi,.fvu" disabled={up.isPending}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) up.mutate(f); e.target.value = ''; }} />
        </label>
      ) : !doc ? <span className="text-11 text-neutral-400 px-2">No file</span> : null}
    </span>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-3 py-4 text-13 text-neutral-500 border border-dashed border-neutral-200 rounded-md">{text}</div>;
}

/** Flatten the server's per-field validation details into readable lines. */
function fieldErrorText(e: Error & { details?: unknown }): string {
  const d = e.details as { fields?: Record<string, string> } | Record<string, string> | undefined;
  const fields = d && typeof d === 'object' ? ('fields' in d && d.fields ? d.fields : d) : undefined;
  if (fields && typeof fields === 'object' && Object.keys(fields).length) {
    return Object.entries(fields as Record<string, string>).map(([k, m]) => `${k.replace(/_/g, ' ')}: ${m}`).join('\n');
  }
  return e.message;
}
