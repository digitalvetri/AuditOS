import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { workstationApi } from '@/modules/workstation/api';
import {
  Card, PageHeader, QueryState, Select, SimulatedNotice, Table, Row, Cell,
} from '@/modules/workstation/components';
import { einvoiceEwbApi } from './api';
import type {
  AlertBucket, EinvEwbMode, EinvEwbResponse, EwbAlertItem, IrnAlertItem, MissingIrnItem,
} from './types';
import { EInvoiceEwbHandoff } from './EInvoiceEwbHandoff';
import type { HandoffOperationId } from './handoffs';

/**
 * Which of the two sidebar entries is being viewed. A narrowing of the server's
 * `EinvEwbMode` — a screen is always one half, never the combined `both`.
 */
export type EinvEwbScreen = Extract<EinvEwbMode, 'einvoice' | 'ewb'>;

/**
 * The portal a screen hands off to, opened from the page header.
 *
 * These are the site ROOTS the firm supplied, and they are NOT the URLs
 * handoffs.ts opens — that file targets one named operation, so it goes
 * deeper (`/Login.aspx` for e-way bill) or elsewhere entirely (an
 * e-invoice operation opens the client's own IRP, einvoice1..6.gst.gov.in,
 * picked from `profile.irp`). The header link is just "take me to the
 * portal" and must not land the operator mid-flow, nor pin them to one IRP.
 * Both sets are correct for their purpose — do not collapse them.
 *
 * Partial so a screen without a portal simply renders no button.
 */
const PORTAL_LINK: Partial<Record<EinvEwbScreen, { url: string; label: string }>> = {
  einvoice: { url: 'https://einvoice.gst.gov.in/', label: 'E-Invoice Portal' },
  ewb: { url: 'https://ewaybillgst.gov.in/', label: 'E-Way Bill Portal' },
};

const MODE_COPY: Record<EinvEwbScreen, { title: string; subtitle: string }> = {
  einvoice: {
    title: 'E-Invoice',
    subtitle: 'Applicability, the 30-day reporting limit, and IRNs reconciled against the books.',
  },
  ewb: {
    title: 'E-Way Bill',
    subtitle: 'Validity, the 360-day distance cap, and e-way bills reconciled against invoices.',
  },
};

/**
 * Services › E-Invoice & E-Way Bill.
 *
 * One component, two screens: `/workstation/services/e-invoice` and
 * `/workstation/services/e-way-bill` both route here and share a single
 * fetch, but each shows ONLY its own half. They sit under separate sidebar
 * entries, so an employee who opened E-Way Bill is looking at a consignment
 * problem and should not have to read past IRN and AATO rows to find it.
 *
 * `mode` decides which half renders. It is a prop rather than a pathname
 * sniff so the routing stays declarative in App.tsx and the component is
 * testable in either mode.
 *
 * The rows here are MONITORING, not actions — the client generates IRNs
 * and e-way bills inside its own ERP, not us. We watch, we reconcile, we
 * escalate. See E-INVOICE-EWAYBILL.md §1 for the reframe that shapes the
 * whole page.
 */
