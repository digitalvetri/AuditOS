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
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BellRing, ChevronRight, ExternalLink, Users } from 'lucide-react';
import { workstationApi } from '@/modules/workstation/api';
import { TDS_SUB_SERVICES, type TdsSubService } from './services';
import { fyLabelForDate, fyRange } from './config';
import {
  challanStatus,
  correctionStatus,
  form16Status,
  noticesStatus,
  placeholderDeductorType,
  placeholderHasFiledReturn,
  placeholderHasOriginalToken,
  placeholderResponsiblePerson,
  placeholderTans,
  registrationStatus,
  returnFilingStatus,
  type SubServiceStatus,
} from './placeholder';
import { readNoticeLog, noticeKey } from './noticeCheckStore';

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
  const selectedTan = params.get('tan') ?? '';

  const clientsQuery = useQuery({
    queryKey: ['workstation', 'clients', { for: 'tds-landing' }],
    queryFn: () => workstationApi.listClients({}),
  });
  const clients = clientsQuery.data?.items ?? [];
  const selectedClient = useMemo(
    () => clients.find((c) => c.id === clientId) ?? null,
    [clientId, clients],
  );

  const tans = selectedClient ? placeholderTans(selectedClient.id) : [];
  const effectiveTan = tans.length === 0
    ? null
    : tans.length === 1
      ? tans[0]
      : (selectedTan && tans.includes(selectedTan) ? selectedTan : tans[0]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  // Placeholder derived state — the engine will provide these from real
  // records once the backend lands.
  const incorporating = false; // Wire when the incorporation module exposes a hook here.
  const hasFiledReturn = selectedClient
    ? placeholderHasFiledReturn(selectedClient.id, effectiveTan, fyLabel)
    : false;
  const hasOriginalToken = selectedClient
    ? placeholderHasOriginalToken(selectedClient.id, effectiveTan, fyLabel)
    : false;
  const log = readNoticeLog();
  const lastNoticeCheckAt = selectedClient
    ? log[noticeKey(selectedClient.id, effectiveTan)]?.lastCheckedAt
    : undefined;

  return (
    <div className="space-y-4">
      <header>
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Workstation · Services</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">TDS</h1>
      </header>

      {/* Sticky selector strip */}
      <section className="sticky top-0 z-10 bg-white border border-neutral-200 rounded-lg shadow-card">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <SelectorField label="Client" htmlFor="tds-client">
            <select
              id="tds-client"
              value={clientId}
              onChange={(e) => setParam('client', e.target.value)}
              disabled={clientsQuery.isLoading}
              className="h-9 px-3 text-13 bg-white border border-neutral-300 rounded-md focus:outline-none focus:border-gold min-w-[240px]"
            >
              <option value="">— Select a client —</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
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
            {tans.length === 0 ? (
              <span className="inline-flex items-center h-9 px-3 text-13 text-neutral-500 border border-dashed border-neutral-300 rounded-md">
                No TAN registered
              </span>
            ) : tans.length === 1 ? (
              <span className="inline-flex items-center h-9 px-3 text-13 font-mono text-neutral-900 border border-neutral-200 rounded-md bg-neutral-50">
                {tans[0]}
              </span>
            ) : (
              <select
                id="tds-tan"
                value={effectiveTan ?? ''}
                onChange={(e) => setParam('tan', e.target.value)}
                className="h-9 px-3 text-13 font-mono bg-white border border-neutral-300 rounded-md focus:outline-none focus:border-gold"
              >
                {tans.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            )}
          </SelectorField>
        </div>

        {/* Deductor context strip */}
        {selectedClient && effectiveTan ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 border-t border-neutral-100 text-12 text-neutral-500">
            <ContextItem label="Deductor">{placeholderDeductorType(selectedClient.id, effectiveTan)}</ContextItem>
            <ContextItem label="Responsible person">{placeholderResponsiblePerson(selectedClient.id, effectiveTan)}</ContextItem>
            <ContextItem label="e-Filing">
              <span className="inline-flex items-center gap-1 text-neutral-900">
                <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: '#166534' }} aria-hidden />
                Registered
              </span>
            </ContextItem>
            <ContextItem label="TRACES">
              {hasFiledReturn ? (
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
          <NoticeCheckShortcut />

          <section className="bg-white border border-neutral-200 rounded-lg shadow-card overflow-hidden">
            <ul>
              {TDS_SUB_SERVICES.map((s, i) => {
                const status = statusFor(s, {
                  clientId: selectedClient.id,
                  tan: effectiveTan,
                  fyLabel,
                  incorporating,
                  hasFiledReturn,
                  hasOriginalToken,
                  lastNoticeCheckAt,
                });
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
          </section>

          <p className="text-11 text-neutral-500">
            {TDS_SUB_SERVICES.length} sub-services · Status placeholders until the engine ships ·
            Spec at <code className="text-neutral-700">TDS-PAGE-PROMPT.md</code>
          </p>
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
      <div className="text-14 font-medium text-neutral-900">Pick a client to begin</div>
      <p className="text-12 text-neutral-500 mt-1 max-w-[400px] mx-auto">
        Nothing renders until a client is selected — TDS work is always TAN-scoped.
      </p>
    </section>
  );
}

function NoticeCheckShortcut() {
  return (
    <Link
      to="/workstation/services/gst/notice-check"
      className="group flex items-center gap-4 rounded-lg p-4 border border-neutral-200 bg-white shadow-card hover:border-neutral-300 transition-colors"
    >
      <span
        className="inline-flex items-center justify-center w-10 h-10 rounded-md shrink-0"
        style={{ backgroundColor: '#FDE7EA', color: '#B91C1C' }}
        aria-hidden
      >
        <BellRing size={18} strokeWidth={1.75} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-14 font-medium text-neutral-900 group-hover:text-gold">
          Weekly TRACES sweep for this client
        </div>
        <p className="text-12 text-neutral-500 mt-0.5">
          A missed short-deduction default accrues interest quietly — walk the notices/defaults
          tab and log the outcome.
        </p>
      </div>
      <ChevronRight size={18} strokeWidth={2} className="text-neutral-400 group-hover:text-gold shrink-0" />
    </Link>
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

interface StatusCtx {
  clientId: string;
  tan: string | null;
  fyLabel: string;
  incorporating: boolean;
  hasFiledReturn: boolean;
  hasOriginalToken: boolean;
  lastNoticeCheckAt?: string;
}

function statusFor(service: TdsSubService, ctx: StatusCtx): SubServiceStatus {
  switch (service.slug) {
    case 'registration':        return registrationStatus(ctx);
    case 'challan-payment':     return challanStatus(ctx);
    case 'return-filing':       return returnFilingStatus(ctx);
    case 'correction-filing':   return correctionStatus(ctx);
    case 'form-16':             return form16Status(ctx);
    case 'notices':             return noticesStatus(ctx);
  }
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
