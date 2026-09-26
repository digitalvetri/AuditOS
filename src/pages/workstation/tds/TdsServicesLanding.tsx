/**
 * TDS module landing — Workstation → Services → TDS.
 *
 * Copies the compact list pattern from the GST landing. Adds a sticky
 * "context" strip carrying the client + FY + TAN selectors, a deductor
 * context row (TAN · deductor type · responsible person · portal
 * registration status), and a "Weekly notice check" shortcut card.
 *
 * Client selection lives in ?client=<id>&fy=<label>&tan=<tan> so the URL
 * is shareable and every screen the operator opens from here inherits
 * the same scope.
 */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ExternalLink, Users } from 'lucide-react';
import { workstationApi } from '@/modules/workstation/api';
import { TDS_PORTAL, TDS_SUB_SERVICES, type TdsSubService } from './services';
import { fyLabelForDate, fyRange } from './config';
import {
  challanStatus,
  correctionStatus,
  form16Status,
  noticesStatus,
  registrationStatus,
  returnFilingStatus,
  type SubServiceStatus,
} from './status';
import { tdsApi, type TdsData } from '@/modules/tds/api';
import { TdsCredentialsCard } from './TdsCredentialsCard';
import { tdsPortalApi } from '@/modules/tdsPortal/api';

const STATUS_TINT: Record<SubServiceStatus['key'], { bg: string; fg: string }> = {
  not_registered:  { bg: '#EEF0F3', fg: '#475569' },
  applied:         { bg: '#E6EEFC', fg: '#1D4ED8' },
  active:          { bg: '#E7F5EE', fg: '#166534' },
  due:             { bg: '#FEF3C7', fg: '#B45309' },
  overdue:         { bg: '#FDE7EA', fg: '#B91C1C' },
  in_progress:     { bg: '#E6EEFC', fg: '#1D4ED8' },
  filed:           { bg: '#E7F5EE', fg: '#166534' },
  unpaid:          { bg: '#FEF3C7', fg: '#B45309' },
  paid:            { bg: '#E7F5EE', fg: '#166534' },
  issued:          { bg: '#E7F5EE', fg: '#166534' },
  pending:         { bg: '#FEF3C7', fg: '#B45309' },
  not_applicable:  { bg: '#EEF0F3', fg: '#94A3B8' },
};

