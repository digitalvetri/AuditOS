/**
 * Per-service AssistedHandoff page (v1).
 *
 * Implements the spec §1 pattern: "Open the GST portal and log in as the
 * client" → click-path breadcrumb → copy-ready field sheet → capture the
 * output. Client selection, real field values and the credential vault are
 * deferred to the follow-up engine work — this page is the shape.
 */
import { useMemo, useState } from 'react';
import { useParams, useSearchParams, Link, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarRange,
  Check,
  ChevronRight,
  ClipboardCopy,
  ExternalLink,
  Users,
} from 'lucide-react';
import { workstationApi } from '@/modules/workstation/api';
import { findGstService, SHAPE_TINT } from './services';
import { CredentialVault, CredentialsNotNeededNote, type VaultClient } from './CredentialVault';

export function GstServiceHandoff() {
  const { slug } = useParams<{ slug: string }>();
  const [params, setParams] = useSearchParams();
  const service = slug ? findGstService(slug) : undefined;

  const selectedClientId = params.get('client') ?? '';
  const clientsQuery = useQuery({
    queryKey: ['workstation', 'clients', { for: 'gst-handoff' }],
    queryFn: () => workstationApi.listClients({}),
  });
  const clients = clientsQuery.data?.items ?? [];
  const selectedClient = useMemo<VaultClient | null>(() => {
    if (!selectedClientId) return null;
    const c = clients.find((cc) => cc.id === selectedClientId);
    return c ? { id: c.id, name: c.company_name, gstin: c.gstin } : null;
  }, [selectedClientId, clients]);

  if (!service) {
    return <Navigate to="/workstation/services/gst" replace />;
  }

  const Icon = service.icon;
  const tint = SHAPE_TINT[service.shape];

  const setClient = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set('client', id);
    else next.delete('client');
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/workstation/services/gst"
          className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900"
        >
          <ArrowLeft size={14} strokeWidth={2} />
          All GST services
        </Link>
      </div>

      {/* Header */}
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <span
            className="inline-flex items-center justify-center w-12 h-12 rounded-lg shrink-0"
            style={{ backgroundColor: tint.bg, color: tint.fg }}
            aria-hidden
          >
            <Icon size={22} strokeWidth={1.75} />
          </span>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">Workstation · Services · GST</span>
              <span
                className="inline-flex items-center h-5 px-2 text-11 font-medium rounded-md"
                style={{ backgroundColor: tint.bg, color: tint.fg }}
              >
                {tint.label}
              </span>
            </div>
            <h1 className="text-20 font-semibold text-neutral-900 mt-1">
              {service.name} <span className="text-neutral-500 font-medium text-16 ml-2">{service.form}</span>
            </h1>
            <p className="text-13 text-neutral-500 mt-1 max-w-[720px]">{service.summary}</p>
          </div>
        </div>
      </header>

      {/* Client picker — drives the credential vault and field sheet. */}
      <section className="bg-white border border-neutral-200 rounded-lg shadow-card p-5">
        <div className="flex items-start gap-3 flex-wrap">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-md bg-neutral-100 text-neutral-700 shrink-0" aria-hidden>
            <Users size={18} strokeWidth={1.75} />
          </span>
          <div className="flex-1 min-w-[240px]">
            <label htmlFor="gst-client-picker" className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">
              Client
            </label>
            <select
              id="gst-client-picker"
              value={selectedClientId}
              onChange={(e) => setClient(e.target.value)}
              disabled={clientsQuery.isLoading}
              className="w-full h-10 px-3 text-14 bg-white border border-neutral-300 rounded-md focus:outline-none focus:border-gold"
            >
              <option value="">— Select a client —</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.company_name}{c.gstin ? ' · ' + c.gstin : ''}
                </option>
              ))}
            </select>
          </div>
          {selectedClient ? (
            <div className="text-12 text-neutral-500 min-w-[200px]">
              <div><span className="text-neutral-500">Client:</span> <span className="text-neutral-900 font-medium">{selectedClient.name}</span></div>
              {selectedClient.gstin ? <div className="font-mono">GSTIN {selectedClient.gstin}</div> : <div>No GSTIN on record</div>}
            </div>
          ) : (
            <div className="text-12 text-neutral-500 min-w-[200px]">
              Values in the vault and field sheet fill in once a client is selected.
            </div>
          )}
        </div>
      </section>

      {/* Workspace shortcut for services with a workspace shape */}
      {service.shape !== 'retainer' ? (
        <section className="bg-white border border-neutral-200 rounded-lg shadow-card p-5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <span className="inline-flex items-center justify-center w-10 h-10 rounded-md bg-neutral-100 text-neutral-700" aria-hidden>
              <CalendarRange size={18} strokeWidth={1.75} />
            </span>
            <div>
              <div className="text-14 font-semibold text-neutral-900">
                {service.shape === 'recurring' ? 'Period board' : 'Case pipeline'}
              </div>
              <div className="text-12 text-neutral-500">
                {service.shape === 'recurring'
                  ? 'One obligation per client per period — track status, filing progress and ARNs.'
                  : service.shape === 'externally-triggered'
                    ? 'Cases arrive from the weekly notice-discovery task. Track replies and deadlines.'
                    : 'One case per client, stage-driven. Registration, amendment or cancellation.'}
              </div>
            </div>
          </div>
          <Link
            to={`/workstation/services/gst/${service.slug}/workspace`}
            className="inline-flex items-center gap-2 h-9 px-4 text-13 font-medium text-white bg-primary hover:bg-primaryHover rounded-md"
          >
            {service.shape === 'recurring' ? 'Open period board' : 'Open case pipeline'}
          </Link>
        </section>
      ) : null}

      {/* What the firm actually does */}
      <section className="bg-white border border-neutral-200 rounded-lg shadow-card p-5">
        <h2 className="text-13 font-semibold uppercase tracking-[0.06em] text-neutral-900">
          What the firm actually does
        </h2>
        <p className="text-13 text-neutral-700 mt-2 leading-relaxed">{service.detail}</p>
      </section>

      {/* Step 1 — Open portal + log in */}
      <StepCard
        n={1}
        title="Open the GST portal and log in as the client"
        subtitle={
          service.preLogin
            ? 'Deep link — no session required.'
            : 'This is a post-login page. Log in as the client first; the click path below is the guide from the portal home.'
        }
      >
        <a
          href={service.portalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 h-10 px-4 text-14 font-medium text-white bg-primary hover:bg-primaryHover rounded-md"
        >
          <ExternalLink size={16} strokeWidth={2} />
          {service.portalLabel}
        </a>
        <div className="mt-4">
          {service.preLogin ? <CredentialsNotNeededNote /> : <CredentialVault client={selectedClient} />}
        </div>
      </StepCard>

      {/* Step 2 — Click path */}
      <StepCard
        n={2}
        title="Follow the click path inside the portal"
        subtitle={service.navPath.length ? undefined : 'No portal navigation — the destination is an external IRP or third-party integration.'}
      >
        {service.navPath.length ? (
          <nav aria-label="Portal click path" className="flex flex-wrap items-center gap-1 text-13">
            {service.navPath.map((step, i) => (
              <div key={step} className="flex items-center gap-1">
                <span className="inline-flex items-center h-8 px-3 rounded-md border border-neutral-200 bg-neutral-50 text-neutral-800 font-medium">
                  {step}
                </span>
                {i < service.navPath.length - 1 ? (
                  <ChevronRight size={14} strokeWidth={2} className="text-neutral-400" />
                ) : null}
              </div>
            ))}
          </nav>
        ) : (
          <p className="text-13 text-neutral-500">
            Direct link opens the IRP; no in-portal navigation applies.
          </p>
        )}
      </StepCard>

      {/* Step 3 — Field sheet */}
      {service.fieldSheet?.length ? (
        <StepCard
          n={3}
          title="Copy-ready field sheet"
          subtitle={
            selectedClient
              ? 'Values that can be resolved from the selected client fill in automatically. Others populate once the engine wires per-service data.'
              : 'Pick a client above to auto-fill values that live on the client record. Others populate with engine follow-up.'
          }
          action={
            <CopyAllButton
              fields={service.fieldSheet.map((f) => ({
                label: f.label,
                value: resolveFieldValue(f.label, selectedClient),
              }))}
              serviceName={service.name}
              clientName={selectedClient?.name}
            />
          }
        >
          <ul className="divide-y divide-neutral-100">
            {service.fieldSheet.map((f) => (
              <FieldSheetRow key={f.label} label={f.label} hint={f.hint} client={selectedClient} />
            ))}
          </ul>
        </StepCard>
      ) : null}

      {/* Step 4 — Capture the output */}
      {service.capture?.length ? (
        <StepCard
          n={service.fieldSheet?.length ? 4 : 3}
          title="Capture the output"
          subtitle="Values recorded back into JNS Accounting Solutions after the portal step completes. Persistence is follow-up work."
        >
          <ul className="divide-y divide-neutral-100">
            {service.capture.map((c) => (
              <li key={c.key} className="flex items-center justify-between gap-4 py-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-14 text-neutral-900">{c.label}</span>
                  {c.required ? (
                    <span className="text-11 uppercase tracking-[0.06em] text-danger">Required</span>
                  ) : null}
                </div>
                <span className="text-12 text-neutral-500 font-mono">{c.key}</span>
              </li>
            ))}
          </ul>
        </StepCard>
      ) : null}
    </div>
  );
}

