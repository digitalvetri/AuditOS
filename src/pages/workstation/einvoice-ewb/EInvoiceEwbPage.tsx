import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { workstationApi } from '@/modules/workstation/api';
import {
  Card, PageHeader, QueryState, Select, SimulatedNotice, Table, Row, Cell,
} from '@/modules/workstation/components';
import { einvoiceEwbApi } from './api';
import type {
  AlertBucket, EinvEwbResponse, EwbAlertItem, IrnAlertItem, MissingIrnItem,
} from './types';
import { EInvoiceEwbHandoff } from './EInvoiceEwbHandoff';
import type { HandoffOperationId } from './handoffs';

/**
 * Services › E-Invoice & E-Way Bill.
 *
 * The one screen for both sidebar entries: `/workstation/services/e-invoice`
 * and `/workstation/services/e-way-bill` route here. Both because the firm
 * cares about the same set of monitors (applicability, alerts, setup,
 * reconciliation) whether it's e-invoicing or e-way-billing that's failing.
 *
 * The rows here are MONITORING, not actions — the client generates IRNs
 * and e-way bills inside its own ERP, not us. We watch, we reconcile, we
 * escalate. See E-INVOICE-EWAYBILL.md §1 for the reframe that shapes the
 * whole page.
 */
export default function EInvoiceEwbPage() {
  const clientsQuery = useQuery({
    queryKey: ['workstation', 'clients', { for: 'einvoice-ewb' }],
    queryFn: () => workstationApi.listClients({}),
  });

  const clientOptions = useMemo(() => {
    const items = clientsQuery.data?.items ?? [];
    return items.map((c) => ({ value: c.id, label: `${c.client_id} · ${c.company_name}` }));
  }, [clientsQuery.data]);

  const [clientId, setClientId] = useState<string>('');
  // Default to the first client once they load — the page is useless
  // without a selection and forcing a click is friction.
  const effectiveClientId = clientId || clientOptions[0]?.value || '';

  const dataQuery = useQuery({
    queryKey: ['einvoice-ewb', effectiveClientId],
    queryFn: () => einvoiceEwbApi.get(effectiveClientId),
    enabled: !!effectiveClientId,
  });

  const [handoff, setHandoff] = useState<HandoffOperationId | null>(null);

  return (
    <div className="p-4 md:p-6 max-w-[1200px] mx-auto">
      <PageHeader
        title="E-Invoice & E-Way Bill"
        subtitle="Monitor applicability, alert on irreversible failures, and reconcile against the books."
      />

      <div className="mb-3">
        <Select
          label="Client"
          value={clientId || effectiveClientId}
          onChange={setClientId}
          options={clientOptions}
          allLabel="Pick a client"
        />
      </div>

      <QueryState query={dataQuery}>
        {(data: EinvEwbResponse | undefined) => !data ? (
          // Fires when clientsQuery is still loading (so effectiveClientId
          // is '' and dataQuery is disabled). QueryState considers a
          // disabled query "not loading", so we have to render the
          // fallback ourselves.
          <div className="px-4 py-6 text-13 text-neutral-500">
            {clientsQuery.isLoading ? 'Loading clients…' : 'Pick a client to see monitors.'}
          </div>
        ) : (
          <div className="space-y-3">
            <ApplicabilityHeader data={data} />

            <Card title="E-Invoice">
              <Table head={['Monitor', 'Detail']}>
                <MonitorRow
                  label="Approaching 30-day limit"
                  bucket={data.alerts.einvoice_30day_countdown}
                  detail={detailFor30Day(data.alerts.einvoice_30day_countdown, data.applicability.thirty_day_applies)}
                />
                <MonitorRow
                  label="Reported this month"
                  detail={`${data.monitors.einvoice.reported_this_month} IRNs`}
                />
                <MonitorRow
                  label="Cancelled"
                  detail={
                    data.monitors.einvoice.cancelled_total > 0
                      ? `${data.monitors.einvoice.cancelled_total} · ${data.monitors.einvoice.cancelled_within_window} within 24-hour window`
                      : 'None'
                  }
                />
                <MonitorRow
                  label="B2B invoices without IRN"
                  bucket={data.alerts.b2b_invoices_without_irn}
                  detail={detailForMissingIrn(data.alerts.b2b_invoices_without_irn)}
                />
                <MonitorRow
                  label="IRN vs GSTR-1"
                  detail={data.monitors.einvoice.reconciled_through
                    ? `reconciled to ${humanMonth(data.monitors.einvoice.reconciled_through)}`
                    : 'not yet reconciled'}
                />
              </Table>
            </Card>

            <Card title="E-Way Bill">
              <Table head={['Monitor', 'Detail']}>
                <MonitorRow
                  label="Expiring within 24 hours"
                  bucket={data.alerts.ewb_expiring_24h}
                  detail={detailForExpiring(data.alerts.ewb_expiring_24h)}
                />
                <MonitorRow
                  label="Generated this month"
                  detail={`${data.monitors.ewb.generated_this_month}`}
                />
                <MonitorRow
                  label="Approaching 360-day cap"
                  bucket={data.alerts.ewb_approaching_360_cap}
                  detail={detailForCap(data.alerts.ewb_approaching_360_cap)}
                />
                <MonitorRow
                  label="Cancelled / rejected"
                  detail={`${data.monitors.ewb.cancelled_or_rejected}`}
                />
                <MonitorRow
                  label="EWB vs invoices"
                  detail={data.monitors.ewb.reconciled_through
                    ? `reconciled to ${humanMonth(data.monitors.ewb.reconciled_through)}`
                    : 'not yet reconciled'}
                />
              </Table>
            </Card>

            <Card title="Setup" right={<HandoffLinks onOpen={setHandoff} setup={data.setup} />}>
              <Table head={['Item', 'Status']}>
                <SetupRow label="IRP registration" entry={data.setup.irp_registration} />
                <SetupRow label="API access (e-way bill)" entry={data.setup.ewb_api_access} />
                <SetupRow label="MFA" entry={data.setup.mfa} />
              </Table>
            </Card>

            <Card title="Reconciliation pull history">
              <Table head={['Month', 'E-Invoice', 'E-Way Bill']}>
                {pullMonths(data.pulls.items).map((m) => (
                  <Row key={m.periodMonth}>
                    <Cell>{humanMonth(m.periodMonth)}</Cell>
                    <Cell muted>{m.einvoice ? `${m.einvoice.record_count} records · ${humanDate(m.einvoice.run_at)}` : '—'}</Cell>
                    <Cell muted>{m.ewb ? `${m.ewb.record_count} records · ${humanDate(m.ewb.run_at)}` : '—'}</Cell>
                  </Row>
                ))}
              </Table>
              <div className="px-3 py-2 text-11 text-neutral-500 border-t border-neutral-200">
                The portal retains only the last six months of data. The scheduled pull keeps our store ahead of that.
              </div>
            </Card>

            <SimulatedNotice>{data.connection.notice}</SimulatedNotice>
          </div>
        )}
      </QueryState>

      <EInvoiceEwbHandoff
        operation={handoff}
        clientId={effectiveClientId}
        profile={dataQuery.data?.profile}
        applicability={dataQuery.data?.applicability}
        onClose={() => setHandoff(null)}
      />
    </div>
  );
}

