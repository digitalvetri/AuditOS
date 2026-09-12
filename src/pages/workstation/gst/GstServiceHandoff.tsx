/**
 * Per-service AssistedHandoff page — combined single-card layout (v2).
 *
 * All the functionality of the original 4-step layout — client picker,
 * portal open, credential vault, click-path breadcrumb, field sheet with
 * Copy-all and per-field copy, capture list — laid out inside one card
 * separated by subtle dividers. Header carries the service identity, the
 * shape chip, the workspace shortcut and the primary "Open portal"
 * action.
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
    <div className="space-y-4">
      <div>
        <Link
          to="/workstation/services/gst"
          className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900"
        >
          <ArrowLeft size={14} strokeWidth={2} />
          All GST services
        </Link>
      </div>

      {/* Header — identity + primary actions */}
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <span
            className="inline-flex items-center justify-center w-10 h-10 rounded-md shrink-0"
            style={{ backgroundColor: tint.bg, color: tint.fg }}
            aria-hidden
          >
            <Icon size={18} strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-18 font-semibold text-neutral-900 truncate">{service.name}</h1>
              <span className="text-13 text-neutral-500 tabular-nums">{service.form}</span>
              <span
                className="inline-flex items-center h-5 px-2 text-11 font-medium rounded-md"
                style={{ backgroundColor: tint.bg, color: tint.fg }}
              >
                {tint.label}
              </span>
            </div>
            <p className="text-13 text-neutral-500 mt-1 max-w-[720px]">{service.summary}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {service.shape !== 'retainer' ? (
            <Link
              to={`/workstation/services/gst/${service.slug}/workspace`}
              className="inline-flex items-center gap-1 h-9 px-3 text-13 font-medium text-neutral-700 border border-neutral-200 rounded-md hover:bg-neutral-50"
            >
              <CalendarRange size={14} strokeWidth={1.75} />
              {service.shape === 'recurring' ? 'Period board' : 'Case pipeline'}
            </Link>
          ) : null}
          <a
            href={service.portalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 h-9 px-4 text-13 font-medium text-white bg-primary hover:bg-primaryHover rounded-md"
          >
            <ExternalLink size={14} strokeWidth={2} />
            Open portal
          </a>
        </div>
      </header>

      {/* Unified card */}
      <section className="bg-white border border-neutral-200 rounded-lg shadow-card divide-y divide-neutral-100">
        {/* Client */}
        <div className="p-5">
          <div className="flex items-center gap-3 flex-wrap">
            <label htmlFor="gst-client-picker" className="text-13 font-medium text-neutral-900 w-20 shrink-0">
              Client
            </label>
            <select
              id="gst-client-picker"
              value={selectedClientId}
              onChange={(e) => setClient(e.target.value)}
              disabled={clientsQuery.isLoading}
              className="flex-1 min-w-[220px] h-9 px-3 text-14 bg-white border border-neutral-300 rounded-md focus:outline-none focus:border-gold"
            >
              <option value="">— Select a client —</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.company_name}{c.gstin ? ' · ' + c.gstin : ''}
                </option>
              ))}
            </select>
            {selectedClient?.gstin ? (
              <span className="text-12 text-neutral-500 font-mono">GSTIN {selectedClient.gstin}</span>
            ) : null}
          </div>
        </div>

        {/* Credentials */}
        <div className="p-5">
          {service.preLogin ? <CredentialsNotNeededNote /> : <CredentialVault client={selectedClient} />}
        </div>

        {/* Click path */}
        {service.navPath.length ? (
          <div className="p-5">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="text-13 font-medium text-neutral-900 w-32 shrink-0">Path in portal</div>
              <nav aria-label="Portal click path" className="flex flex-wrap items-center gap-1 text-13">
                {service.navPath.map((step, i) => (
                  <div key={step} className="flex items-center gap-1">
                    <span className="inline-flex items-center h-7 px-2 rounded-md bg-neutral-50 border border-neutral-200 text-neutral-800">
                      {step}
                    </span>
                    {i < service.navPath.length - 1 ? (
                      <ChevronRight size={12} strokeWidth={2} className="text-neutral-400" />
                    ) : null}
                  </div>
                ))}
              </nav>
            </div>
          </div>
        ) : null}

        {/* Field sheet */}
        {service.fieldSheet?.length ? (
          <div className="p-5">
            <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
              <div className="text-13 font-medium text-neutral-900">Field sheet</div>
              <CopyAllButton
                fields={service.fieldSheet.map((f) => ({
                  label: f.label,
                  value: resolveFieldValue(f.label, selectedClient),
                }))}
                serviceName={service.name}
                clientName={selectedClient?.name}
              />
            </div>
            <ul className="divide-y divide-neutral-100">
              {service.fieldSheet.map((f) => (
                <FieldSheetRow key={f.label} label={f.label} hint={f.hint} client={selectedClient} />
              ))}
            </ul>
          </div>
        ) : null}

        {/* Capture */}
        {service.capture?.length ? (
          <div className="p-5">
            <div className="text-13 font-medium text-neutral-900 mb-3">Record back after filing</div>
            <ul className="flex flex-wrap gap-x-4 gap-y-2">
              {service.capture.map((c) => (
                <li key={c.key} className="text-13 text-neutral-700">
                  {c.label}
                  {c.required ? <span className="text-11 uppercase tracking-[0.06em] text-danger ml-1">req</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {/* Operational context — kept but demoted */}
      <details className="bg-white border border-neutral-200 rounded-lg shadow-card">
        <summary className="cursor-pointer px-5 py-3 text-13 font-medium text-neutral-700 hover:text-neutral-900">
          What the firm actually does
        </summary>
        <div className="px-5 pb-4 text-13 text-neutral-700 leading-relaxed">
          {service.detail}
        </div>
      </details>
    </div>
  );
}

/** Resolve a field-sheet label to an actual value from the selected client
 *  where possible. Coarse lookup — good enough for values that live on the
 *  client record (PAN, GSTIN, client name, financial year). */
function resolveFieldValue(label: string, client: VaultClient | null): string | null {
  const lc = label.toLowerCase();
  if (lc.includes('financial year')) {
    const now = new Date();
    const m = now.getMonth();
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
  if (lc.includes('client name') || lc.includes('legal name')) return client.name;
  return null;
}

function FieldSheetRow({
  label, hint, client,
}: { label: string; hint?: string; client: VaultClient | null }) {
  const value = resolveFieldValue(label, client);
  const canCopy = !!value;
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (!value) return;
    try { await navigator.clipboard.writeText(value); } catch { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <li className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-13 text-neutral-900">{label}</div>
        {hint ? <div className="text-11 text-neutral-500 mt-0.5">{hint}</div> : null}
      </div>
      <div className="text-13 font-mono text-neutral-700 min-w-0 flex-1 truncate text-right">
        {value ?? <span className="text-neutral-400 italic font-sans">pending</span>}
      </div>
      <button
        type="button"
        onClick={onCopy}
        disabled={!canCopy}
        title={canCopy ? 'Copy to clipboard' : 'Value fills in with the engine'}
        className="inline-flex items-center gap-1 h-7 px-2 text-11 font-medium text-neutral-700 border border-neutral-200 rounded-md hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
      >
        {copied ? <Check size={12} strokeWidth={2.5} /> : <ClipboardCopy size={12} strokeWidth={2} />}
        {copied ? 'Copied' : 'Copy'}
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
    try { await navigator.clipboard.writeText(build()); } catch { /* ignore */ }
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
      className="inline-flex items-center gap-1 h-7 px-2 text-11 font-medium text-white bg-primary hover:bg-primaryHover rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {copied ? <Check size={12} strokeWidth={2.5} /> : <ClipboardCopy size={12} strokeWidth={2} />}
      {copied ? 'Copied' : `Copy full sheet${resolvableCount ? ` (${resolvableCount}/${fields.length})` : ''}`}
    </button>
  );
}
