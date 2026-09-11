/**
 * Recurring workspace v2 — compact period-board layout.
 *
 * Same functionality as v1 (period selector, status filter, obligation
 * table wired to real workstation clients) — laid out with an inline
 * stats bar, an inline period pill and a single tighter table. No
 * separate cards for each strip.
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
  dueDate: string;
  status: ObligationStatus;
  arn?: string;
}

const STATUS_TINT: Record<ObligationStatus, { bg: string; fg: string; label: string }> = {
  not_started: { bg: '#EEF0F3', fg: '#475569', label: 'Not started' },
  in_progress: { bg: '#E6EEFC', fg: '#1D4ED8', label: 'In progress' },
  ready:       { bg: '#FEF3C7', fg: '#B45309', label: 'Ready' },
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
    return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  }, [periodOffset]);

  const [statusFilter, setStatusFilter] = useState<ObligationStatus | 'all'>('all');

  const clientsQuery = useQuery({
    queryKey: ['workstation', 'clients', { for: 'gst-workspace' }],
    queryFn: () => workstationApi.listClients({}),
  });
  const clients = clientsQuery.data?.items ?? [];
  const obligations = useMemo(() => generateObligations(clients, service.slug), [clients, service.slug]);
  const summary = summarise(obligations);
  const rows = statusFilter === 'all' ? obligations : obligations.filter((o) => o.status === statusFilter);
  const tint = SHAPE_TINT[service.shape];

  return (
    <div className="space-y-4">
      <div>
        <Link
          to={`/workstation/services/gst/${service.slug}`}
          className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900"
        >
          <ArrowLeft size={14} strokeWidth={2} />
          Back to service
        </Link>
      </div>

      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-18 font-semibold text-neutral-900 truncate">{service.name} · Period board</h1>
            <span
              className="inline-flex items-center h-5 px-2 text-11 font-medium rounded-md"
              style={{ backgroundColor: tint.bg, color: tint.fg }}
            >
              {tint.label}
            </span>
          </div>
        </div>
        <a
          href={service.portalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 h-9 px-3 text-13 font-medium border border-neutral-200 rounded-md text-neutral-700 hover:bg-neutral-50"
        >
          <ExternalLink size={14} strokeWidth={2} />
          Open portal
        </a>
      </header>

      {/* Inline period selector + stats bar */}
      <section className="bg-white border border-neutral-200 rounded-lg shadow-card">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-100 flex-wrap">
          <div className="inline-flex items-center rounded-md border border-neutral-200">
            <button
              type="button"
              onClick={() => setPeriodOffset((n) => n - 1)}
              className="h-8 w-8 inline-flex items-center justify-center text-neutral-600 hover:bg-neutral-50 border-r border-neutral-200 rounded-l-md"
              aria-label="Previous period"
            >
              <ChevronLeft size={14} strokeWidth={2} />
            </button>
            <div className="h-8 px-3 inline-flex items-center text-13 font-medium text-neutral-900 tabular-nums">
              {period}
            </div>
            <button
              type="button"
              onClick={() => setPeriodOffset((n) => n + 1)}
              className="h-8 w-8 inline-flex items-center justify-center text-neutral-600 hover:bg-neutral-50 border-l border-neutral-200 rounded-r-md"
              aria-label="Next period"
            >
              <ChevronRight size={14} strokeWidth={2} />
            </button>
          </div>
          {periodOffset !== 0 ? (
            <button
              type="button"
              onClick={() => setPeriodOffset(0)}
              className="text-12 text-gold hover:text-gold-hover font-medium"
            >
              Jump to current
            </button>
          ) : null}
          <div className="flex-1" />
          <StatChip
            label="Total"
            value={obligations.length}
            active={statusFilter === 'all'}
            onClick={() => setStatusFilter('all')}
          />
          {(['overdue', 'ready', 'in_progress', 'not_started', 'filed'] as ObligationStatus[]).map((s) => (
            <StatChip
              key={s}
              label={STATUS_TINT[s].label}
              value={summary[s]}
              tint={STATUS_TINT[s].fg}
              active={statusFilter === s}
              onClick={() => setStatusFilter((cur) => (cur === s ? 'all' : s))}
            />
          ))}
        </div>

        {/* Table */}
        <table className="w-full">
          <thead>
            <tr className="text-11 font-semibold uppercase tracking-[0.06em] text-neutral-500 border-b border-neutral-100">
              <th className="text-left px-4 py-2">Client</th>
              <th className="text-left px-4 py-2 hidden md:table-cell">Assigned</th>
              <th className="text-left px-4 py-2">Due</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-left px-4 py-2 hidden lg:table-cell">ARN</th>
              <th className="text-right px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {clientsQuery.isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-13 text-neutral-500">
                  Loading clients…
                </td>
              </tr>
            ) : clientsQuery.isError ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-13 text-danger">
                  Could not load clients.
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-13 text-neutral-500">
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

function StatChip({
  label, value, tint, active, onClick,
}: {
  label: string;
  value: number;
  tint?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'inline-flex items-center gap-1 h-7 px-2 text-12 rounded-md border transition-colors ' +
        (active
          ? 'border-neutral-400 bg-neutral-50'
          : 'border-transparent hover:bg-neutral-50')
      }
    >
      {tint ? (
        <span className="inline-block w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: tint }} aria-hidden />
      ) : null}
      <span className="text-neutral-700">{label}</span>
      <span className="text-neutral-900 font-medium tabular-nums">{value}</span>
    </button>
  );
}

function ObligationRow({ row, service }: { row: Obligation; service: GstService }) {
  const tint = STATUS_TINT[row.status];
  const now = new Date().toISOString().slice(0, 10);
  const isPast = row.dueDate < now && row.status !== 'filed';
  return (
    <tr className="border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50/50">
      <td className="px-4 py-2">
        <div className="text-13 font-medium text-neutral-900">{row.clientName}</div>
        <div className="text-11 text-neutral-500 font-mono">{row.gstin}</div>
      </td>
      <td className="px-4 py-2 text-13 text-neutral-700 hidden md:table-cell">{row.assignedTo}</td>
      <td className="px-4 py-2 text-13 tabular-nums">
        <span className={isPast ? 'text-danger font-medium' : 'text-neutral-700'}>
          {new Date(row.dueDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
        </span>
      </td>
      <td className="px-4 py-2">
        <span
          className="inline-flex items-center h-5 px-2 text-11 font-medium rounded-md whitespace-nowrap"
          style={{ backgroundColor: tint.bg, color: tint.fg }}
        >
          {tint.label}
        </span>
      </td>
      <td className="px-4 py-2 text-12 text-neutral-500 font-mono hidden lg:table-cell">
        {row.arn ?? '—'}
      </td>
      <td className="px-4 py-2 text-right">
        <Link
          to={`/workstation/services/gst/${service.slug}?client=${row.clientId}`}
          className="text-12 font-medium text-gold hover:text-gold-hover whitespace-nowrap"
        >
          Open →
        </Link>
      </td>
    </tr>
  );
}