export function TdsServicesLanding() {
  const [params, setParams] = useSearchParams();
  const clientId = params.get('client') ?? '';
  const fyLabel = params.get('fy') ?? fyLabelForDate(new Date());

  const clientsQuery = useQuery({
    queryKey: ['workstation', 'clients', { for: 'tds-landing' }],
    queryFn: () => workstationApi.listClients({}),
  });
  const clients = clientsQuery.data?.items ?? [];
  // Configured / not-configured per client — ids only, never secrets. A 403
  // (no TDS credential permission) just leaves the markers off.
  const credStatusQuery = useQuery({
    queryKey: ['tds-portal', 'status'],
    queryFn: () => tdsPortalApi.status(),
    retry: false,
  });
  const configured = useMemo(
    () => (credStatusQuery.data ? new Set(credStatusQuery.data.items.map((i) => i.client_id)) : null),
    [credStatusQuery.data],
  );
  const [clientSearch, setClientSearch] = useState('');
  const visibleClients = useMemo(() => {
    const q = clientSearch.trim().toLowerCase();
    const list = q
      ? clients.filter((c) => [c.company_name, c.gstin, c.tan].some((v) => v?.toLowerCase().includes(q)))
      : clients;
    // Keep the selected client in the list even when the search hides it.
    return clientId && !list.some((c) => c.id === clientId)
      ? [...clients.filter((c) => c.id === clientId), ...list]
      : list;
  }, [clients, clientSearch, clientId]);
  const selectedClient = useMemo(
    () => clients.find((c) => c.id === clientId) ?? null,
    [clientId, clients],
  );

  const tanParam = params.get('tan') ?? '';
  const tdsQuery = useQuery({
    queryKey: ['tds', clientId, fyLabel, tanParam],
    queryFn: () => tdsApi.get(clientId, fyLabel, tanParam || null),
    enabled: !!clientId,
  });
  const tds = tdsQuery.data ?? null;
  // Primary TAN lives on the client record; branches on the TDS profile.
  const tans = tds?.client.tans ?? [];
  const effectiveTan = tds?.active_tan ?? selectedClient?.tan ?? null;

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Workstation · Services</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">TDS</h1>
        </div>
        <a
          href={TDS_PORTAL.url}
          target="_blank"
          rel="noopener noreferrer"
          title={TDS_PORTAL.label}
          aria-label={`Open ${TDS_PORTAL.label} in a new tab`}
          className="shrink-0 inline-flex items-center gap-2 h-10 px-4 rounded-md bg-primary text-white text-14 font-medium hover:bg-primaryHover transition-colors"
        >
          <ExternalLink size={16} strokeWidth={2} />
          <span className="hidden sm:inline">Visit portal</span>
        </a>
      </header>

      {/* Sticky selector strip */}
      <section className="sticky top-0 z-10 bg-white border border-neutral-200 rounded-lg shadow-card">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <SelectorField label="Search" htmlFor="tds-client-search">
            <input
              id="tds-client-search"
              type="search"
              value={clientSearch}
              onChange={(e) => setClientSearch(e.target.value)}
              placeholder="Search client…"
              className="h-9 px-3 text-13 bg-white border border-neutral-300 rounded-md focus:outline-none focus:border-gold w-[180px]"
            />
          </SelectorField>

          <SelectorField label="Client" htmlFor="tds-client">
            <select
              id="tds-client"
              value={clientId}
              onChange={(e) => {
                // A new client has its own TANs — drop the old TAN choice.
                const next = new URLSearchParams(params);
                if (e.target.value) next.set('client', e.target.value); else next.delete('client');
                next.delete('tan');
                setParams(next, { replace: true });
              }}
              disabled={clientsQuery.isLoading}
              className="h-9 px-3 text-13 bg-white border border-neutral-300 rounded-md focus:outline-none focus:border-gold min-w-[240px]"
            >
              <option value="">— Select a client —</option>
              {visibleClients.map((c) => (
                <option key={c.id} value={c.id}>
                  {configured ? (configured.has(c.id) ? '● ' : '○ ') : ''}
                  {c.company_name}{c.gstin ? ' · ' + c.gstin : ''}
                </option>
              ))}
            </select>
          </SelectorField>

          <SelectorField label="FY" htmlFor="tds-fy">
            <select
              id="tds-fy"
              value={fyLabel}
              onChange={(e) => setParam('fy', e.target.value)}
              className="h-9 px-3 text-13 bg-white border border-neutral-300 rounded-md focus:outline-none focus:border-gold"
            >
              {fyRange().map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </SelectorField>

          <SelectorField label="TAN" htmlFor="tds-tan">
            {tans.length > 1 ? (
              <select
                id="tds-tan"
                value={effectiveTan ?? ''}
                onChange={(e) => setParam('tan', e.target.value === tds?.client.tan ? '' : e.target.value)}
                className="h-9 px-3 text-13 font-mono bg-white border border-neutral-300 rounded-md focus:outline-none focus:border-gold"
              >
                {tans.map((t) => (
                  <option key={t} value={t}>{t}{t === tds?.client.tan ? ' (primary)' : ''}</option>
                ))}
              </select>
            ) : effectiveTan ? (
              <span className="inline-flex items-center h-9 px-3 text-13 font-mono text-neutral-900 border border-neutral-200 rounded-md bg-neutral-50">
                {effectiveTan}
              </span>
            ) : (
              <span className="inline-flex items-center h-9 px-3 text-13 text-neutral-500 border border-dashed border-neutral-300 rounded-md">
                No TAN registered
              </span>
            )}
          </SelectorField>
        </div>

        {/* Deductor context strip */}
        {selectedClient && effectiveTan && tds ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 border-t border-neutral-100 text-12 text-neutral-500">
            <ContextItem label="Deductor">{deductorLabel(tds.profile.deductor_type)}</ContextItem>
            <ContextItem label="Responsible person">{tds.profile.responsible_person ?? '—'}</ContextItem>
            <ContextItem label="Returns">{tds.profile.return_forms.join(' · ')}</ContextItem>
            <ContextItem label="TRACES">
              {tds.any_filed_return ? (
                <span className="inline-flex items-center gap-1 text-neutral-900">
                  <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: '#166534' }} aria-hidden />
                  Registered
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-neutral-900">
                  <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: '#B45309' }} aria-hidden />
                  Needs a filed return first
                </span>
              )}
            </ContextItem>
          </div>
        ) : null}
      </section>

      {!selectedClient ? (
        <EmptyState />
      ) : (
        <>
          {/* Keyed by client so no credential state survives a client switch. */}
          <TdsCredentialsCard key={selectedClient.id} client={selectedClient} />

          <section className="bg-white border border-neutral-200 rounded-lg shadow-card overflow-hidden">
            {!tds ? (
              <div className="px-4 py-6 text-13 text-neutral-500">
                {tdsQuery.isError ? (tdsQuery.error as Error).message : 'Loading TDS records…'}
              </div>
            ) : (
            <ul>
              {TDS_SUB_SERVICES.map((s, i) => {
                const status = statusFor(s, tds, fyLabel);
                return (
                  <SubServiceRow
                    key={s.slug}
                    service={s}
                    status={status}
                    first={i === 0}
                    urlSuffix={buildSuffix({ client: selectedClient.id, fy: fyLabel, tan: effectiveTan })}
                  />
                );
              })}
            </ul>
            )}
          </section>

        </>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <section className="bg-white border border-neutral-200 rounded-lg shadow-card p-8 text-center">
      <div className="inline-flex items-center justify-center w-10 h-10 rounded-md bg-neutral-100 text-neutral-500 mb-3" aria-hidden>
        <Users size={20} strokeWidth={1.75} />
      </div>
      <div className="text-14 font-medium text-neutral-900">Select a client to view TDS details.</div>
      <p className="text-12 text-neutral-500 mt-1 max-w-[400px] mx-auto">
        Nothing renders until a client is selected — TDS work is always TAN-scoped.
      </p>
    </section>
  );
}

