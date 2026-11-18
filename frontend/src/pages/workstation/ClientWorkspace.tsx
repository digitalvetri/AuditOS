import { useState } from 'react';
// Government-portal autofill (Phase 1) — remove with src/modules/portalAutofill.
import { GovernmentPortalsCard } from '@/modules/portalAutofill/GovernmentPortals';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Copy, Mail, Phone, Pin, PinOff, Plus, User } from 'lucide-react';
import { EntityHeader, HeaderTag, MetaItem, PageTabs, headerBtn, headerBtnPrimary, type HeaderStat } from '@/components/EntityHeader';
import { Avatar } from '@/components/viz';
import { usePinnedClients } from '@/modules/workstation/pins';
import { paymentSummaryApi } from '@/modules/paymentSummary/api';
import { gstApi } from '@/modules/workstation/gst/api';
import { gstHistory, lastPeriods } from '@/modules/workstation/clientInsights';
import { istToday } from '@/modules/dashboardV2/brief';
import { formatINR } from '@/modules/dashboardV2/format';
import { workstationApi } from '@/modules/workstation/api';
import {
  Card, Cell, Detail, Field, Modal, QueryState, Row, SimulatedNotice, Status,
  Table, fieldErrors, inputClass, textareaClass,
} from '@/modules/workstation/components';
import type {
  Activity, ClientDetail, ClientService, EwayResponse,
  GstProfile, FollowUp, ListResponse, Task,
} from '@/modules/workstation/types';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { fmtDate, fmtDateTime, fmtTime, inr } from '@/lib/format';
import { can } from '@/platform/rbac/can';
import { GstChecklist } from '@/modules/workstation/checklist/GstChecklist';
import { quotationsApi } from '@/modules/workstation/quotations/api';
import { ClientInvoicesTab } from './invoices/ClientInvoicesTab';
import { engagementApi, type EngagementLetter } from '@/modules/workstation/engagement/api';
import { useAuth } from '@/platform/auth/AuthContext';
import { BillingSliceCard } from '@/modules/zpay/BillingSliceCard';
import { ClientDocumentFolders } from '@/modules/workstation/documents/ClientDocumentFolders';
import { ClientShareLinkButton } from '@/modules/workstation/documents/ClientShareLink';
import { useSetDocumentStatus } from '@/modules/workstation/documents/StatusSelect';
import {
  SendRequestDialog, type RequestChannel, type RequestTarget,
} from '@/modules/workstation/documents/SendRequestDialog';
import { ChevronRight } from 'lucide-react';
import { OrganizationBadge } from '@/modules/workstation/organization/badges';
import { AssignedStaffDetails } from '@/modules/workstation/AssignedStaff';
import { EditClientDetailsButton } from '@/modules/workstation/EditClientDetails';
import { ClientContactsCard } from '@/modules/workstation/ClientContacts';
import { ClientExitDetail } from '@/modules/workstation/ClientExit';
import { LevelBanner, OrganizationOverview } from '@/modules/workstation/organization/OrganizationOverview';
import { OrganizationClients } from '@/modules/workstation/organization/OrganizationClients';
import { OrganizationDocuments } from '@/modules/workstation/organization/OrganizationDocuments';
import { ClientObligationsTab } from '@/modules/compliance/ClientObligationsTab';

/**
 * THE CLIENT WORKSPACE (§7.3).
 *
 * Each tab is a nested route segment rather than local state, so a tab is
 * deep-linkable and the breadcrumb reads correctly. A tab the caller cannot
 * read is not rendered — and its endpoint answers 403 regardless, because
 * hiding a tab is not an access control.
 */
const TABS = [
  { key: '', label: 'Overview', perm: 'workstation.client.read' },
  { key: 'details', label: 'Company Details', perm: 'workstation.client.read' },
  { key: 'services', label: 'Services', perm: 'workstation.service.read' },
  { key: 'gst', label: 'GST', perm: 'workstation.gst.read' },
  { key: 'compliance', label: 'Compliance', perm: 'workstation.compliance.read' },
  { key: 'quotations', label: 'Quotations', perm: 'workstation.quotation.read' },
  { key: 'invoices', label: 'Invoices', perm: 'workstation.invoice.read' },
  { key: 'engagement', label: 'Engagement', perm: 'workstation.engagement.read' },
  { key: 'eway', label: 'E-way Bills', perm: 'workstation.eway.read' },
  { key: 'documents', label: 'Documents', perm: 'workstation.document.read' },
  { key: 'follow-ups', label: 'Follow-ups', perm: 'workstation.followup.read' },
  { key: 'tasks', label: 'Tasks', perm: 'workstation.service.read' },
  { key: 'activity', label: 'Activity', perm: 'workstation.client.read' },
] as const;

/**
 * An organization's workspace adds organization-level tabs in front of its
 * own client tabs. Its own Documents tab is relabelled so it is never
 * confused with the combined view of its clients' documents.
 */
const ORG_TABS = [
  { key: 'organization', label: 'Organization Overview', perm: 'workstation.client.read' },
  { key: 'organization-clients', label: 'Organization Clients', perm: 'workstation.client.read' },
  { key: 'organization-documents', label: 'All Client Documents', perm: 'workstation.document.read' },
] as const;
/**
 * Tabs an organization's client does not have: these live on the organization.
 * Quotations stay per client (they are billed in the organization's name).
 */
const ORG_LEVEL_ONLY = new Set(['engagement']);

/**
 * Service tabs: shown only when the client has taken a matching service, or
 * already has data for the tab, so nothing recorded becomes unreachable.
 */
const SERVICE_TABS: Record<string, { codes: string[]; has: (c: ClientDetail) => boolean; message: string }> = {
  gst: {
    codes: ['GST_FILING', 'GST_REGISTRATION', 'E_INVOICE'],
    has: (c) => !!c.gst_data_exists,
    message: 'This client has no GST service. Add it from Services.',
  },
  eway: {
    codes: ['EWAY_BILL', 'E_INVOICE'],
    has: (c) => (c.eway_bill_count ?? 0) > 0,
    message: 'This client has no E-way Bill service. Add it from Services.',
  },
};
function serviceTabShown(client: ClientDetail, key: string): boolean {
  const rule = SERVICE_TABS[key];
  if (!rule) return true;
  // An older API without the fields: show the tab rather than hide data.
  if (client.service_codes === undefined) return true;
  return rule.codes.some((code) => client.service_codes!.includes(code)) || rule.has(client);
}