/**
 * Resolve a field-sheet label to an actual value from the selected client
 * where possible. This is a coarse lookup — good enough for the values
 * that clearly live on the client record (PAN, GSTIN, client name,
 * financial year). Everything else is engine follow-up.
 */
function resolveFieldValue(label: string, client: VaultClient | null): string | null {
  const lc = label.toLowerCase();
  if (lc.includes('financial year')) {
    const now = new Date();
    const m = now.getMonth(); // 0-based
    // India FY runs Apr–Mar. Before April, we’re still in the previous FY.
    const startYear = m >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const endYear = (startYear + 1) % 100;
    return `${startYear}-${String(endYear).padStart(2, '0')}`;
  }
  if (lc.includes('return period')) {
    const d = new Date();
    return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  }
  if (!client) return null;
  if (lc.includes('gstin')) return client.gstin ?? null;
  if (lc.includes('pan')) {
    // ClientListItem carries pan; the VaultClient prop only forwards
    // name+gstin, so pull the label’s hint if it suggests we need it and
    // otherwise just return null — the caller falls back to the "pending"
    // state, which is honest.
    return null;
  }
  if (lc.includes('client name') || lc.includes('legal name')) return client.name;
  return null;
}

function FieldSheetRow({
  label, hint, client,
}: { label: string; hint?: string; client: VaultClient | null }) {
  const value = resolveFieldValue(label, client);
  const canCopy = !!value;
  const onCopy = async () => {
    if (!value) return;
    try { await navigator.clipboard.writeText(value); } catch { /* ignore */ }
  };
  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="text-14 text-neutral-900">{label}</div>
        {hint ? <div className="text-12 text-neutral-500 mt-0.5">{hint}</div> : null}
        {value ? (
          <div className="mt-1 text-13 font-mono text-neutral-800 break-all">{value}</div>
        ) : (
          <div className="mt-1 text-12 text-neutral-400">— pending engine —</div>
        )}
      </div>
      <button
        type="button"
        onClick={onCopy}
        disabled={!canCopy}
        title={canCopy ? 'Copy to clipboard' : 'Value fills in with the engine'}
        className="inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-neutral-700 border border-neutral-200 rounded-md hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <ClipboardCopy size={12} strokeWidth={2} />
        Copy
      </button>
    </li>
  );
}

