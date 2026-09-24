/**
 * ONE GST WORK SECTION — GSTR-1, GSTR-2B or GSTR-3B (§11–§19).
 *
 * Each section answers the same two questions in the same order: HOW MANY
 * need work, then WHICH CLIENTS. The summary tiles are the filter — clicking
 * "Overdue" narrows the list beneath rather than opening a different screen,
 * so the count and the names can never disagree.
 *
 * The three stages share this component because they differ only in their
 * summary keys and their columns. GSTR-2B's differences are not cosmetic:
 * it has no due date of its own and, per §15, no "Filed" anywhere.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import {
  Card, PageHeader, QueryState, Table, Row, Cell, Status, FilterBar, SearchInput,
  Modal, Field, inputClass,
} from '@/modules/workstation/components';
import { workstationApi } from '@/modules/workstation/api';
import {
  gstApi, rupees, periodLabel, recentPeriods, errorMessage, STAGE_STATUSES,
  type StageKey, type PeriodFilters, type StageRow,
} from '@/modules/workstation/gst/api';
import { SERVICES } from '../partnership/shared';
import type { RegistrationKind } from '@/modules/partnership/api';

/** Which shared-case service each return-tab stage maps to (§9-2). */
const STAGE_TO_KIND: Record<StageKey, RegistrationKind> = {
  gstr1: 'GSTR1',
  gstr2b: 'GSTR2B',
  gstr3b: 'GSTR3B',
};

interface Tile { key: string; label: string; tone?: 'warn' | 'bad' | 'good'; due?: string }

/** §12 / §14 / §19 — each stage's own summary, in the spec's order. */
const TILES: Record<StageKey, Tile[]> = {
  gstr1: [
    { key: 'today_work', label: "Today's work", tone: 'warn', due: 'today' },
    { key: 'upcoming', label: 'Upcoming', due: 'upcoming' },
    { key: 'overdue', label: 'Overdue', tone: 'bad', due: 'overdue' },
    { key: 'in_progress', label: 'In progress' },
    { key: 'completed', label: 'Filed', tone: 'good', due: 'completed' },
  ],
  gstr2b: [
    { key: 'today_work', label: "Today's work", tone: 'warn', due: 'today' },
    { key: 'expected', label: 'Expected' },
    { key: 'available', label: 'Available' },
    { key: 'downloaded', label: 'Downloaded' },
    { key: 'reconciliation_pending', label: 'Reconciliation pending', tone: 'warn' },
    { key: 'completed', label: 'Reconciled', tone: 'good' },
    { key: 'exceptions', label: 'Exceptions', tone: 'bad' },
  ],
  gstr3b: [
    { key: 'today_work', label: "Today's work", tone: 'warn', due: 'today' },
    { key: 'upcoming', label: 'Upcoming', due: 'upcoming' },
    { key: 'overdue', label: 'Overdue', tone: 'bad', due: 'overdue' },
    { key: 'in_progress', label: 'In preparation' },
    { key: 'under_review', label: 'Under review' },
    { key: 'payment_pending', label: 'Payment pending', tone: 'warn' },
    { key: 'completed', label: 'Completed', tone: 'good', due: 'completed' },
  ],
};

const TITLE: Record<StageKey, { title: string; subtitle: string }> = {
  gstr1: {
    title: 'GSTR-1',
    subtitle: 'Outward supplies. Prepared, reviewed, then filed on the portal and recorded here.',
  },
  gstr2b: {
    // §15 — the wording matters: 2B is processed, never filed.
    title: 'GSTR-2B',
    subtitle: 'Auto-drafted ITC statement. It is downloaded and reconciled — never filed.',
  },
  gstr3b: {
    title: 'GSTR-3B',
    subtitle: 'Summary return and tax payment. Liability less eligible ITC is what falls due.',
  },
};

function Tile({
  label, value, tone, active, onClick,
}: { label: string; value: number; tone?: string; active: boolean; onClick: () => void }) {
  const tint =
    tone === 'bad' ? 'text-red' : tone === 'warn' ? 'text-amber' : tone === 'good' ? 'text-green' : 'text-neutral-900';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        'text-left px-3 py-2.5 rounded border bg-white min-h-[56px] hover:border-neutral-300 ' +
        (active ? 'border-gold ring-1 ring-gold/30' : 'border-neutral-200')
      }
    >
      <div className={`text-20 font-semibold tabular-nums ${tint}`}>{value}</div>
      <div className="text-11 text-neutral-500 mt-0.5 leading-tight">{label}</div>
    </button>
  );
}