const ORG_LABELS: Record<string, string> = {
  '': 'Profile', documents: 'Organization Documents', activity: 'Organization Activity', details: 'Organization Details',
};

export function ClientWorkspacePage() {
  const { id = '', tab = '' } = useParams();
  const { session } = useAuth();
  const role = session?.role.code;

  const query = useQuery({
    queryKey: ['workstation', 'client', id],
    queryFn: () => workstationApi.getClient(id),
  });

  const allowed = (perm: string) => can(role, perm as Parameters<typeof can>[1], 'self');

  return (
    <div className="">
      <QueryState query={query}>
        {(client: ClientDetail) => {
          const tabs = [
            ...(client.is_organization ? ORG_TABS : []),
            ...TABS.map((t) => client.is_organization && ORG_LABELS[t.key] ? { ...t, label: ORG_LABELS[t.key] } : t)
              // Engagement letters are agreed with the organization, so its
              // clients do not get them (quotations and invoices stay per client).
              .filter((t) => !(client.organization && ORG_LEVEL_ONLY.has(t.key)))
              .filter((t) => serviceTabShown(client, t.key)),
          ].filter((t) => allowed(t.perm));
          return (
          <>
            <OrganizationBreadcrumb client={client} />
            <ClientHeader client={client} />
            <PageTabs tabs={tabs.map((t) => ({
              to: `/workstation/clients/${client.id}${t.key ? `/${t.key}` : ''}`,
              label: t.label,
              end: t.key === '',
              count: t.key === 'documents' ? client.document_count
                : t.key === 'follow-ups' ? client.follow_up_count
                : t.key === 'organization-clients' ? client.child_client_count
                : undefined,
            }))} />

            {tab === 'organization' && client.is_organization ? <OrganizationOverview org={client} /> : null}
            {tab === 'organization-clients' && client.is_organization ? <OrganizationClients org={client} /> : null}
            {tab === 'organization-documents' && client.is_organization ? <OrganizationDocuments org={client} /> : null}
            {tab === '' && client.organization ? <div className="mb-4"><LevelBanner level="client" name={client.company_name} org={client.organization} /></div> : null}
            {tab === '' ? <GovernmentPortalsCard clientId={client.id} clientName={client.company_name} /> : null}
            {tab === '' ? <OverviewTab client={client} /> : null}
            {tab === 'details' ? <DetailsTab client={client} /> : null}
            {tab === 'services' ? <ServicesTab client={client} /> : null}
            {tab === 'gst' ? (serviceTabShown(client, 'gst') ? <GstTab client={client} /> : <ServiceTabHidden client={client} tab="gst" />) : null}
            {tab === 'compliance' ? <ClientObligationsTab clientId={client.id} entityType={client.business_type} /> : null}
            {tab === 'quotations' ? <QuotationsTab client={client} /> : null}
            {tab === 'invoices' ? <ClientInvoicesTab client={client} /> : null}
            {tab === 'engagement' && !client.organization ? <EngagementTab client={client} /> : null}
            {client.organization && ORG_LEVEL_ONLY.has(tab) ? <OrgLevelOnly client={client} tab={tab} /> : null}
            {tab === 'eway' ? (serviceTabShown(client, 'eway') ? <EwayTab client={client} /> : <ServiceTabHidden client={client} tab="eway" />) : null}
            {tab === 'documents' ? <DocumentsTab client={client} /> : null}
            {tab === 'follow-ups' ? <FollowUpsTab client={client} /> : null}
            {tab === 'tasks' ? <TasksTab client={client} /> : null}
            {tab === 'activity' ? <ActivityTab client={client} /> : null}
          </>
          );
        }}
      </QueryState>
    </div>
  );
}

/** A deep link to a service tab the client has no service or data for. */
function ServiceTabHidden({ client, tab }: { client: ClientDetail; tab: string }) {
  return (
    <Card>
      <div className="p-5 text-13 text-neutral-700">
        {SERVICE_TABS[tab]?.message}{' '}
        <Link to={`/workstation/clients/${client.id}/services`} className="text-primary underline">Open Services</Link>
      </div>
    </Card>
  );
}

/** A deep link to Engagement on an organization's client. */
function OrgLevelOnly({ client, tab }: { client: ClientDetail; tab: string }) {
  const org = client.organization!;
  const what = 'Engagement letters';
  return (
    <Card>
      <div className="p-5 text-13 text-neutral-700">
        {what} for {client.company_name} are made on its organization.{' '}
        <Link to={`/workstation/clients/${org.id}/${tab}`} className="text-primary underline">Open {org.name} → {what}</Link>
      </div>
    </Card>
  );
}

/**
 * Clients → ABC Business Solutions → ABC DV Client 2. Only organizations
 * and their clients get one, so a normal client's page is unchanged.
 */
function OrganizationBreadcrumb({ client }: { client: ClientDetail }) {
  if (!client.is_organization && !client.organization) return null;
  const sep = <ChevronRight size={13} className="text-neutral-400" />;
  return (
    <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-1 text-12 text-neutral-500">
      <Link to="/workstation/clients" className="hover:text-neutral-900">Clients</Link>
      {sep}
      {client.organization ? (
        <>
          <Link to={`/workstation/clients/${client.organization.id}/organization`} className="hover:text-neutral-900">{client.organization.name}</Link>
          {sep}
          <span className="text-neutral-900 font-medium">{client.company_name}</span>
          <span className="ml-1 text-11 uppercase tracking-[0.05em] text-neutral-400">client level</span>
        </>
      ) : (
        <>
          <span className="text-neutral-900 font-medium">{client.company_name}</span>
          <span className="ml-1 text-11 uppercase tracking-[0.05em] text-primary">organization level</span>
        </>
      )}
    </nav>
  );
}

// ── Header ────────────────────────────────────────────────────────────────
/**
 * Who the client is and where they stand: identity and contact, then the
 * figures that matter — services, documents, money owed (finance roles) and
 * GST periods overdue in the last six (GST roles). Same data and gates as
 * the Clients list, read from the same caches.
 */