function CopyAllButton({
  fields, serviceName, clientName,
}: {
  fields: { label: string; value: string | null }[];
  serviceName: string;
  clientName?: string;
}) {
  const [copied, setCopied] = useState(false);
  const resolvableCount = fields.filter((f) => f.value).length;

  const build = (): string => {
    const header = [
      `JNS Accounting Solutions — GST · ${serviceName}`,
      clientName ? `Client: ${clientName}` : 'Client: (not selected)',
      `Prepared: ${new Date().toLocaleString('en-IN')}`,
      '',
    ].join('\n');
    const rows = fields.map((f) => `${f.label}: ${f.value ?? '(pending)'}`).join('\n');
    return `${header}${rows}\n`;
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(build());
    } catch {
      // Clipboard denied — non-fatal.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      disabled={fields.length === 0}
      title={
        resolvableCount > 0
          ? `Copy ${fields.length} field${fields.length === 1 ? '' : 's'} (${resolvableCount} resolved) to the clipboard`
          : 'Sheet has no fields yet — pick a client to resolve values'
      }
      className="inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-white bg-primary hover:bg-primaryHover rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {copied ? <Check size={14} strokeWidth={2.25} /> : <ClipboardCopy size={14} strokeWidth={2} />}
      {copied ? 'Copied' : `Copy full sheet${resolvableCount ? ` (${resolvableCount}/${fields.length})` : ''}`}
    </button>
  );
}

function StepCard({
  n, title, subtitle, action, children,
}: {
  n: number;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-white border border-neutral-200 rounded-lg shadow-card p-5">
      <header className="flex items-start gap-3 mb-4">
        <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-gold text-white text-13 font-semibold shrink-0">
          {n}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-15 font-semibold text-neutral-900">{title}</h2>
          {subtitle ? <p className="text-12 text-neutral-500 mt-0.5">{subtitle}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}