export default function EInvoiceEwbPage({ mode }: { mode: EinvEwbScreen }) {
  const isEinvoice = mode === 'einvoice';
  const copy = MODE_COPY[mode];
  const portal = PORTAL_LINK[mode];

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
    queryKey: ['einvoice-ewb', effectiveClientId, mode],
    queryFn: () => einvoiceEwbApi.get(effectiveClientId, mode),
    enabled: !!effectiveClientId,
  });

  const [handoff, setHandoff] = useState<HandoffOperationId | null>(null);

  return (
    <div className="p-4 md:p-6 max-w-[1200px] mx-auto">
      <PageHeader
        title={copy.title}
        subtitle={copy.subtitle}
        action={portal ? (
          <a
            href={portal.url}
            target="_blank"
            rel="noopener noreferrer"
            className={
              'inline-flex items-center gap-2 h-10 px-4 text-14 font-medium rounded-md ' +
              'text-white bg-primary hover:bg-primaryHover'
            }
          >
            <ExternalLink size={16} strokeWidth={2} />
            Open {portal.label}
          </a>
        ) : undefined}
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
            {isEinvoice ? <ApplicabilityHeader data={data} /> : <EwbIdentityHeader data={data} />}

            {isEinvoice ? <EInvoiceMonitors data={data} /> : <EwbMonitors data={data} />}

            {/* Setup and reconciliation are per-mode too: the IRP row and the
                EWB API row each belong to one screen only. MFA guards the
                portal login behind both, so it shows on both. */}
            <Card title="Setup" right={<HandoffLinks onOpen={setHandoff} setup={data.setup} mode={mode} />}>
              <Table head={['Item', 'Status']}>
                {isEinvoice && <SetupRow label="IRP registration" entry={data.setup.irp_registration} />}
                {!isEinvoice && <SetupRow label="API access (e-way bill)" entry={data.setup.ewb_api_access} />}
                <SetupRow label="MFA" entry={data.setup.mfa} />
              </Table>
            </Card>

            <Card title="Reconciliation pull history">
              <Table head={['Month', isEinvoice ? 'E-Invoice' : 'E-Way Bill']}>
                {pullMonths(data.pulls.items).map((m) => {
                  const pull = isEinvoice ? m.einvoice : m.ewb;
                  return (
                    <Row key={m.periodMonth}>
                      <Cell>{humanMonth(m.periodMonth)}</Cell>
                      <Cell muted>{pull ? `${pull.record_count} records · ${humanDate(pull.run_at)}` : '—'}</Cell>
                    </Row>
                  );
                })}
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

/**
 * A half the server did not send. Reached only if a caller asks for one mode
 * and reads the other — better to say so than to render an empty table that
 * looks like "nothing to monitor".
 */
function MissingHalf({ half }: { half: string }) {
  return (
    <Card title={half}>
      <div className="px-4 py-6 text-13 text-neutral-500">
        This response did not include the {half} monitors.
      </div>
    </Card>
  );
}

/** The E-Invoice monitors. Rendered only on the E-Invoice screen. */
function EInvoiceMonitors({ data }: { data: EinvEwbResponse }) {
  const m = data.monitors.einvoice;
  const countdown = data.alerts.einvoice_30day_countdown;
  const missingIrn = data.alerts.b2b_invoices_without_irn;
  if (!m || !countdown || !missingIrn) return <MissingHalf half="E-Invoice" />;

  return (
    <Card title="E-Invoice">
      <Table head={['Monitor', 'Detail']}>
        <MonitorRow
          label="Approaching 30-day limit"
          bucket={countdown}
          detail={detailFor30Day(countdown, data.applicability.thirty_day_applies)}
        />
        <MonitorRow label="Reported this month" detail={`${m.reported_this_month} IRNs`} />
        <MonitorRow
          label="Cancelled"
          detail={
            m.cancelled_total > 0
              ? `${m.cancelled_total} · ${m.cancelled_within_window} within 24-hour window`
              : 'None'
          }
        />
        <MonitorRow
          label="B2B invoices without IRN"
          bucket={missingIrn}
          detail={detailForMissingIrn(missingIrn)}
        />
        <MonitorRow
          label="IRN vs GSTR-1"
          detail={m.reconciled_through
            ? `reconciled to ${humanMonth(m.reconciled_through)}`
            : 'not yet reconciled'}
        />
      </Table>
    </Card>
  );
}

/** The E-Way Bill monitors. Rendered only on the E-Way Bill screen. */
function EwbMonitors({ data }: { data: EinvEwbResponse }) {
  const m = data.monitors.ewb;
  const expiring = data.alerts.ewb_expiring_24h;
  const cap = data.alerts.ewb_approaching_360_cap;
  if (!m || !expiring || !cap) return <MissingHalf half="E-Way Bill" />;

  return (
    <Card title="E-Way Bill">
      <Table head={['Monitor', 'Detail']}>
        <MonitorRow
          label="Expiring within 24 hours"
          bucket={expiring}
          detail={detailForExpiring(expiring)}
        />
        <MonitorRow label="Generated this month" detail={`${m.generated_this_month}`} />
        <MonitorRow
          label="Approaching 360-day cap"
          bucket={cap}
          detail={detailForCap(cap)}
        />
        <MonitorRow label="Cancelled / rejected" detail={`${m.cancelled_or_rejected}`} />
        <MonitorRow
          label="EWB vs invoices"
          detail={m.reconciled_through
            ? `reconciled to ${humanMonth(m.reconciled_through)}`
            : 'not yet reconciled'}
        />
      </Table>
    </Card>
  );
}

/**
 * The E-Way Bill counterpart of the strip below. Deliberately carries NO AATO
 * or e-invoice applicability: the e-way bill obligation turns on the
 * consignment value, not on turnover, so quoting an AATO threshold here would
 * state a rule that does not govern this screen.
 */
function EwbIdentityHeader({ data }: { data: EinvEwbResponse }) {
  const p = data.profile;
  const api = p.ewb_api_enabled ? 'EWB API enabled' : 'EWB API not enabled';
  const gsp = p.ewb_gsp ? `via ${p.ewb_gsp}` : 'no GSP on record';
  const user = p.ewb_api_username ? `user ${p.ewb_api_username}` : 'no API user';
  const verified = p.ewb_verified_at
    ? `credentials verified ${humanDate(p.ewb_verified_at)}`
    : 'credentials not verified';
  const mfa = p.mfa_active ? 'MFA active' : 'MFA not confirmed';

  return (
    <Card>
      <div className="px-4 py-3 text-13 text-neutral-900">
        <div className="font-medium">{api} · {gsp} · {verified}</div>
        <div className="text-neutral-500 text-12 mt-1">{user} · {mfa}</div>
      </div>
    </Card>
  );
}

/** The applicability + IRP identity strip for the E-Invoice screen. */
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

function SetupRow({ label, entry }: {
  label: string;
  /** Undefined when the response omitted this row — render nothing. */
  entry?: { state: 'ready' | 'pending' | 'attention'; label: string };
}) {
  if (!entry) return null;
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
  setup, onOpen, mode,
}: {
  setup: EinvEwbResponse['setup'];
  onOpen: (op: HandoffOperationId) => void;
  mode: EinvEwbScreen;
}) {
  return (
    <div className="flex items-center gap-3">
      {mode === 'einvoice' && setup.irp_registration && setup.irp_registration.state !== 'ready' && (
        <button
          type="button" className="text-12 text-neutral-700 underline hover:text-neutral-900"
          onClick={() => onOpen('einv.irp.register')}
        >Register IRP</button>
      )}
      {mode === 'ewb' && setup.ewb_api_access && setup.ewb_api_access.state !== 'ready' && (
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