function ClientHeader({ client }: { client: ClientDetail }) {
  const { session } = useAuth();
  const role = session?.role.code;
  const toast = useToast();
  const { isPinned, toggle } = usePinnedClients();
  const seesBilling = can(role, 'payment_summary.read', 'organisation');
  const seesGst = can(role, 'workstation.gst.read', 'self');
  const money = useQuery({ queryKey: ['payment-summary'], queryFn: () => paymentSummaryApi.summary(), enabled: seesBilling });
  const periods = lastPeriods(istToday(), 6);
  const gstQueries = useQueries({
    queries: periods.map((p) => ({ queryKey: ['gst', 'client-dashboard', p], queryFn: () => gstApi.clientDashboard(p), enabled: seesGst, staleTime: 120_000 })),
  });
  const gst = seesGst && gstQueries.every((q) => q.isSuccess) ? gstHistory(periods, gstQueries.map((q) => q.data)) : undefined;
  const row = gst?.byClient.get(client.id);
  const gstOverdue = row ? [...row.values()].filter((p) => p.state === 'overdue').length : null;
  const m = money.data?.clients.find((c) => c.client_id === client.id);
  const primary = client.contacts.find((c) => c.is_primary) ?? client.contacts[0];
  const pinned = isPinned(client.id);
  const services = useQuery({
    queryKey: ['workstation', 'client', client.id, 'services'],
    queryFn: () => workstationApi.clientServices(client.id),
    enabled: can(role, 'workstation.service.read', 'self'),
  });

  const stats: HeaderStat[] = [
    { label: 'Services', value: services.data ? services.data.items.length : '—' },
    { label: 'Documents', value: client.document_count },
    { label: 'Follow-ups', value: client.follow_up_count },
  ];
  if (seesBilling) stats.push(m && m.overdue_paise > 0
    ? { label: 'Overdue', value: formatINR(m.overdue_paise / 100), tone: 'bad' }
    : { label: 'Outstanding', value: m ? formatINR(m.pending_paise / 100) : '₹0' });
  if (seesGst && gstOverdue !== null) stats.push({
    label: 'GST overdue', value: `${gstOverdue} of 6`, tone: gstOverdue ? 'bad' : 'ok',
    hint: 'Return periods in the last six with a GSTR-1 or GSTR-3B past due and not filed',
  });

  return (
    <EntityHeader
      name={client.company_name}
      square
      idLine={<>
        <span>{client.client_id}</span>
        {client.gstin ? <button type="button" title="Copy GSTIN" className="inline-flex items-center gap-1 hover:text-ink"
          onClick={async () => { try { await navigator.clipboard.writeText(client.gstin!); toast.push('success', 'GSTIN copied'); } catch { /* blocked */ } }}>
          · GSTIN {client.gstin} <Copy size={11} />
        </button> : null}
        {client.pan ? <span>· PAN {client.pan}</span> : null}
      </>}
      chips={<>
        <Status value={client.status} />
        {client.is_organization ? <OrganizationBadge count={client.child_client_count} /> : null}
        {client.organization ? (
          <Link to={`/workstation/clients/${client.organization.id}/organization`} className="hover:opacity-80">
            <HeaderTag tone="teal">Organization: {client.organization.name}</HeaderTag>
          </Link>
        ) : null}
        {client.business_type ? <HeaderTag>{client.business_type}</HeaderTag> : null}
        {client.onboarding_date ? <HeaderTag>Client since {new Date(client.onboarding_date).getFullYear()}</HeaderTag> : null}
        {m && m.overdue_paise > 0 ? <HeaderTag tone="bad">● Payment overdue</HeaderTag> : null}
      </>}
      meta={<>
        <MetaItem icon={<User size={14} />}>{primary?.name ?? client.contact_person}</MetaItem>
        {(primary?.phone ?? client.contact_number) ? <MetaItem icon={<Phone size={14} />} href={`tel:${primary?.phone ?? client.contact_number}`}>{primary?.phone ?? client.contact_number}</MetaItem> : null}
        {(primary?.email ?? client.email) ? <MetaItem icon={<Mail size={14} />} href={`mailto:${primary?.email ?? client.email}`}>{primary?.email ?? client.email}</MetaItem> : null}
        {client.account_manager ? (
          <span className="inline-flex items-center gap-2">
            <Avatar name={client.account_manager.full_name} size={20} />Managed by {client.account_manager.full_name}
            {client.secondary_manager ? <span className="text-inkFaint">· second staff {client.secondary_manager.full_name}</span> : null}
          </span>
        ) : null}
      </>}
      actions={<>
        <button type="button" onClick={() => toggle({ id: client.id, name: client.company_name })} className={headerBtn} aria-pressed={pinned}>
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}{pinned ? 'Unpin' : 'Pin'}
        </button>
        {can(role, 'workstation.invoice.manage', 'self') ? (
          <Link to={`/workstation/invoices/new?client_id=${client.id}`} className={headerBtnPrimary}><Plus size={14} />New invoice</Link>
        ) : null}
      </>}
      stats={stats}
    />
  );
}

