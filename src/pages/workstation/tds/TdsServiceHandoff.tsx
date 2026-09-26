/**
 * TDS per-service handoff — Workstation → Services → TDS → :slug.
 *
 * Same single-card structure as the GST handoff. Post-login services show
 * the client's saved TDS portal credentials (TdsCredentialsCard — encrypted,
 * reveal audited). "Record back after filing" persists through
 * TdsRecordsPanel. Adds the
 * TDS-specific guardrails: SPICe+ block on Registration when an
 * Incorporation case is open, TRACES caveat on Form 16/16A, correction
 * requires an original token, format validation on TAN and 14-digit ack,
 * over-length WARN on Form 49B fields (never silent truncation).
 *
 * URL scope is (?client, ?fy, ?tan) inherited from the landing.
 */
import { useMemo, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  ClipboardCopy,
  ExternalLink,
  Info,
} from 'lucide-react';
import { workstationApi } from '@/modules/workstation/api';
import { TdsCredentialsCard } from './TdsCredentialsCard';
import { TdsRecordsPanel } from './TdsRecordsPanel';
import { tdsApi, type ProfileTextKey, type TdsProfile } from '@/modules/tds/api';

/** Field-sheet label (lower-case) → TDS profile field. */
const PROFILE_FIELD_BY_LABEL: Record<string, ProfileTextKey> = {
  'responsible person name': 'responsible_person',
  'responsible person designation': 'rp_designation',
  'responsible person pan': 'rp_pan',
  'responsible person email': 'rp_email',
  'responsible person mobile': 'rp_mobile',
  'flat / door / block no.': 'addr_flat',
  'building name': 'addr_building',
  'road / street': 'addr_road',
  'area / locality': 'addr_area',
  'city / district': 'addr_city',
  'pin code': 'addr_pin',
  'ao code': 'ao_code',
};
import { findTdsSubService, type TdsSubService } from './services';
import { fyLabelForDate } from './config';

