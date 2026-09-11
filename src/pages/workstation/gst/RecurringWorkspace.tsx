/**
 * Recurring workspace v1 — per-period obligation list.
 *
 * Spec §4 shape for Return Filing / Annual Return / LUT: period-driven,
 * one obligation per (client, period). This v1 shows a single period at a
 * time — a monthly selector, a summary strip and a client obligation
 * table. Client × month grid is a future iteration; a single-period list
 * is what the spec calls the "period board" reduced to today.
 *
 * All data is static placeholder — the engine still needs designing and
 * the backend model doesn’t exist. This page proves the shape.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
} from 'lucide-react';
import { workstationApi } from '@/modules/workstation/api';
import { SHAPE_TINT, type GstService } from './services';
import { obligationStatusFor, type ObligationStatus } from './placeholder';

interface Obligation {
  clientId: string;
  clientName: string;
  gstin: string;
  assignedTo: string;
  dueDate: string;   // ISO
  status: ObligationStatus;
  arn?: string;
}

const STATUS_TINT: Record<ObligationStatus, { bg: string; fg: string; label: string }> = {
  not_started: { bg: '#EEF0F3', fg: '#475569', label: 'Not started' },
  in_progress: { bg: '#E6EEFC', fg: '#1D4ED8', label: 'In progress' },
  ready:       { bg: '#FEF3C7', fg: '#B45309', label: 'Ready to file' },
  filed:       { bg: '#E7F5EE', fg: '#166534', label: 'Filed' },
  overdue:     { bg: '#FDE7EA', fg: '#B91C1C', label: 'Overdue' },
};

function dateInMonth(day: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), day);
  return d.toISOString().slice(0, 10);
}

function generateObligations(
  clients: { id: string; company_name: string; gstin: string | null; account_manager: { full_name: string } | null }[],
  serviceSlug: string,
): Obligation[] {
  return clients.map((c) => {
    const status = obligationStatusFor(c.id, serviceSlug);
    const dueDate = status === 'overdue' ? dateInMonth(-3) : dateInMonth(20);
    return {
      clientId: c.id,
      clientName: c.company_name,
      gstin: c.gstin ?? '—',
      assignedTo: c.account_manager?.full_name ?? 'Unassigned',
      dueDate,
      status,
      arn: status === 'filed'
        ? `AA${33 + (c.id.charCodeAt(0) % 6)}0425${String(Math.abs(c.id.charCodeAt(1) * 991) % 999999).padStart(6, '0')}A`
        : undefined,
    };
  });
}

export function GstRecurringWorkspace({ service }: { service: GstService }) {
  const [periodOffset, setPeriodOffset] = useState(0);
  const period = useMemo(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + periodOffset);
    return {
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
    };
  }, [periodOffset]);

  const [statusFilter, setStatusFilter] = useState<ObligationStatus | 'all'>('all');

  const clientsQuery = useQuery({
    queryKey: ['workstation', 'clients', { for: 'gst-workspace' }],
    queryFn: () => workstationApi.listClients({}),
  });
  const clients = clientsQuery.data?.items ?? [];
  const obligations = useMemo(() => generateObligations(clients, service.slug), [clients, service.slug]);
  const summary = summarise(obligations);
  const rows = statusFilter === 'all'
    ? obligations
    : obligations.filter((o) => o.status === statusFilter);

  const tint = SHAPE_TINT[service.shape];

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={`/workstation/services/gst/${service.slug}`}
          className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900"
        >
          <ArrowLeft size={14} strokeWidth={2} />
          Back to service
        </Link>
      </div>

      {/* Header */}
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">
              Workstation · Services · GST · {service.name}
            </span>
            <span
              className="inline-flex items-center h-5 px-2 text-11 font-medium rounded-md"
              style={{ backgroundColor: tint.bg, color: tint.fg }}
            >
              {tint.label}
            </span>
          </div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">
            {service.name} · Period board
          </h1>
          <p className="text-13 text-neutral-500 mt-1">
            One obligation per client per period. Placeholder data — engine and backend to
            follow.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={service.portalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 h-9 px-3 text-13 font-medium border border-neutral-200 rounded-md text-neutral-700 hover:bg-neutral-50"
          >
            <ExternalLink size={14} strokeWidth={2} />
            Open portal
          </a>
        </div>
      </header>

      {/* Period selector */}
      <section className="bg-white border border-neutral-200 rounded-lg shadow-card p-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="inline-flex items-center rounded-md border border-neutral-200">
          <button
            type="button"
            onClick={() => setPeriodOffset((n) => n - 1)}
            className="h-9 w-9 inline-flex items-center justify-center text-neutral-600 hover:bg-neutral-50 border-r border-neutral-200 rounded-l-md"
            aria-label="Previous period"
          >
            <ChevronLeft size={16} strokeWidth={2} />
          </button>
          <div className="h-9 px-4 inline-flex items-center text-14 font-medium text-neutral-900 tabular-nums">
            {period.label}
          </div>
          <button
            type="button"
            onClick={() => setPeriodOffset((n) => n + 1)}
            className="h-9 w-9 inline-flex items-center justify-center text-neutral-600 hover:bg-neutral-50 border-l border-neutral-200 rounded-r-md"
            aria-label="Next period"
          >
            <ChevronRight size={16} strokeWidth={2} />
          </button>
        </div>
        {periodOffset !== 0 ? (
          <button
            type="button"
            onClick={() => setPeriodOffset(0)}
            className="text-13 text-gold hover:text-gold-hover font-medium"
          >
            Jump to current period
          </button>
        ) : (
          <span className="text-12 text-neutral-500">Showing current period</span>
        )}
      </section>

      {/* Summary strip */}
      <section className="bg-white border border-neutral-200 rounded-lg shadow-card">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-x divide-neutral-100">
          <SummaryCell
            label="Total"
            value={obligations.length}
            active={statusFilter === 'all'}
            onClick={() => setStatusFilter('all')}
          />
          {(['not_started', 'in_progress', 'ready', 'filed', 'overdue'] as ObligationStatus[]).map((s) => (
            <SummaryCell
              key={s}
              label={STATUS_TINT[s].label}
              value={summary[s]}
              tone={STATUS_TINT[s]}
              active={statusFilter === s}
              onClick={() => setStatusFilter((cur) => (cur === s ? 'all' : s))}
            />
          ))}
        </div>
      </section>

      {/* Obligation rows */}
      <section className="bg-white border border-neutral-200 rounded-lg shadow-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-neutral-50 border-b border-neutral-200">
              {['Client', 'GSTIN', 'Assigned to', 'Due', 'Status', 'ARN', ''].map((h) => (
                <th
                  key={h}
                  className="text-left text-11 font-semibold uppercase tracking-[0.06em] text-neutral-500 px-4 py-2"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {clientsQuery.isLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-13 text-neutral-500">
                  Loading clients…
                </td>
              </tr>
            ) : clientsQuery.isError ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-13 text-danger">
                  Could not load clients.
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-13 text-neutral-500">
                  {obligations.length === 0
                    ? 'No clients in workstation yet.'
                    : 'No obligations match this filter.'}
                </td>
              </tr>
            ) : (
              rows.map((o) => <ObligationRow key={o.clientId} row={o} service={service} />)
            )}
          </tbody>
        </table>
      </section>

      <p className="text-11 text-neutral-500">
        Actions on each row are non-functional in v1. Real state changes require the recurring
        engine (period generation, status transitions, ARN capture) — spec §4, tracked as a
        follow-up.
      </p>
    </div>
  );
}