// ── Overview (§7.3) ───────────────────────────────────────────────────────
function OverviewTab({ client }: { client: ClientDetail }) {
  const { session } = useAuth();
  const canSeeBilling = can(session?.role.code, 'integrations.access', 'organisation');
  const services = useQuery({
    queryKey: ['workstation', 'client', client.id, 'services'],
    queryFn: () => workstationApi.clientServices(client.id),
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
      <Card
        title="Services"
        right={<Link to={`/workstation/clients/${client.id}/services`} className="text-13 text-primary hover:underline">All services</Link>}
      >
        <QueryState query={services} empty="No services added yet.">
          {(data: ListResponse<ClientService>) => (
            <ul className="p-4 flex flex-wrap gap-2">
              {data.items.map((s) => (
                <li key={s.id} className="inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 py-1">
                  <span className="text-13 font-medium text-neutral-900">{s.service_name}</span>
                  <Status value={s.status} />
                  {s.due_date ? <span className="text-12 text-neutral-500">due {fmtDate(s.due_date)}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </Card>

      <div className="space-y-6">
        <Card title="Client status">
          <div className="p-4">
            <Detail label="Status" value={<Status value={client.status} />} />
            <Detail label="Onboarded" value={fmtDate(client.onboarding_date)} />
            <ClientExitDetail client={client} />
            <AssignedStaffDetails client={client} />
            <Detail label="Documents" value={`${client.document_count}`} />
            <Detail label="Follow-ups" value={`${client.follow_up_count}`} />
            {client.source_lead_id ? (
              <Detail
                label="Source"
                value={
                  <a className="underline" href={`/workstation/leads/${client.source_lead_id}`}>
                    Converted from a lead
                  </a>
                }
              />
            ) : null}
          </div>
        </Card>

        {/* Spec §6.3: hidden entirely (not greyed) from users without the
            finance permission. `canSeeBilling` short-circuits both the
            render and any accompanying API request. */}
        {canSeeBilling ? <BillingSliceCard clientId={client.id} /> : null}
      </div>
    </div>
  );
}

// ── Company details (§7.3) ────────────────────────────────────────────────
function DetailsTab({ client }: { client: ClientDetail }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <Card title="Basic" right={<EditClientDetailsButton client={client} />}>
        <div className="p-4">
          <Detail label="Company Name" value={client.company_name} />
          <Detail label="Legal Name" value={client.legal_name ?? '—'} />
          <Detail label="Business Type" value={client.business_type ?? '—'} />
          <Detail label="Contact Person" value={client.contact_person} />
          <Detail label="Contact Number" value={client.contact_number} />
          {client.contacts.filter((c) => !c.is_primary).map((c) => (
            <Detail
              key={c.id}
              label={c.name + (c.designation ? ` · ${c.designation}` : '')}
              value={c.phone}
            />
          ))}
          <Detail label="Email" value={client.email ?? '—'} />
          <Detail label="Address" value={client.address ?? '—'} />
        </div>
      </Card>
      <Card title="Tax" right={<EditClientDetailsButton client={client} />}>
        <div className="p-4">
          <Detail label="GSTIN" value={client.gstin ?? '—'} />
          <Detail label="PAN" value={client.pan ?? '—'} />
          <Detail label="TAN" value={client.tan ?? '—'} />
          <Detail label="CIN / LLPIN" value={client.cin ?? '—'} />
        </div>
      </Card>
      <Card title="Internal">
        <div className="p-4">
          <Detail label="Client ID" value={client.client_id} />
          <Detail label="Account Manager" value={client.account_manager?.full_name ?? '—'} />
          <Detail label="Assigned Team" value={client.assigned_team ?? '—'} />
          <Detail label="Onboarding Date" value={fmtDate(client.onboarding_date)} />
          <Detail label="Client Status" value={<Status value={client.status} />} />
          <Detail
            label="Client Portal"
            value={client.portal_enabled ? 'Enabled' : 'Not enabled — portal not yet built'}
          />
        </div>
      </Card>
      <ClientContactsCard client={client} />
    </div>
  );
}

// ── Services (§7.4) ───────────────────────────────────────────────────────
const SERVICE_STATUSES = [
  'not_started', 'documents_pending', 'in_progress', 'under_review',
  'ready', 'submitted', 'completed', 'failed', 'on_hold',
];

function ServicesTab({ client }: { client: ClientDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { session } = useAuth();
  const [addOpen, setAddOpen] = useState(false);

  const services = useQuery({
    queryKey: ['workstation', 'client', client.id, 'services'],
    queryFn: () => workstationApi.clientServices(client.id),
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      workstationApi.updateService(id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', 'Service updated.');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const canManage = can(session?.role.code, 'workstation.service.manage', 'self');

  return (
    <>
      <Card
        title="Services"
        right={canManage ? <Button variant="primary" onClick={() => setAddOpen(true)}>Assign Services</Button> : undefined}
      >
        <QueryState query={services} empty="No services added yet.">
          {(data: ListResponse<ClientService>) => (
            <Table head={['Service', 'Due Date', 'Status', 'Last Updated']}>
              {data.items.map((s) => (
                <Row key={s.id} status={s.status}>
                  <Cell className="font-medium">{s.service_name}</Cell>
                  <Cell muted>
                    {canManage ? (
                      <input
                        type="date"
                        aria-label={`Due date for ${s.service_name ?? 'service'}`}
                        defaultValue={s.due_date ?? ''}
                        key={s.due_date ?? ''}
                        onBlur={(e) => {
                          const next = e.target.value || null;
                          if (next !== (s.due_date ?? null)) update.mutate({ id: s.id, patch: { due_date: next } });
                        }}
                        className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded focus:outline-none focus:border-gold"
                      />
                    ) : (s.due_date ? fmtDate(s.due_date) : '—')}
                  </Cell>
                  <Cell>
                    {canManage ? (
                      <select
                        value={s.status}
                        onChange={(e) => update.mutate({ id: s.id, patch: { status: e.target.value } })}
                        className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded focus:outline-none focus:border-gold"
                      >
                        {SERVICE_STATUSES.map((v) => (
                          <option key={v} value={v}>
                            {v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Status value={s.status} />
                    )}
                  </Cell>
                  <Cell muted>{fmtDate(s.updated_at)}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>
      <AssignServicesModal
        client={client}
        open={addOpen}
        onClose={() => setAddOpen(false)}
        live={new Set((services.data?.items ?? []).filter((s) => s.status !== 'completed' && s.status !== 'failed').map((s) => s.service_id))}
      />
    </>
  );
}

/**
 * Tick several services at once. Services are added unassigned: work reaches
 * people through Tasks and the GST Filing page, not from here.
 */
function AssignServicesModal({ client, open, onClose, live }: {
  client: ClientDetail; open: boolean; onClose: () => void; live: Set<string>;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const catalog = useQuery({ queryKey: ['workstation', 'catalog'], queryFn: workstationApi.serviceCatalog, enabled: open });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [form, setForm] = useState({ due_date: '', notes: '', filing_frequency: 'monthly' });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const items = catalog.data?.items ?? [];
  const gstFilingPicked = items.some((s) => s.code === 'GST_FILING' && picked.has(s.id));
  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const close = () => {
    setPicked(new Set());
    setForm({ due_date: '', notes: '', filing_frequency: 'monthly' });
    create.reset();
    onClose();
  };

  const create = useMutation({
    mutationFn: () => workstationApi.addClientServices(client.id, {
      service_ids: [...picked],
      due_date: form.due_date || undefined,
      notes: form.notes || undefined,
      filing_frequency: gstFilingPicked ? form.filing_frequency : undefined,
    }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      const n = r.items.length;
      const skipped = r.skipped.length ? ` ${r.skipped.map((x) => x.service_name).join(', ')} already added.` : '';
      toast.push('success', `${n} ${n === 1 ? 'service' : 'services'} added.${skipped}`);
      close();
    },
  });
  const e = fieldErrors(create.error);
  const n = picked.size;

  return (
    <Modal
      open={open} title="Assign Services" onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={n === 0 || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Adding…' : `Add ${n} ${n === 1 ? 'service' : 'services'}`}
          </Button>
        </>
      }
    >
      <fieldset className="mb-3">
        <legend className="block text-12 font-medium text-neutral-500 mb-1">Services</legend>
        <QueryState query={catalog} empty="No services in the catalog yet.">
          {() => (
            <ul className="max-h-[320px] overflow-y-auto rounded border border-neutral-200">
              {items.map((s) => {
                const have = live.has(s.id);
                return (
                  <li key={s.id} className="border-b border-neutral-200 last:border-0">
                    <label className={`flex items-center gap-3 px-3 py-2 text-13 ${have ? 'text-neutral-500' : 'text-neutral-900 cursor-pointer hover:bg-neutral-50'}`}>
                      <input
                        type="checkbox"
                        checked={have || picked.has(s.id)}
                        disabled={have}
                        onChange={() => toggle(s.id)}
                      />
                      <span className="flex-1">{s.name}</span>
                      {have ? <span className="text-12 text-neutral-500">already added</span> : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </QueryState>
        {e.service_ids
          ? <span className="block text-12 text-red mt-1">{e.service_ids}</span>
          : <span className="block text-12 text-neutral-500 mt-1">Services are added unassigned. Give the work to people through Tasks or the GST Filing page.</span>}
      </fieldset>
      {gstFilingPicked && (
        <Field label="Files GST returns" error={e.filing_frequency} hint="Quarterly for QRMP clients. Applies when the client is first enrolled; change it later on the client's GST profile.">
          <select className={inputClass} value={form.filing_frequency} onChange={(ev) => set('filing_frequency', ev.target.value)}>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly (QRMP)</option>
          </select>
        </Field>
      )}
      <Field label="Due Date" error={e.due_date} hint="Optional. Applies to every ticked service.">
        <input className={inputClass} type="date" value={form.due_date} onChange={(ev) => set('due_date', ev.target.value)} />
      </Field>
      <Field label="Notes" error={e.notes} hint="Optional. Applies to every ticked service.">
        <textarea className={textareaClass} rows={3} value={form.notes} onChange={(ev) => set('notes', ev.target.value)} />
      </Field>
    </Modal>
  );
}

// ── GST (§7.3) ────────────────────────────────────────────────────────────
/**
 * Workstation → Clients → [Client] → GST.
 *
 * The CHECKLIST is what this tab is for (what GST work does this client
 * require, what is its status, who is on it, when is it due). The GST profile
 * and the filing log that were here before it are kept below, unchanged —
 * they are reference, not work management.
 */
function GstTab({ client }: { client: ClientDetail }) {
  return (
    <div className="space-y-6">
      <GstChecklist clientId={client.id} clientName={client.company_name} />
      <GstProfileSection client={client} />
    </div>
  );
}

/**
 * This client's quotations, and the way to start another one.
 *
 * The row's action follows the quotation's state rather than being the same
 * everywhere: a DRAFT has not gone anywhere, so the useful move is to carry on
 * building it; anything SENT is a document the client has already seen and is
 * frozen server-side, so it opens read-only. "New quotation" stays available
 * in both cases — a sent quotation is a reason to write the next one, not a
 * reason to stop.
 */
function QuotationsTab({ client }: { client: ClientDetail }) {
  const navigate = useNavigate();
  const { session } = useAuth();
  const mayWrite = can(session?.role.code, 'workstation.quotation.manage', 'self');

  const quotations = useQuery({
    queryKey: ['workstation', 'client', client.id, 'quotations'],
    queryFn: () => quotationsApi.list({ client_id: client.id, limit: 50 }),
  });

  const build = () => navigate(`/workstation/quotations/new?client_id=${client.id}`);

  return (
    <Card
      title="Quotations"
      right={mayWrite ? <Button onClick={build}>New quotation</Button> : undefined}
    >
      <QueryState query={quotations} empty="No quotations for this client yet.">
        {(data) => (
          <Table head={['Quotation', 'Subject', 'Date', 'Valid until', 'Status', 'Total', '']}>
            {data.items.map((q) => {
              const draft = q.status === 'draft';
              return (
                <Row
                  key={q.id}
                  status={q.status}
                  onClick={() => navigate(`/workstation/quotations/${q.id}`)}
                >
                  <Cell>{q.quotation_code}</Cell>
                  <Cell>{q.subject || '—'}</Cell>
                  <Cell>{fmtDate(q.quote_date)}</Cell>
                  <Cell>{q.valid_until ? fmtDate(q.valid_until) : '—'}</Cell>
                  <Cell><Status value={q.status} /></Cell>
                  <Cell>{inr(q.total_paise)}</Cell>
                  <Cell>
                    <button
                      type="button"
                      className="text-13 text-primary hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(draft && mayWrite
                          ? `/workstation/quotations/${q.id}/edit`
                          : `/workstation/quotations/${q.id}`);
                      }}
                    >
                      {draft && mayWrite ? 'Continue building' : 'View'}
                    </button>
                  </Cell>
                </Row>
              );
            })}
          </Table>
        )}
      </QueryState>
    </Card>
  );
}


function GstProfileSection({ client }: { client: ClientDetail }) {
  const gst = useQuery({
    queryKey: ['workstation', 'client', client.id, 'gst'],
    queryFn: () => workstationApi.clientGst(client.id),
  });

  return (
    <QueryState query={gst}>
      {(profile: GstProfile | null) =>
        !profile ? (
          <Card><div className="px-4 py-6 text-13 text-neutral-500">This client is not GST-registered in JNS Accounting Solutions.</div></Card>
        ) : (
          <div className="space-y-6">
            <Card title="GST profile">
              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-x-6">
                <div>
                  <Detail label="GSTIN" value={profile.gstin} />
                  <Detail label="Registration Status" value={<Status value={profile.registration_status} />} />
                  <Detail label="Filing Frequency" value={profile.filing_frequency} />
                </div>
                <div>
                  <Detail label="GST Service Status" value={<Status value={profile.service_status} />} />
                  <Detail label="Last Filing" value={profile.last_filed_at ? fmtDate(profile.last_filed_at) : '—'} />
                  <Detail label="Next Due Date" value={profile.next_due_date ? fmtDate(profile.next_due_date) : '—'} />
                  <Detail label="Assigned Employee" value={profile.assigned_employee?.full_name ?? '—'} />
                </div>
              </div>
            </Card>

            <Card title="Filings">
              <Table head={['Period', 'Return Type', 'Status', 'Filing Date', 'Assigned To', 'Remarks']}>
                {profile.filings.map((f) => (
                  <Row key={f.id} status={f.status}>
                    <Cell>{f.period}</Cell>
                    <Cell muted>{f.return_type}</Cell>
                    <Cell><Status value={f.status} /></Cell>
                    <Cell muted>{f.filed_at ? fmtDate(f.filed_at) : '—'}</Cell>
                    <Cell muted>{f.assigned_employee?.full_name ?? '—'}</Cell>
                    <Cell muted>{f.remarks ?? '—'}</Cell>
                  </Row>
                ))}
              </Table>
            </Card>

            <SimulatedNotice>
              Filing status is recorded manually in JNS Accounting Solutions. There is no GSTN connection —
              nothing here is filed with the government by this system.
            </SimulatedNotice>
          </div>
        )
      }
    </QueryState>
  );
}

// ── E-way bills (§7.3) — simulated ────────────────────────────────────────
function EwayTab({ client }: { client: ClientDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { session } = useAuth();
  const [open, setOpen] = useState(false);

  const eway = useQuery({
    queryKey: ['workstation', 'client', client.id, 'eway'],
    queryFn: () => workstationApi.clientEway(client.id),
  });

  const [form, setForm] = useState({ document_no: '', document_date: '', to_party_name: '', to_gstin: '', value: '' });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const generate = useMutation({
    mutationFn: () => workstationApi.generateEway(client.id, {
      document_no: form.document_no,
      document_date: form.document_date,
      to_party_name: form.to_party_name || undefined,
      to_gstin: form.to_gstin || undefined,
      value: Number(form.value || 0),
    }),
    onSuccess: (row) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', `${row.ewb_no} generated (simulated).`);
      setOpen(false);
    },
  });
  const e = fieldErrors(generate.error);
  const canGenerate = can(session?.role.code, 'workstation.eway.generate', 'self');

  return (
    <QueryState query={eway}>
      {(data: EwayResponse) => (
        <div className="space-y-4">
          <SimulatedNotice>
            <strong className="font-medium">E-way Bill Service · SIMULATED.</strong>{' '}
            {data.connection.notice}
          </SimulatedNotice>

          <Card
            title="E-way bills"
            right={canGenerate ? <Button variant="primary" onClick={() => setOpen(true)}>Generate</Button> : undefined}
          >
            {data.items.length === 0 ? (
              <div className="px-4 py-6 text-13 text-neutral-500">No e-way bills for this client.</div>
            ) : (
              <Table head={['EWB No', 'Document', 'Date', 'Consignee', 'Value', 'Status', 'Valid Until']}>
                {data.items.map((b) => (
                  <Row key={b.id} status={b.status}>
                    <Cell className="font-medium">{b.ewb_no}</Cell>
                    <Cell muted>{b.document_no}</Cell>
                    <Cell muted>{fmtDate(b.document_date)}</Cell>
                    <Cell muted>{b.to_party_name ?? '—'}</Cell>
                    <Cell>{inr(b.value_paise)}</Cell>
                    <Cell><Status value={b.status} /></Cell>
                    <Cell muted>{b.valid_until ? fmtDate(b.valid_until) : '—'}</Cell>
                  </Row>
                ))}
              </Table>
            )}
          </Card>

          <Modal
            open={open} title="Generate E-way Bill (simulated)" onClose={() => setOpen(false)}
            footer={
              <>
                <Button onClick={() => setOpen(false)}>Cancel</Button>
                <Button variant="primary" disabled={generate.isPending} onClick={() => generate.mutate()}>Generate</Button>
              </>
            }
          >
            <SimulatedNotice>
              This generates a local number for demonstration. No request is sent to the
              government e-way bill portal.
            </SimulatedNotice>
            <div className="h-4" />
            <Field label="Document No" error={e.document_no}>
              <input className={inputClass} value={form.document_no} onChange={(ev) => set('document_no', ev.target.value)} />
            </Field>
            <Field label="Document Date" error={e.document_date}>
              <input className={inputClass} type="date" value={form.document_date} onChange={(ev) => set('document_date', ev.target.value)} />
            </Field>
            <Field label="Consignee" error={e.to_party_name}>
              <input className={inputClass} value={form.to_party_name} onChange={(ev) => set('to_party_name', ev.target.value)} />
            </Field>
            <Field label="Consignee GSTIN" error={e.to_gstin}>
              <input className={inputClass} value={form.to_gstin} onChange={(ev) => set('to_gstin', ev.target.value.toUpperCase())} />
            </Field>
            <Field label="Value (₹)" error={e.value}>
              <input className={inputClass} type="number" min="0" value={form.value} onChange={(ev) => set('value', ev.target.value)} />
            </Field>
          </Modal>
        </div>
      )}
    </QueryState>
  );
}

// ── Documents (§7.6) ──────────────────────────────────────────────────────
function DocumentsTab({ client }: { client: ClientDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { session } = useAuth();
  const role = session?.role.code;
  const [requestOpen, setRequestOpen] = useState(false);

  const categories = useQuery({ queryKey: ['workstation', 'doc-categories'], queryFn: workstationApi.documentCategories });

  const upload = useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => workstationApi.uploadDocumentFile(id, file),
    onSuccess: (doc) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', `${doc.name} uploaded as v${doc.version}.`);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const verify = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) =>
      workstationApi.verifyDocument(id, approve, approve ? undefined : 'Rejected on review.'),
    onSuccess: (doc) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', `${doc.name} ${doc.status}.`);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const setStatus = useSetDocumentStatus();
  const [sending, setSending] = useState<{ target: RequestTarget; channel: RequestChannel } | null>(null);

  const canManage = can(role, 'workstation.document.manage', 'self');
  const canVerify = can(role, 'workstation.document.verify', 'self');

  return (
    <>
      {/* Client → Folder → Document: everything the firm holds for this client. */}
      <ClientDocumentFolders
        clientId={client.id}
        headerRight={(
          <>
            <ClientShareLinkButton client={client} canManage={canManage} />
            {canManage ? <Button variant="primary" onClick={() => setRequestOpen(true)}>Request Document</Button> : null}
          </>
        )}
        actions={{
          canManage,
          canVerify,
          onUpload: (id, file) => upload.mutate({ id, file }),
          onVerify: (id) => verify.mutate({ id, approve: true }),
          onStatus: (id, status) => setStatus.mutate({ id, status }),
        }}
      />

      <RequestDocumentModal
        client={client}
        categories={categories.data?.items ?? []}
        open={requestOpen}
        onClose={() => setRequestOpen(false)}
        onSend={(doc, channel) => setSending({
          channel,
          target: { documentId: doc.id, documentName: doc.name, financialYear: doc.financial_year, clientId: client.id },
        })}
      />
      <SendRequestDialog
        target={sending?.target ?? null}
        channel={sending?.channel ?? 'whatsapp'}
        onClose={() => setSending(null)}
      />
    </>
  );
}

type SendVia = RequestChannel | 'none';

function RequestDocumentModal({
  client, categories, open, onClose, onSend,
}: {
  client: ClientDetail;
  categories: { id: string; name: string }[];
  open: boolean;
  onClose: () => void;
  /** After the request is saved: open the WhatsApp / email message for it. */
  onSend: (doc: { id: string; name: string; financial_year: string | null }, channel: RequestChannel) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', category_id: '', financial_year: '2026-27' });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const [via, setVia] = useState<SendVia>(client.contact_number ? 'whatsapp' : client.email ? 'email' : 'none');

  const create = useMutation({
    mutationFn: () => workstationApi.requestDocument(client.id, {
      name: form.name, category_id: form.category_id,
      financial_year: form.financial_year || undefined, status: 'requested',
    }),
    onSuccess: (doc) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      onClose();
      setForm((f) => ({ ...f, name: '' }));
      if (via === 'none') toast.push('success', 'Document request recorded.');
      else onSend(doc, via);
    },
  });
  const e = fieldErrors(create.error);
  const sendLabel = via === 'whatsapp' ? 'Next: WhatsApp message' : via === 'email' ? 'Next: Email message' : 'Save Request';

  return (
    <Modal
      open={open} title="Request Document" onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>{sendLabel}</Button>
        </>
      }
    >
      <Field label="Client" error={undefined}>
        <input className={inputClass} value={`${client.client_id} · ${client.company_name}`} readOnly />
      </Field>
      <Field label="Category" error={e.category_id}>
        <select className={inputClass} value={form.category_id} onChange={(ev) => set('category_id', ev.target.value)}>
          <option value="">Select a category…</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Document Required" error={e.name}>
        <input className={inputClass} value={form.name} onChange={(ev) => set('name', ev.target.value)} placeholder="e.g. Bank Statement — August 2026" />
      </Field>
      <Field label="Financial Year" error={e.financial_year}>
        <input className={inputClass} value={form.financial_year} onChange={(ev) => set('financial_year', ev.target.value)} />
      </Field>
      <Field label="Send to client">
        <div className="flex border border-neutral-200 w-fit">
          {([
            ['whatsapp', 'WhatsApp'],
            ['email', 'Email'],
            ['none', "Don't send"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setVia(key)}
              className={`h-8 px-3 text-13 ${via === key ? 'bg-neutral-900 text-white' : 'bg-white text-neutral-700 hover:bg-neutral-50'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-12 text-neutral-500 mt-1.5">
          {via === 'whatsapp'
            ? (client.contact_number ? `To ${client.contact_person} on ${client.contact_number}. You can review the message before it goes.` : 'No phone number on this client — you can type one in the next step.')
            : via === 'email'
              ? (client.email ? `To ${client.email}. You can review the message before it goes.` : 'No email on this client — you can type one in the next step.')
              : 'The request is only recorded here; nothing is sent to the client.'}
        </p>
      </Field>
    </Modal>
  );
}

// ── Follow-ups · Tasks · Activity ─────────────────────────────────────────
function FollowUpsTab({ client }: { client: ClientDetail }) {
  const query = useQuery({
    queryKey: ['workstation', 'client', client.id, 'follow-ups'],
    queryFn: () => workstationApi.listFollowUps({ client_id: client.id }),
  });
  const navigate = useNavigate();
  return (
    <>
    {client.organization ? (
      <div className="mb-3 rounded-lg bg-primary/5 border border-primary/15 px-3 py-2 text-12 text-neutral-700">
        Follow-ups for {client.company_name} are sent to its organization,{' '}
        <Link to={`/workstation/clients/${client.organization.id}/follow-ups`} className="underline">{client.organization.name}</Link>,
        and are listed there too.
      </div>
    ) : null}
    <Card
      title={client.is_organization ? 'Follow-ups — organization and its clients' : 'Follow-ups'}
      right={
        <button type="button" className="text-12 text-neutral-500 hover:text-neutral-900"
          onClick={() => navigate('/workstation/follow-ups')}>
          All follow-ups
        </button>
      }
    >
      <QueryState query={query} empty="No follow-ups for this client.">
        {(data: ListResponse<FollowUp>) => (
          <Table head={client.is_organization
            ? ['Follow-up', 'For client', 'Contact', 'Type', 'Date', 'Time', 'Assigned To', 'Status']
            : ['Follow-up', 'Contact', 'Type', 'Date', 'Time', 'Assigned To', 'Status']}>
            {data.items.map((f) => (
              <Row key={f.id} status={f.status}>
                <Cell className="font-medium">{f.title}</Cell>
                {client.is_organization ? (
                  <Cell muted>
                    {f.client_id === client.id
                      ? <span className="text-primary font-medium">Organization</span>
                      : <Link to={`/workstation/clients/${f.client_id}`} className="hover:underline">{f.subject_name}</Link>}
                  </Cell>
                ) : null}
                <Cell muted>
                  {f.contact_name ?? '—'}{f.contact_number ? ` · ${f.contact_number}` : ''}
                  {f.sent_to_organization && !client.is_organization ? <span className="block text-11 text-primary">{f.sent_to_organization.name}</span> : null}
                </Cell>
                <Cell muted>{f.type.replace(/_/g, ' ')}</Cell>
                <Cell muted>{fmtDate(f.scheduled_at)}</Cell>
                <Cell muted>{fmtTime(f.scheduled_at)}</Cell>
                <Cell muted>{f.assigned_employee?.full_name ?? '—'}</Cell>
                <Cell><Status value={f.status} /></Cell>
              </Row>
            ))}
          </Table>
        )}
      </QueryState>
    </Card>
    </>
  );
}

function TasksTab({ client }: { client: ClientDetail }) {
  const query = useQuery({
    queryKey: ['workstation', 'client', client.id, 'tasks'],
    queryFn: () => workstationApi.clientTasks(client.id),
  });
  return (
    <Card title="Tasks">
      <QueryState query={query} empty="No tasks for this client. Tasks are created inside a service.">
        {(data: ListResponse<Task>) => (
          <Table head={['Task', 'Assigned To', 'Due Date', 'Status']}>
            {data.items.map((t) => (
              <Row key={t.id} status={t.status}>
                <Cell className="font-medium">{t.title}</Cell>
                <Cell muted>{t.assigned_employee?.full_name ?? '—'}</Cell>
                <Cell muted>{t.due_date ? fmtDate(t.due_date) : '—'}</Cell>
                <Cell><Status value={t.status} /></Cell>
              </Row>
            ))}
          </Table>
        )}
      </QueryState>
    </Card>
  );
}

function ActivityTab({ client }: { client: ClientDetail }) {
  const query = useQuery({
    queryKey: ['workstation', 'client', client.id, 'activity'],
    queryFn: () => workstationApi.clientActivity(client.id),
  });
  return (
    <Card title="Activity">
      <QueryState query={query} empty="No activity recorded yet.">
        {(data: ListResponse<Activity>) => (
          <ol className="p-4 space-y-3">
            {data.items.map((a) => (
              <li key={a.id} className="border-l-2 border-neutral-200 pl-3">
                <div className="text-13 text-neutral-900">{a.description}</div>
                <div className="text-12 text-neutral-500 mt-1">
                  {a.actor?.full_name ?? 'System'} · {fmtDateTime(a.created_at)}
                </div>
              </li>
            ))}
          </ol>
        )}
      </QueryState>
    </Card>
  );
}

/**
 * This client's engagement letters — drafts, sent and accepted together —
 * and the way to start another one.
 *
 * Every row opens the builder. A draft opens ready to edit; a letter that
 * has gone out opens frozen as it was sent, with Actions → Duplicate letter
 * as the way to prepare new terms. "New engagement letter" arrives in the
 * builder with this client already chosen.
 */
function EngagementTab({ client }: { client: ClientDetail }) {
  const navigate = useNavigate();
  const { session } = useAuth();
  const mayWrite = can(session?.role.code, 'workstation.engagement.manage', 'self');

  const letters = useQuery({
    queryKey: ['engagement.list', 'client', client.id],
    queryFn: () => engagementApi.list({ client_id: client.id, limit: 100 }),
  });

  const open = (l: EngagementLetter) => navigate(`/workstation/engagement/${l.id}/edit`);
  const counts = (items: EngagementLetter[]) => ({
    draft: items.filter((l) => l.status === 'draft').length,
    sent: items.filter((l) => l.status === 'sent').length,
    accepted: items.filter((l) => l.status === 'accepted').length,
  });

  return (
    <Card
      title="Engagement letters"
      right={mayWrite ? (
        <Button onClick={() => navigate(`/workstation/engagement/new?client_id=${client.id}`)}>New engagement letter</Button>
      ) : undefined}
    >
      <QueryState query={letters} empty="No engagement letters for this client yet.">
        {(data) => {
          const c = counts(data.items);
          return (
            <>
              <div className="px-4 pt-3 pb-1 text-12 text-neutral-500 flex gap-4">
                <span>{c.draft} draft</span>
                <span>{c.sent} sent</span>
                <span>{c.accepted} accepted</span>
              </div>
              <Table head={['Reference', 'Subject', 'Date', 'Financial year', 'Status', '']}>
                {data.items.map((l) => {
                  const draft = l.status === 'draft';
                  return (
                    <Row key={l.id} status={l.status} onClick={() => open(l)}>
                      <Cell className="font-medium">{l.letter_code}</Cell>
                      <Cell>{l.subject || '—'}</Cell>
                      <Cell muted>{fmtDate(l.letter_date)}</Cell>
                      <Cell muted>{l.financial_year ?? '—'}</Cell>
                      <Cell><Status value={l.status} /></Cell>
                      <Cell>
                        <span className="inline-flex gap-3">
                          <button type="button" className="text-13 text-primary hover:underline"
                            onClick={(e) => { e.stopPropagation(); open(l); }}>
                            {draft && mayWrite ? 'Continue building' : 'Open'}
                          </button>
                          <button type="button" className="text-13 text-primary hover:underline"
                            onClick={(e) => { e.stopPropagation(); navigate(`/workstation/engagement/${l.id}/preview`); }}>
                            Preview
                          </button>
                        </span>
                      </Cell>
                    </Row>
                  );
                })}
              </Table>
            </>
          );
        }}
      </QueryState>
    </Card>
  );
}
