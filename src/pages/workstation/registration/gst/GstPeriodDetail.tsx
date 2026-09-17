/**
 * GST CLIENT DETAIL — one client, one period, the whole cycle (§27).
 *
 * This is where the work actually happens: every stage can be advanced,
 * every figure entered, the filing and payment recorded, and the people
 * assigned. The lists elsewhere are views onto what is changed here.
 *
 * Nothing on this page contacts the GST portal. A return is marked
 * "Filed — manually recorded" against an ARN an employee typed in after
 * filing on the government site, which is why the filing dialog asks for
 * the ARN and the date rather than offering a Submit button (§42).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, Check, Circle, AlertTriangle } from 'lucide-react';
import {
  Card, PageHeader, QueryState, Status, Modal, Field, Detail,
  inputClass, fieldErrors,
} from '@/modules/workstation/components';
import { workstationApi } from '@/modules/workstation/api';
import {
  gstApi, rupees, periodLabel, errorMessage, STAGE_STATUSES, type StageKey,
} from '@/modules/workstation/gst/api';

const DONE: Record<StageKey, string[]> = {
  gstr1: ['filed'],
  gstr2b: ['reconciliation_completed'],
  gstr3b: ['filed', 'completed'],
};

function StageIcon({ stage, status }: { stage: StageKey; status: string }) {
  const done = DONE[stage].includes(status);
  const bad = ['exceptions_found', 'rework_required'].includes(status);
  const Icon = done ? Check : bad ? AlertTriangle : Circle;
  return <Icon size={15} strokeWidth={2} className={done ? 'text-green' : bad ? 'text-red' : 'text-neutral-400'} aria-hidden />;
}

export function GstPeriodDetail() {
  const { periodId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<StageKey | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [paying, setPaying] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [err, setErr] = useState<Record<string, string>>({});
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const q = useQuery({ queryKey: ['gst', 'period', periodId], queryFn: () => gstApi.period(periodId) });
  const employees = useQuery({
    queryKey: ['workstation', 'assignable-employees'],
    queryFn: () => workstationApi.assignableEmployees(),
  });

  const done = () => {
    setEditing(null); setAssigning(false); setPaying(false); setForm({}); setErr({}); setErrMsg(null);
    void qc.invalidateQueries({ queryKey: ['gst'] });
  };
  const fail = (e: unknown) => { setErr(fieldErrors(e)); setErrMsg(errorMessage(e)); };

  const saveStage = useMutation({
    mutationFn: ({ stage, body }: { stage: StageKey; body: Record<string, unknown> }) =>
      gstApi.updateStage(periodId, stage, body),
    onSuccess: done, onError: fail,
  });
  const saveAssign = useMutation({
    mutationFn: (body: Record<string, string | null>) => gstApi.assign(periodId, body),
    onSuccess: done, onError: fail,
  });
  const savePayment = useMutation({
    mutationFn: (body: { payment_date: string; challan_ref?: string }) => gstApi.recordPayment(periodId, body),
    onSuccess: done, onError: fail,
  });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => navigate('../dashboard')}
        className="inline-flex items-center gap-1 min-h-[44px] md:min-h-0 text-13 text-neutral-500 hover:text-neutral-900"
      >
        <ChevronLeft size={16} strokeWidth={2} />
        GST Compliance
      </button>

      <QueryState query={q}>
        {(p) => {
          const stages: { key: StageKey; title: string; status: string }[] = [
            { key: 'gstr1', title: 'GSTR-1', status: p.stage_status.gstr1 },
            { key: 'gstr2b', title: 'GSTR-2B', status: p.stage_status.gstr2b },
            { key: 'gstr3b', title: 'GSTR-3B', status: p.stage_status.gstr3b },
          ];
          return (
            <>
              <PageHeader
                title={p.client_name ?? p.gstin}
                subtitle={`${p.gstin} · ${periodLabel(p.period)} · FY ${p.financial_year}`}
              />

              <Card
                title="At a glance"
                right={
                  <button type="button" onClick={() => { setAssigning(true); setForm({
                    assigned_employee_id: p.assigned_employee_id ?? '',
                    reviewer_employee_id: p.reviewer_employee_id ?? '',
                  }); }}
                    className="text-13 text-primary hover:underline">
                    Edit assignment
                  </button>
                }
              >
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4">
                  <Detail label="Overall" value={<Status value={p.overall_status} />} />
                  <Detail label="Registration" value={p.registration_type} />
                  <Detail label="Next due" value={p.due_label ?? '—'} />
                  <Detail label="Open exceptions" value={String(p.open_exceptions)} />
                  <Detail label="Assigned to" value={p.assigned_employee_name ?? '—'} />
                  <Detail label="Reviewer" value={p.reviewer_employee_name ?? '—'} />
                  <Detail label="Filing frequency" value={p.filing_frequency} />
                  <Detail label="Period" value={periodLabel(p.period)} />
                </div>
              </Card>

              {/* The cycle, each stage editable in place. */}
              {stages.map((s) => {
                const filing = s.key === 'gstr1' ? p.gstr1 : s.key === 'gstr3b' ? p.gstr3b : null;
                return (
                  <Card
                    key={s.key}
                    title={
                      <span className="inline-flex items-center gap-2">
                        <StageIcon stage={s.key} status={s.status} />
                        {s.title}
                      </span> as unknown as string
                    }
                    right={
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(s.key);
                          setForm({ status: s.status });
                        }}
                        className="text-13 text-primary hover:underline"
                      >
                        Update
                      </button>
                    }
                  >
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4">
                      <Detail label="Status" value={<Status value={s.status} />} />
                      {s.key === 'gstr2b' ? (
                        <>
                          <Detail label="Available date" value={p.gstr2b.available_date ?? '—'} />
                          <Detail label="Total ITC" value={rupees(p.gstr2b.total_itc)} />
                          <Detail label="Reconciliation" value={<Status value={p.reconciliation.status} />} />
                        </>
                      ) : s.key === 'gstr1' ? (
                        <>
                          <Detail label="Due" value={filing?.due_date ?? '—'} />
                          <Detail label="Taxable value" value={rupees(filing?.taxable_value)} />
                          <Detail label="Tax" value={rupees(filing?.tax_amount)} />
                          <Detail label="ARN" value={filing?.arn ?? '—'} />
                          <Detail
                            label="Filing"
                            value={filing?.filed_at ? 'Filed — manually recorded' : 'Not filed'}
                          />
                        </>
                      ) : (
                        <>
                          <Detail label="Due" value={filing?.due_date ?? '—'} />
                          <Detail label="Tax liability" value={rupees(filing?.tax_liability)} />
                          <Detail label="Eligible ITC" value={rupees(filing?.eligible_itc)} />
                          <Detail label="Net payable" value={rupees(filing?.net_payable)} />
                          <Detail label="ARN" value={filing?.arn ?? '—'} />
                          <Detail
                            label="Payment"
                            value={
                              filing?.payment_status === 'completed' ? 'Paid' :
                              filing?.payment_status === 'pending' ? (
                                <button type="button" onClick={() => setPaying(true)} className="text-13 text-primary hover:underline">
                                  Record payment
                                </button>
                              ) : '—'
                            }
                          />
                        </>
                      )}
                    </div>
                  </Card>
                );
              })}

              {/* §39 audit trail, read-only by construction. */}
              <Card title="Activity">
                {p.timeline.length === 0 ? (
                  <div className="px-4 py-6 text-13 text-neutral-500">Nothing recorded yet.</div>
                ) : (
                  <ul className="p-4 space-y-2">
                    {(p.timeline as { action: string; stage: string | null; at: string }[]).map((t, i) => (
                      <li key={i} className="text-13 text-neutral-700 flex gap-3">
                        <span className="text-neutral-400 tabular-nums shrink-0">{t.at.slice(0, 16).replace('T', ' ')}</span>
                        <span>{t.action.replace(/_/g, ' ').toLowerCase()}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              {/* ── Update a stage ─────────────────────────────────────── */}
              <Modal
                open={editing !== null}
                title={editing ? `Update ${editing.toUpperCase().replace('GSTR', 'GSTR-')}` : ''}
                onClose={done}
                footer={
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={done} className="h-8 px-3 text-13 border border-neutral-300 rounded">Cancel</button>
                    <button
                      type="button"
                      disabled={saveStage.isPending}
                      onClick={() => {
                        if (!editing) return;
                        const body: Record<string, unknown> = { status: form.status };
                        if (editing === 'gstr1') {
                          body.taxable_value = num(form.taxable_value);
                          body.tax_amount = num(form.tax_amount);
                          if (form.arn) body.arn = form.arn;
                          if (form.filed_date) body.filed_date = form.filed_date;
                        } else if (editing === 'gstr3b') {
                          body.tax_liability = num(form.tax_liability);
                          body.eligible_itc = num(form.eligible_itc);
                          body.net_payable = num(form.net_payable);
                          if (form.arn) body.arn = form.arn;
                          if (form.filed_date) body.filed_date = form.filed_date;
                          if (form.status === 'filed') body.payment_status = 'pending';
                        } else {
                          if (form.available_date) body.available_date = form.available_date;
                          if (form.download_date) body.download_date = form.download_date;
                          body.total_itc_igst = num(form.total_itc_igst);
                        }
                        saveStage.mutate({ stage: editing, body });
                      }}
                      className="h-8 px-3 text-13 bg-neutral-900 text-white rounded disabled:opacity-50"
                    >
                      {saveStage.isPending ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                }
              >
                {editing ? (
                  <div>
                    {errMsg ? <div className="mb-3 text-13 text-red border-l-2 border-red pl-3 py-1">{errMsg}</div> : null}
                    <Field label="Status">
                      <select className={inputClass} value={form.status ?? ''} onChange={(e) => set('status', e.target.value)}>
                        {STAGE_STATUSES[editing].map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </Field>

                    {editing === 'gstr1' ? (
                      <>
                        <Field label="Taxable value (₹)">
                          <input className={inputClass} inputMode="decimal" value={form.taxable_value ?? ''} onChange={(e) => set('taxable_value', e.target.value)} />
                        </Field>
                        <Field label="Tax amount (₹)">
                          <input className={inputClass} inputMode="decimal" value={form.tax_amount ?? ''} onChange={(e) => set('tax_amount', e.target.value)} />
                        </Field>
                      </>
                    ) : editing === 'gstr3b' ? (
                      <>
                        <Field label="Tax liability (₹)">
                          <input className={inputClass} inputMode="decimal" value={form.tax_liability ?? ''} onChange={(e) => set('tax_liability', e.target.value)} />
                        </Field>
                        <Field label="Eligible ITC (₹)">
                          <input className={inputClass} inputMode="decimal" value={form.eligible_itc ?? ''} onChange={(e) => set('eligible_itc', e.target.value)} />
                        </Field>
                        <Field label="Net payable (₹)">
                          <input className={inputClass} inputMode="decimal" value={form.net_payable ?? ''} onChange={(e) => set('net_payable', e.target.value)} />
                        </Field>
                      </>
                    ) : (
                      <>
                        <Field label="Available date">
                          <input type="date" className={inputClass} value={form.available_date ?? ''} onChange={(e) => set('available_date', e.target.value)} />
                        </Field>
                        <Field label="Download date">
                          <input type="date" className={inputClass} value={form.download_date ?? ''} onChange={(e) => set('download_date', e.target.value)} />
                        </Field>
                        <Field label="Total ITC — IGST (₹)">
                          <input className={inputClass} inputMode="decimal" value={form.total_itc_igst ?? ''} onChange={(e) => set('total_itc_igst', e.target.value)} />
                        </Field>
                      </>
                    )}

                    {form.status === 'filed' ? (
                      <div className="mt-2 pt-3 border-t border-neutral-200">
                        <p className="text-12 text-neutral-500 mb-3">
                          Audit OS does not file returns. File on the GST portal, then record
                          the acknowledgement here.
                        </p>
                        <Field label="ARN" error={err.arn}>
                          <input className={inputClass} value={form.arn ?? ''} onChange={(e) => set('arn', e.target.value)} placeholder="AA330926000001X" />
                        </Field>
                        <Field label="Filing date" error={err.filed_date}>
                          <input type="date" className={inputClass} value={form.filed_date ?? ''} onChange={(e) => set('filed_date', e.target.value)} />
                        </Field>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </Modal>

              {/* ── Assignment ─────────────────────────────────────────── */}
              <Modal
                open={assigning}
                title="Assign this period"
                onClose={done}
                footer={
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={done} className="h-8 px-3 text-13 border border-neutral-300 rounded">Cancel</button>
                    <button
                      type="button"
                      disabled={saveAssign.isPending}
                      onClick={() => saveAssign.mutate({
                        assigned_employee_id: form.assigned_employee_id || null,
                        reviewer_employee_id: form.reviewer_employee_id || null,
                      })}
                      className="h-8 px-3 text-13 bg-neutral-900 text-white rounded disabled:opacity-50"
                    >
                      {saveAssign.isPending ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                }
              >
                {errMsg ? <div className="mb-3 text-13 text-red border-l-2 border-red pl-3 py-1">{errMsg}</div> : null}
                {(['assigned_employee_id', 'reviewer_employee_id'] as const).map((k) => (
                  <Field key={k} label={k === 'assigned_employee_id' ? 'Assigned employee' : 'Reviewer'}>
                    <select className={inputClass} value={form[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
                      <option value="">Unassigned</option>
                      {(employees.data?.items ?? []).map((e) => (
                        <option key={e.id} value={e.id}>{e.full_name ?? e.id}</option>
                      ))}
                    </select>
                  </Field>
                ))}
              </Modal>

              {/* ── Payment ────────────────────────────────────────────── */}
              <Modal
                open={paying}
                title="Record GSTR-3B payment"
                onClose={done}
                footer={
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={done} className="h-8 px-3 text-13 border border-neutral-300 rounded">Cancel</button>
                    <button
                      type="button"
                      disabled={savePayment.isPending}
                      onClick={() => savePayment.mutate({
                        payment_date: form.payment_date ?? '',
                        challan_ref: form.challan_ref || undefined,
                      })}
                      className="h-8 px-3 text-13 bg-neutral-900 text-white rounded disabled:opacity-50"
                    >
                      {savePayment.isPending ? 'Saving…' : 'Record'}
                    </button>
                  </div>
                }
              >
                {errMsg ? <div className="mb-3 text-13 text-red border-l-2 border-red pl-3 py-1">{errMsg}</div> : null}
                <Field label="Payment date">
                  <input type="date" className={inputClass} value={form.payment_date ?? ''} onChange={(e) => set('payment_date', e.target.value)} />
                </Field>
                <Field label="Challan / reference number">
                  <input className={inputClass} value={form.challan_ref ?? ''} onChange={(e) => set('challan_ref', e.target.value)} />
                </Field>
              </Modal>
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