function DueCell({ r }: { r: StageRow }) {
  if (!r.stage_due_date) return <>—</>;
  const overdue = r.days_remaining !== null && r.days_remaining < 0;
  return <span className={overdue ? 'text-red' : ''}>{r.due_label ?? r.stage_due_date}</span>;
}

export function GstStagePage({ stage }: { stage: StageKey }) {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<PeriodFilters>({ page: 1, page_size: 25 });
  const [activeTile, setActiveTile] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ['gst', 'stage', stage, filters],
    queryFn: () => gstApi.stage(stage, filters),
  });
  // Only clients with a GST profile can be given GST work.
  const clients = useQuery({ queryKey: ['gst', 'clients'], queryFn: () => gstApi.clients(), enabled: adding });
  const employees = useQuery({
    queryKey: ['workstation', 'assignable-employees'],
    queryFn: () => workstationApi.assignableEmployees(),
    enabled: adding,
  });

  const closeAdd = () => { setAdding(false); setForm({}); setErrMsg(null); };
  const add = useMutation({
    mutationFn: (body: Record<string, unknown>) => gstApi.addEntry(stage, body),
    onSuccess: () => { closeAdd(); void qc.invalidateQueries({ queryKey: ['gst'] }); },
    onError: (e) => setErrMsg(errorMessage(e)),
  });
  /**
   * Row click on a return tab (§9-2): open-or-return the case for that
   * (client, period, return kind) and navigate to the shared case screen.
   * The list still comes from GstCompliancePeriod today; §9-3 replaces it
   * with a case list that pre-owns these IDs.
   */
  const openCase = useMutation({
    mutationFn: async (r: StageRow) => {
      if (!r.client_id) throw new Error('This period has no linked client — add a client to the GST profile first.');
      const kind = STAGE_TO_KIND[stage];
      return SERVICES[kind].api.openForPeriod({
        client_id: r.client_id,
        period: r.period,
        period_type: r.period_type === 'quarterly' ? 'quarterly' : 'monthly',
        assigned_employee_id: r.assigned_employee_id ?? undefined,
        reviewer_employee_id: r.reviewer_employee_id ?? undefined,
      });
    },
    onSuccess: (res) => navigate(`../${stage}/cases/${res.id}`),
    onError: (e) => window.alert(errorMessage(e)),
  });
  const setF = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const numF = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));

  const pickTile = (t: Tile) => {
    if (activeTile === t.key) {
      setActiveTile(null);
      setFilters((f) => ({ ...f, due: undefined, page: 1 }));
      return;
    }
    setActiveTile(t.key);
    setFilters((f) => ({ ...f, due: t.due, page: 1 }));
  };

  const meta = TITLE[stage];

  return (
    <div className="m-gst space-y-4">
      <div className="flex items-start justify-between gap-3">
        <PageHeader title={meta.title} subtitle={meta.subtitle} />
        <button
          type="button"
          onClick={() => { setAdding(true); setForm({ period: recentPeriods(1)[0].value }); }}
          className="inline-flex items-center gap-1.5 h-9 min-h-[44px] md:min-h-0 px-3 shrink-0
                     text-13 font-medium bg-neutral-900 text-white rounded hover:bg-neutral-800"
        >
          <Plus size={15} strokeWidth={2.2} />
          Add {meta.title}
        </button>
      </div>

      <QueryState query={q}>
        {(d) => (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
              {TILES[stage].map((t) => (
                <Tile
                  key={t.key}
                  label={t.label}
                  value={d.summary[t.key] ?? 0}
                  tone={t.tone}
                  active={activeTile === t.key}
                  onClick={() => pickTile(t)}
                />
              ))}
            </div>

            <Card
              title={`Clients requiring ${meta.title} work`}
              right={<span className="text-12 text-neutral-500">{d.count} of {d.total}</span>}
            >
              <FilterBar>
                <SearchInput
                  value={filters.q ?? ''}
                  onChange={(v) => setFilters((f) => ({ ...f, q: v, page: 1 }))}
                  placeholder="Client, GSTIN or PAN"
                />
              </FilterBar>

              {d.items.length === 0 ? (
                <div className="px-4 py-6 text-13 text-neutral-500">
                  No client needs {meta.title} work under these filters.
                </div>
              ) : stage === 'gstr2b' ? (
                // §14 columns — availability and ITC, no due date, no ARN.
                <Table head={['Client', 'GSTIN', 'Period', 'Available', 'Status', 'ITC', 'Reconciliation', 'Assigned']}>
                  {d.items.map((r) => (
                    <Row key={r.id} status={r.stage_status_value} onClick={() => openCase.mutate(r)}>
                      <Cell>{r.client_name ?? '—'}</Cell>
                      <Cell muted><span className="font-mono text-12">{r.gstin}</span></Cell>
                      <Cell>{periodLabel(r.period)}</Cell>
                      <Cell muted>{r.gstr2b.available_date ?? '—'}</Cell>
                      <Cell><Status value={r.stage_status_value} /></Cell>
                      <Cell muted>{rupees(r.gstr2b.total_itc)}</Cell>
                      <Cell><Status value={r.reconciliation.status} /></Cell>
                      <Cell muted>{r.assigned_employee_name ?? '—'}</Cell>
                    </Row>
                  ))}
                </Table>
              ) : stage === 'gstr3b' ? (
                // §19 columns — the money and the payment state.
                <Table head={['Client', 'GSTIN', 'Period', 'Due', 'Liability', 'Eligible ITC', 'Net payable', 'Assigned', 'Reviewer', 'Status', 'Payment']}>
                  {d.items.map((r) => (
                    <Row key={r.id} status={r.stage_status_value} onClick={() => openCase.mutate(r)}>
                      <Cell>{r.client_name ?? '—'}</Cell>
                      <Cell muted><span className="font-mono text-12">{r.gstin}</span></Cell>
                      <Cell>{periodLabel(r.period)}</Cell>
                      <Cell muted><DueCell r={r} /></Cell>
                      <Cell muted>{rupees(r.gstr3b?.tax_liability)}</Cell>
                      <Cell muted>{rupees(r.gstr3b?.eligible_itc)}</Cell>
                      <Cell>{rupees(r.gstr3b?.net_payable)}</Cell>
                      <Cell muted>{r.assigned_employee_name ?? '—'}</Cell>
                      <Cell muted>{r.reviewer_employee_name ?? '—'}</Cell>
                      <Cell><Status value={r.stage_status_value} /></Cell>
                      <Cell muted>
                        {r.gstr3b?.payment_status === 'not_applicable' ? '—' : (r.gstr3b?.payment_status ?? '—')}
                      </Cell>
                    </Row>
                  ))}
                </Table>
              ) : (
                // §12 columns.
                <Table head={['Client', 'GSTIN', 'FY', 'Period', 'Due', 'Days', 'Assigned', 'Reviewer', 'Status', 'ARN']}>
                  {d.items.map((r) => (
                    <Row key={r.id} status={r.stage_status_value} onClick={() => openCase.mutate(r)}>
                      <Cell>{r.client_name ?? '—'}</Cell>
                      <Cell muted><span className="font-mono text-12">{r.gstin}</span></Cell>
                      <Cell muted>{r.financial_year}</Cell>
                      <Cell>{periodLabel(r.period)}</Cell>
                      <Cell muted>{r.stage_due_date ?? '—'}</Cell>
                      <Cell muted><DueCell r={r} /></Cell>
                      <Cell muted>{r.assigned_employee_name ?? '—'}</Cell>
                      <Cell muted>{r.reviewer_employee_name ?? '—'}</Cell>
                      <Cell><Status value={r.stage_status_value} /></Cell>
                      <Cell muted><span className="font-mono text-12">{r.gstr1?.arn ?? '—'}</span></Cell>
                    </Row>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        )}
      </QueryState>

      {/* ── Add one client's work for a period ─────────────────────────── */}
      <Modal
        open={adding}
        title={`Add ${meta.title}`}
        onClose={closeAdd}
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeAdd} className="h-9 px-3 text-13 border border-neutral-300 rounded">
              Cancel
            </button>
            <button
              type="button"
              disabled={add.isPending}
              onClick={() => {
                const body: Record<string, unknown> = {
                  gst_profile_id: form.gst_profile_id,
                  period: form.period,
                  assigned_employee_id: form.assigned_employee_id || undefined,
                  reviewer_employee_id: form.reviewer_employee_id || undefined,
                  status: form.status || undefined,
                };
                if (stage === 'gstr1') {
                  body.taxable_value = numF(form.taxable_value);
                  body.tax_amount = numF(form.tax_amount);
                } else if (stage === 'gstr3b') {
                  body.tax_liability = numF(form.tax_liability);
                  body.eligible_itc = numF(form.eligible_itc);
                  body.net_payable = numF(form.net_payable);
                } else {
                  body.available_date = form.available_date || undefined;
                  body.total_itc_igst = numF(form.total_itc_igst);
                }
                add.mutate(body);
              }}
              className="h-9 px-3 text-13 bg-neutral-900 text-white rounded disabled:opacity-50"
            >
              {add.isPending ? 'Adding…' : `Add ${meta.title}`}
            </button>
          </div>
        }
      >
        {errMsg ? (
          <div className="mb-3 text-13 text-red border-l-2 border-red pl-3 py-1">{errMsg}</div>
        ) : null}

        <Field
          label="Client"
          hint={clients.data && clients.data.items.length === 0
            ? 'No client has a GST profile yet — add the GSTIN on the client first.'
            : 'Only clients registered for GST appear here.'}
        >
          <select className={inputClass} value={form.gst_profile_id ?? ''} onChange={(e) => setF('gst_profile_id', e.target.value)}>
            <option value="">Choose a client…</option>
            {(clients.data?.items ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {(c.client_name ?? c.legal_name ?? c.gstin)} — {c.gstin}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Tax period">
          <select className={inputClass} value={form.period ?? ''} onChange={(e) => setF('period', e.target.value)}>
            {recentPeriods().map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>

        <Field label="Status">
          <select className={inputClass} value={form.status ?? ''} onChange={(e) => setF('status', e.target.value)}>
            <option value="">{stage === 'gstr2b' ? 'Expected' : 'Pending'}</option>
            {STAGE_STATUSES[stage].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-3">
          <Field label="Assigned employee">
            <select className={inputClass} value={form.assigned_employee_id ?? ''} onChange={(e) => setF('assigned_employee_id', e.target.value)}>
              <option value="">Use the client's default</option>
              {(employees.data?.items ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name ?? e.id}</option>)}
            </select>
          </Field>
          <Field label="Reviewer">
            <select className={inputClass} value={form.reviewer_employee_id ?? ''} onChange={(e) => setF('reviewer_employee_id', e.target.value)}>
              <option value="">Use the client's default</option>
              {(employees.data?.items ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name ?? e.id}</option>)}
            </select>
          </Field>
        </div>

        {/* Figures are optional — a period is usually opened before the
            numbers are known, so nothing here is required to add it. */}
        {stage === 'gstr1' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-3">
            <Field label="Taxable value (₹)"><input className={inputClass} inputMode="decimal" value={form.taxable_value ?? ''} onChange={(e) => setF('taxable_value', e.target.value)} /></Field>
            <Field label="Tax amount (₹)"><input className={inputClass} inputMode="decimal" value={form.tax_amount ?? ''} onChange={(e) => setF('tax_amount', e.target.value)} /></Field>
          </div>
        ) : stage === 'gstr3b' ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-x-3">
            <Field label="Tax liability (₹)"><input className={inputClass} inputMode="decimal" value={form.tax_liability ?? ''} onChange={(e) => setF('tax_liability', e.target.value)} /></Field>
            <Field label="Eligible ITC (₹)"><input className={inputClass} inputMode="decimal" value={form.eligible_itc ?? ''} onChange={(e) => setF('eligible_itc', e.target.value)} /></Field>
            <Field label="Net payable (₹)"><input className={inputClass} inputMode="decimal" value={form.net_payable ?? ''} onChange={(e) => setF('net_payable', e.target.value)} /></Field>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-3">
            <Field label="Available date"><input type="date" className={inputClass} value={form.available_date ?? ''} onChange={(e) => setF('available_date', e.target.value)} /></Field>
            <Field label="Total ITC — IGST (₹)"><input className={inputClass} inputMode="decimal" value={form.total_itc_igst ?? ''} onChange={(e) => setF('total_itc_igst', e.target.value)} /></Field>
          </div>
        )}
      </Modal>
    </div>
  );
}

export const Gstr1Page = () => <GstStagePage stage="gstr1" />;
export const Gstr2bPage = () => <GstStagePage stage="gstr2b" />;
export const Gstr3bPage = () => <GstStagePage stage="gstr3b" />;