function SelectorField({
  label, htmlFor, children,
}: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={htmlFor} className="text-11 uppercase tracking-[0.06em] text-neutral-500 shrink-0">
        {label}
      </label>
      {children}
    </div>
  );
}

function ContextItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className="text-neutral-500">{label}:</span>
      <span className="text-neutral-900">{children}</span>
    </span>
  );
}

function statusFor(service: TdsSubService, data: TdsData, fy: string): SubServiceStatus {
  switch (service.slug) {
    case 'registration':        return registrationStatus(data);
    case 'challan-payment':     return challanStatus(data, fy);
    case 'return-filing':       return returnFilingStatus(data, fy);
    case 'correction-filing':   return correctionStatus(data);
    case 'form-16':             return form16Status(data, fy);
    case 'notices':             return noticesStatus(data);
  }
}

const DEDUCTOR_LABELS: Record<string, string> = {
  company: 'Company', firm: 'Firm / LLP', individual: 'Individual / HUF', government: 'Government',
  trust: 'Trust', aop: 'AOP / BOI', other: 'Other',
};
export function deductorLabel(t: string | null): string {
  return t ? DEDUCTOR_LABELS[t] ?? t : 'Not set';
}

function SubServiceRow({
  service, status, first, urlSuffix,
}: {
  service: TdsSubService;
  status: SubServiceStatus;
  first: boolean;
  urlSuffix: string;
}) {
  const Icon = service.icon;
  const tint = STATUS_TINT[status.key];
  const disabled = !!status.greyed;
  const to = `/workstation/services/tds/${service.slug}${urlSuffix}`;
  return (
    <li className={first ? '' : 'border-t border-neutral-100'}>
      {disabled ? (
        <div className="flex items-center gap-4 px-4 py-3 opacity-70 cursor-not-allowed" title={status.greyedReason}>
          <span
            className="inline-flex items-center justify-center w-8 h-8 rounded-md shrink-0 bg-neutral-100 text-neutral-400"
            aria-hidden
          >
            <Icon size={16} strokeWidth={1.75} />
          </span>
          <div className="w-56 md:w-64 lg:w-72 min-w-0">
            <div className="text-14 font-medium text-neutral-500 truncate">{service.name}</div>
            {status.greyedReason ? (
              <div className="text-11 text-neutral-400 truncate">{status.greyedReason}</div>
            ) : null}
          </div>
          <div className="hidden sm:block w-32 lg:w-40 text-12 text-neutral-400 font-mono truncate">
            {service.form}
          </div>
          <span className="hidden md:inline-flex items-center justify-center w-32 h-6 text-11 rounded-md whitespace-nowrap bg-neutral-100 text-neutral-500">
            {status.label}
          </span>
          <div className="flex-1" />
        </div>
      ) : (
        <Link
          to={to}
          className="flex items-center gap-4 px-4 py-3 hover:bg-neutral-50 transition-colors group"
        >
          <span
            className="inline-flex items-center justify-center w-8 h-8 rounded-md shrink-0"
            style={{ backgroundColor: tint.bg, color: tint.fg }}
            aria-hidden
          >
            <Icon size={16} strokeWidth={1.75} />
          </span>
          <div className="w-56 md:w-64 lg:w-72 min-w-0">
            <div className="text-14 font-medium text-neutral-900 group-hover:text-gold truncate">
              {service.name}
            </div>
          </div>
          <div className="hidden sm:block w-32 lg:w-40 text-12 text-neutral-500 font-mono tabular-nums truncate">
            {service.form}
          </div>
          <span
            className="inline-flex items-center h-6 px-2 text-11 font-medium rounded-md whitespace-nowrap max-w-[220px] truncate"
            style={{ backgroundColor: tint.bg, color: tint.fg }}
            title={status.detail}
          >
            {status.label}
          </span>
          {status.detail ? (
            <span className="hidden lg:inline text-12 text-neutral-500 truncate max-w-[280px]">
              {status.detail}
            </span>
          ) : null}
          <div className="flex-1" />
          <a
            href={service.portal.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={service.portal.label}
            aria-label={`Open ${service.portal.label} in a new tab`}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-neutral-400 hover:text-neutral-800 hover:bg-white"
          >
            <ExternalLink size={14} strokeWidth={2} />
          </a>
          <ChevronRight size={16} strokeWidth={2} className="text-neutral-400 group-hover:text-gold shrink-0" />
        </Link>
      )}
    </li>
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