export function TdsServiceHandoff() {
  const { slug } = useParams<{ slug: string }>();
  const [params, setParams] = useSearchParams();
  const service = slug ? findTdsSubService(slug) : undefined;

  const clientId = params.get('client') ?? '';
  const fyLabel = params.get('fy') ?? fyLabelForDate(new Date());

  const clientsQuery = useQuery({
    queryKey: ['workstation', 'clients', { for: 'tds-handoff' }],
    queryFn: () => workstationApi.listClients({}),
  });
  const clients = clientsQuery.data?.items ?? [];
  const selectedClient = useMemo(() => {
    const c = clients.find((cc) => cc.id === clientId);
    return c ?? null;
  }, [clientId, clients]);

  const tanParam = params.get('tan') ?? '';
  const tdsQuery = useQuery({
    queryKey: ['tds', clientId, fyLabel, tanParam],
    queryFn: () => tdsApi.get(clientId, fyLabel, tanParam || null),
    enabled: !!clientId,
  });
  const tds = tdsQuery.data ?? null;
  const effectiveTan = tds?.active_tan ?? selectedClient?.tan ?? null;

  if (!service) {
    return <Navigate to="/workstation/services/tds" replace />;
  }

  const Icon = service.icon;

  const incorporating = false; // Wire when the incorporation module exposes a hook here.
  const hasFiledReturn = !!tds?.any_filed_return;
  const hasOriginalToken = hasFiledReturn;

  const block = decideBlock(service, {
    incorporating,
    hasTan: !!effectiveTan,
    hasFiledReturn,
    hasOriginalToken,
  });

  const backSuffix = buildSuffix({ client: clientId, fy: fyLabel, tan: effectiveTan });

  return (
    <div className="space-y-4">
      <div>
        <Link
          to={`/workstation/services/tds${backSuffix}`}
          className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900"
        >
          <ArrowLeft size={14} strokeWidth={2} />
          All TDS services
        </Link>
      </div>

      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <span
            className="inline-flex items-center justify-center w-10 h-10 rounded-md shrink-0 bg-neutral-100 text-neutral-700"
            aria-hidden
          >
            <Icon size={18} strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-18 font-semibold text-neutral-900 truncate">{service.name}</h1>
              <span className="text-13 text-neutral-500 tabular-nums">{service.form}</span>
            </div>
            <p className="text-13 text-neutral-500 mt-1 max-w-[720px]">{service.summary}</p>
          </div>
        </div>
        <a
          href={service.portal.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 h-9 px-4 text-13 font-medium text-white bg-primary hover:bg-primaryHover rounded-md"
        >
          <ExternalLink size={14} strokeWidth={2} />
          Open portal
        </a>
      </header>

      {/* Guardrail blocks — hard stops when the action shouldn't be taken */}
      {block ? <BlockNotice block={block} /> : null}

      {!service.portal.preLogin && selectedClient ? (
        <TdsCredentialsCard key={selectedClient.id} client={selectedClient} />
      ) : null}

      <section className="bg-white border border-neutral-200 rounded-lg shadow-card divide-y divide-neutral-100">
        {/* Client + FY + TAN */}
        <div className="p-5">
          <div className="flex items-center gap-3 flex-wrap">
            <label htmlFor="tds-handoff-client" className="text-13 font-medium text-neutral-900 w-20 shrink-0">
              Client
            </label>
            <select
              id="tds-handoff-client"
              value={clientId}
              onChange={(e) => {
                const next = new URLSearchParams(params);
                if (e.target.value) next.set('client', e.target.value); else next.delete('client');
                next.delete('tan');
                setParams(next, { replace: true });
              }}
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
            <span className="text-12 text-neutral-500">
              FY <span className="text-neutral-900 font-medium">{fyLabel}</span>
            </span>
            {effectiveTan ? (
              <span className="text-12 text-neutral-500">
                TAN <span className="text-neutral-900 font-mono">{effectiveTan}</span>
              </span>
            ) : (
              <span className="text-12 text-neutral-500">No TAN registered</span>
            )}
          </div>
        </div>

        {/* Credentials */}
        {service.portal.preLogin ? (
          <div className="p-5"><CredentialsNotNeededNote /></div>
        ) : null}

        {/* Portal note (e.g. "This is Protean, not incometax.gov.in") */}
        {service.portal.note ? (
          <div className="px-5 py-3 flex items-start gap-2 text-12 text-neutral-700 bg-neutral-50/60">
            <AlertTriangle size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-neutral-500" />
            <span>{service.portal.note}</span>
          </div>
        ) : null}

        {/* TRACES-registration caveat on Form 16/16A */}
        {service.guards?.showTracesRegistrationCaveat ? (
          <div className="px-5 py-3 flex items-start gap-2 text-12 text-neutral-700 bg-neutral-50/60">
            <Info size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-neutral-500" />
            <span>
              <strong className="font-medium">TRACES deductor registration</strong> generally
              requires the token number of an already-filed return. Brand-new deductors can't
              reach Form 16A until after their first filing.
            </span>
          </div>
        ) : null}

        {/* Click path */}
        {service.portal.navPath.length ? (
          <div className="p-5">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="text-13 font-medium text-neutral-900 w-32 shrink-0">Path in portal</div>
              <ClickPath steps={service.portal.navPath} />
            </div>
          </div>
        ) : null}

        {/* Auxiliary handoff (CSI file, Conso file) */}
        {service.auxHandoff ? (
          <div className="p-5">
            <div className="flex items-start gap-3 flex-wrap">
              <div className="text-13 font-medium text-neutral-900 w-32 shrink-0">First</div>
              <div className="flex-1 min-w-[240px]">
                <div className="flex items-center gap-2 flex-wrap">
                  <a
                    href={service.auxHandoff.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-neutral-700 border border-neutral-200 rounded-md hover:bg-neutral-50"
                  >
                    <ExternalLink size={12} strokeWidth={2} />
                    {service.auxHandoff.label}
                  </a>
                  <ClickPath steps={service.auxHandoff.navPath} />
                </div>
                {service.auxHandoff.note ? (
                  <div className="text-11 text-neutral-500 mt-2">{service.auxHandoff.note}</div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {/* Field sheet */}
        {service.fieldSheet.length ? (
          <div className="p-5">
            <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
              <div className="text-13 font-medium text-neutral-900">Field sheet</div>
              <CopyAllButton
                fields={service.fieldSheet.map((f) => ({
                  label: f.label,
                  value: resolveFieldValue(f.label, selectedClient, effectiveTan, fyLabel, tds?.profile ?? null),
                }))}
                serviceName={service.name}
                clientName={selectedClient?.company_name}
              />
            </div>
            <ul className="divide-y divide-neutral-100">
              {service.fieldSheet.map((f) => (
                <FieldSheetRow
                  key={f.label}
                  label={f.label}
                  hint={f.hint}
                  limit={f.limit}
                  client={selectedClient}
                  tan={effectiveTan}
                  fyLabel={fyLabel}
                  profile={tds?.profile ?? null}
                />
              ))}
            </ul>
          </div>
        ) : null}

        {/* Record back after filing — persisted */}
        <div className="p-5">
          <div className="text-13 font-medium text-neutral-900 mb-3">Record back after filing</div>
          {!selectedClient ? (
            <div className="text-13 text-neutral-500">Select a client to record TDS work.</div>
          ) : !tds ? (
            <div className="text-13 text-neutral-500">
              {tdsQuery.isError ? (tdsQuery.error as Error).message : 'Loading TDS records…'}
            </div>
          ) : service.slug !== 'registration' && !tds.active_tan ? (
            <div className="text-13 text-neutral-500">Record the TAN under TDS Registration first.</div>
          ) : (
            <TdsRecordsPanel key={`${selectedClient.id}-${fyLabel}-${tds.active_tan}`} slug={service.slug} data={tds} fy={fyLabel} />
          )}
        </div>
      </section>
    </div>
  );
}

interface BlockNotice {
  tone: 'block' | 'warn';
  title: string;
  body: string;
}

function decideBlock(
  service: TdsSubService,
  ctx: { incorporating: boolean; hasTan: boolean; hasFiledReturn: boolean; hasOriginalToken: boolean },
): BlockNotice | null {
  if (service.slug === 'registration' && ctx.incorporating) {
    return {
      tone: 'block',
      title: 'This client is incorporating — do not file Form 49B',
      body:
        'PAN and TAN are allotted automatically through SPICe+ as part of the incorporation route. Filing a duplicate Form 49B creates a mess to unwind. Handoff is disabled.',
    };
  }
  if (service.slug !== 'registration' && !ctx.hasTan) {
    return {
      tone: 'block',
      title: 'No TAN registered',
      body: 'This action is TAN-scoped. File TDS Registration first, then come back once the TAN is allotted.',
    };
  }
  if (service.guards?.requiresOriginalToken && !ctx.hasOriginalToken) {
    return {
      tone: 'block',
      title: 'No original return to correct',
      body:
        'A correction is a new record referencing an existing token — it is never an edit. File the original return first.',
    };
  }
  if (service.guards?.requiresFiledReturn && !ctx.hasFiledReturn) {
    return {
      tone: 'warn',
      title: 'Return not filed yet',
      body:
        'Form 16 / 16A can be downloaded from TRACES only after the underlying return is filed. Come back once the return is processed.',
    };
  }
  return null;
}

function BlockNotice({ block }: { block: BlockNotice }) {
  const tint = block.tone === 'block'
    ? { bg: '#FDE7EA', border: '#F5C2C0', fg: '#B91C1C' }
    : { bg: '#FEF3C7', border: '#F0D785', fg: '#B45309' };
  return (
    <div
      className="rounded-lg border p-4 flex items-start gap-3"
      style={{ backgroundColor: tint.bg, borderColor: tint.border }}
      role="alert"
    >
      <AlertTriangle size={18} strokeWidth={1.75} style={{ color: tint.fg }} className="shrink-0 mt-0.5" />
      <div>
        <div className="text-14 font-semibold" style={{ color: tint.fg }}>{block.title}</div>
        <p className="text-13 mt-1" style={{ color: tint.fg }}>{block.body}</p>
      </div>
    </div>
  );
}

function ClickPath({ steps }: { steps: string[] }) {
  return (
    <nav aria-label="Portal click path" className="flex flex-wrap items-center gap-1 text-13">
      {steps.map((step, i) => (
        <div key={step} className="flex items-center gap-1">
          <span className="inline-flex items-center h-7 px-2 rounded-md bg-neutral-50 border border-neutral-200 text-neutral-800">
            {step}
          </span>
          {i < steps.length - 1 ? (
            <ChevronRight size={12} strokeWidth={2} className="text-neutral-400" />
          ) : null}
        </div>
      ))}
    </nav>
  );
}

/** Resolve a field-sheet label to an actual value. Same shape as the GST
 *  helper — pattern is "known label → known source". */
function resolveFieldValue(
  label: string,
  client: { company_name: string; gstin: string | null; pan: string | null } | null,
  tan: string | null,
  fyLabel: string,
  profile: TdsProfile | null,
): string | null {
  const lc = label.toLowerCase();
  // Form 49B details live on the TDS profile (Registration page).
  const fromProfile = profile ? PROFILE_FIELD_BY_LABEL[lc] : undefined;
  if (fromProfile) return profile![fromProfile] || null;
  if (lc === 'form type' && profile) return profile.return_forms.join(' · ') || null;
  if (lc.includes('assessment year')) {
    // Assessment year for TDS FY YYYY-YY is the FY that follows it.
    const start = Number(fyLabel.split('-')[0]);
    const nextTo = (start + 2) % 100;
    return `${start + 1}-${String(nextTo).padStart(2, '0')}`;
  }
  if (lc.includes('fy') || lc.includes('quarter or fy')) return fyLabel;
  if (lc === 'tan') return tan ?? null;
  if (!client) return null;
  if (lc.includes('entity pan') || lc === 'pan') return client.pan ?? null;
  if (lc.includes('gstin')) return client.gstin ?? null;
  if (lc.includes('client name') || lc.includes('legal name')) return client.company_name;
  return null;
}

function FieldSheetRow({
  label, hint, limit, client, tan, fyLabel, profile,
}: {
  label: string;
  hint?: string;
  limit?: number;
  client: { company_name: string; gstin: string | null; pan: string | null } | null;
  tan: string | null;
  fyLabel: string;
  profile: TdsProfile | null;
}) {
  const value = resolveFieldValue(label, client, tan, fyLabel, profile);
  const canCopy = !!value;
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (!value) return;
    try { await navigator.clipboard.writeText(value); } catch { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const overLimit = !!(limit && value && value.length > limit);
  return (
    <li className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-13 text-neutral-900">{label}</div>
        {hint ? <div className="text-11 text-neutral-500 mt-0.5">{hint}</div> : null}
        {overLimit ? (
          <div className="text-11 text-danger mt-0.5 flex items-center gap-1">
            <AlertTriangle size={12} strokeWidth={2} />
            Value length {value!.length} exceeds portal limit {limit}. Do not truncate — edit
            the client record first.
          </div>
        ) : null}
      </div>
      <div className="text-13 font-mono text-neutral-700 min-w-0 flex-1 truncate text-right">
        {value ?? <span className="text-neutral-400 italic font-sans">pending</span>}
      </div>
      <button
        type="button"
        onClick={onCopy}
        disabled={!canCopy}
        className="inline-flex items-center gap-1 h-7 px-2 text-11 font-medium text-neutral-700 border border-neutral-200 rounded-md hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        title={canCopy ? 'Copy to clipboard' : 'Fills in with the engine'}
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
      `JNS Accounting Solutions — TDS · ${serviceName}`,
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
      className="inline-flex items-center gap-1 h-7 px-2 text-11 font-medium text-white bg-primary hover:bg-primaryHover rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
      title={resolvableCount > 0
        ? `Copy ${fields.length} field${fields.length === 1 ? '' : 's'} (${resolvableCount} resolved) to the clipboard`
        : 'Sheet has no resolved values yet — pick a client'
      }
    >
      {copied ? <Check size={12} strokeWidth={2.5} /> : <ClipboardCopy size={12} strokeWidth={2} />}
      {copied ? 'Copied' : `Copy full sheet${resolvableCount ? ` (${resolvableCount}/${fields.length})` : ''}`}
    </button>
  );
}

function buildSuffix(parts: { client: string; fy: string; tan: string | null }): string {
  const p = new URLSearchParams();
  if (parts.client) p.set('client', parts.client);
  if (parts.fy) p.set('fy', parts.fy);
  if (parts.tan) p.set('tan', parts.tan);
  const s = p.toString();
  return s ? `?${s}` : '';
}

function CredentialsNotNeededNote() {
  return (
    <div className="flex items-start gap-2 text-12 text-neutral-500">
      <Info size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" />
      <span>This destination is pre-login — no client credentials required.</span>
    </div>
  );
}