function summarise(rows: Obligation[]): Record<ObligationStatus, number> {
  const acc: Record<ObligationStatus, number> = {
    not_started: 0, in_progress: 0, ready: 0, filed: 0, overdue: 0,
  };
  for (const r of rows) acc[r.status]++;
  return acc;
}

function SummaryCell({
  label, value, tone, active, onClick,
}: {
  label: string;
  value: number;
  tone?: { bg: string; fg: string };
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'text-left px-4 py-3 transition-colors ' +
        (active ? 'bg-neutral-50' : 'hover:bg-neutral-50')
      }
    >
      <div className="flex items-center gap-2">
        {tone ? (
          <span
            className="inline-block w-2 h-2 rounded-sm"
            style={{ backgroundColor: tone.fg }}
            aria-hidden
          />
        ) : null}
        <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</span>
      </div>
      <div className="text-20 font-semibold text-neutral-900 tabular-nums mt-1">{value}</div>
    </button>
  );
}

function ObligationRow({
  row, service,
}: { row: Obligation; service: GstService }) {
  const tint = STATUS_TINT[row.status];
  const now = new Date().toISOString().slice(0, 10);
  const isPast = row.dueDate < now && row.status !== 'filed';
  return (
    <tr className="border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50/50">
      <td className="px-4 py-3">
        <div className="text-14 font-medium text-neutral-900">{row.clientName}</div>
      </td>
      <td className="px-4 py-3 text-13 text-neutral-700 font-mono">{row.gstin}</td>
      <td className="px-4 py-3 text-13 text-neutral-700">{row.assignedTo}</td>
      <td className="px-4 py-3 text-13 tabular-nums">
        <span className={isPast ? 'text-danger font-medium' : 'text-neutral-700'}>
          {new Date(row.dueDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
        </span>
      </td>
      <td className="px-4 py-3">
        <span
          className="inline-flex items-center h-6 px-2 text-11 font-medium rounded-md whitespace-nowrap"
          style={{ backgroundColor: tint.bg, color: tint.fg }}
        >
          {tint.label}
        </span>
      </td>
      <td className="px-4 py-3 text-13 text-neutral-700 font-mono">
        {row.arn ?? <span className="text-neutral-400">—</span>}
      </td>
      <td className="px-4 py-3 text-right">
        <Link
          to={`/workstation/services/gst/${service.slug}?client=${row.clientId}`}
          className="text-12 font-medium text-gold hover:text-gold-hover whitespace-nowrap"
        >
          Open handoff →
        </Link>
      </td>
    </tr>
  );
}