/** The applicability + IRP identity strip that sits above every section. */
function ApplicabilityHeader({ data }: { data: EinvEwbResponse }) {
  const latest = data.profile.aato_by_year[data.profile.aato_by_year.length - 1] ?? null;
  const aatoLabel = latest
    ? `AATO ${formatCrores(latest.aato_paise)} (FY ${latest.fy})`
    : 'AATO not on record';
  const applicableLabel = data.applicability.applicable ? 'APPLICABLE' : 'NOT applicable';
  const thirtyDayLabel = data.applicability.thirty_day_applies ? '30-day rule APPLIES' : '30-day rule does not apply';
  const irp = data.profile.irp ?? 'no IRP set';
  const route = data.profile.einvoice_api_route === 'gsp' ? 'API via GSP'
    : data.profile.einvoice_api_route === 'direct' ? 'API direct'
    : data.profile.einvoice_api_route === 'erp' ? 'API via ERP'
    : 'no API route';
  const mfa = data.profile.mfa_active ? 'MFA active' : 'MFA not confirmed';

  return (
    <Card>
      <div className="px-4 py-3 text-13 text-neutral-900">
        <div className="font-medium">{aatoLabel} · e-invoicing {applicableLabel} · {thirtyDayLabel}</div>
        <div className="text-neutral-500 text-12 mt-1">IRP: {irp} · {route} · {mfa}</div>
      </div>
    </Card>
  );
}

/** A single monitor row. If `bucket` is given, its status colours the row. */
function MonitorRow({
  label, detail, bucket,
}: {
  label: string;
  detail: string;
  bucket?: AlertBucket<unknown>;
}) {
  const statusValue = bucket && bucket.count > 0
    ? (bucket.status === 'problem' ? 'failed' : 'attention')
    : undefined;
  return (
    <Row status={statusValue}>
      <Cell>{label}</Cell>
      <Cell muted={!statusValue}>{detail}</Cell>
    </Row>
  );
}

function SetupRow({ label, entry }: { label: string; entry: { state: 'ready' | 'pending' | 'attention'; label: string } }) {
  const statusValue = entry.state === 'attention' ? 'attention'
    : entry.state === 'ready' ? undefined
    : 'awaiting';
  return (
    <Row status={statusValue}>
      <Cell>{label}</Cell>
      <Cell muted={entry.state === 'ready'}>{entry.label}</Cell>
    </Row>
  );
}

function HandoffLinks({
  setup, onOpen,
}: {
  setup: EinvEwbResponse['setup'];
  onOpen: (op: HandoffOperationId) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      {setup.irp_registration.state !== 'ready' && (
        <button
          type="button" className="text-12 text-neutral-700 underline hover:text-neutral-900"
          onClick={() => onOpen('einv.irp.register')}
        >Register IRP</button>
      )}
      {setup.ewb_api_access.state !== 'ready' && (
        <button
          type="button" className="text-12 text-neutral-700 underline hover:text-neutral-900"
          onClick={() => onOpen('ewb.api.enable')}
        >Enable EWB API</button>
      )}
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────
function formatCrores(paise: string): string {
  const n = Number(paise);
  if (!Number.isFinite(n)) return '₹ —';
  const crores = n / 100 / 10_000_000;
  const rounded = crores >= 10 ? crores.toFixed(1) : crores.toFixed(2);
  return `₹${rounded} Cr`;
}

function humanMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}
function humanDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

function detailFor30Day(b: AlertBucket<IrnAlertItem>, applicable: boolean): string {
  if (!applicable) return 'The 30-day rule does not apply to this client';
  if (b.count === 0) return 'No documents in the alert window';
  const soonest = b.items[0];
  const s = soonest.days_left === 1 ? 'day' : 'days';
  return `${b.count} invoice${b.count === 1 ? '' : 's'} · earliest expires in ${soonest.days_left} ${s} · after day 30 there is no remedy`;
}

function detailForMissingIrn(b: AlertBucket<MissingIrnItem>): string {
  if (b.count === 0) return 'None found in the latest reconciliation window';
  return `${b.count} found in the latest reconciliation`;
}

function detailForExpiring(b: AlertBucket<EwbAlertItem>): string {
  if (b.count === 0) return 'None expiring in the next 24 hours';
  const soonest = b.items[0];
  const hours = soonest.hours_to_expiry ?? 0;
  const inHours = hours > 0 ? `expires in ${Math.max(1, Math.floor(hours))} h` : `expired ${Math.abs(Math.ceil(hours))} h ago`;
  return `${b.count} in transit · ${inHours} · extend up to 8 h before or after expiry`;
}

function detailForCap(b: AlertBucket<EwbAlertItem>): string {
  if (b.count === 0) return 'None approaching the 360-day cap';
  const soonest = b.items[0];
  const d = soonest.days_to_cap ?? 0;
  if (d <= 0) return `${b.count} · already past the 360-day cap — no extension possible`;
  return `${b.count} · extension window closes in ${d} day${d === 1 ? '' : 's'}`;
}

interface PullMonthRow {
  periodMonth: string;
  einvoice?: { record_count: number; run_at: string };
  ewb?: { record_count: number; run_at: string };
}
function pullMonths(items: EinvEwbResponse['pulls']['items']): PullMonthRow[] {
  const map = new Map<string, PullMonthRow>();
  for (const it of items) {
    const row = map.get(it.period_month) ?? { periodMonth: it.period_month };
    if (it.kind === 'einvoice') row.einvoice = { record_count: it.record_count, run_at: it.run_at };
    if (it.kind === 'ewb') row.ewb = { record_count: it.record_count, run_at: it.run_at };
    map.set(it.period_month, row);
  }
  return Array.from(map.values()).sort((a, b) => (a.periodMonth < b.periodMonth ? 1 : -1));
}
