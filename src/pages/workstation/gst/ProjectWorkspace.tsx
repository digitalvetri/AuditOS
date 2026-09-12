/**
 * Project workspace v2 — compact case-pipeline layout.
 *
 * Same functionality as v1 (stage filter, case rows for real workstation
 * clients, notice-reference for externally-triggered variant) — laid out
 * as one card with inline stat chips and a tighter table.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Plus } from 'lucide-react';
import { workstationApi } from '@/modules/workstation/api';
import { SHAPE_TINT, type GstService } from './services';
import { caseStageFor, hash, type CaseStage } from './placeholder';

type Stage = CaseStage;

interface Case {
  caseId: string;
  clientId: string;
  clientName: string;
  contactRef: string;
  assignedTo: string;
  openedAt: string;
  daysInStage: number;
  stage: Stage;
  noticeRef?: string;
}

const STAGE_TINT: Record<Stage, { bg: string; fg: string; label: string }> = {
  not_started:       { bg: '#EEF0F3', fg: '#475569', label: 'Not started' },
  documents_pending: { bg: '#FEF3C7', fg: '#B45309', label: 'Docs pending' },
  in_progress:       { bg: '#E6EEFC', fg: '#1D4ED8', label: 'In progress' },
  under_review:      { bg: '#E6EEFC', fg: '#1D4ED8', label: 'Under review' },
  submitted:         { bg: '#EDE9FE', fg: '#6D28D9', label: 'Submitted' },
  officer_query:     { bg: '#FDE7EA', fg: '#B91C1C', label: 'Officer query' },
  completed:         { bg: '#E7F5EE', fg: '#166534', label: 'Completed' },
  failed:            { bg: '#FDE7EA', fg: '#B91C1C', label: 'Failed' },
};

const NOTICE_TYPES = ['ASMT-10', 'DRC-01A', 'REG-03', 'GSTR-3A', 'DRC-01', 'CMP-05'];

function dayOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function casePrefix(slug: string): string {
  switch (slug) {
    case 'registration':  return 'REG';
    case 'amendment':     return 'AMD';
    case 'cancellation':  return 'CAN';
    case 'notice-reply':  return 'NOT';
    case 'refund':        return 'RFD';
    case 'appeal':        return 'APL';
    default:              return 'CASE';
  }
}

function generateCases(
  clients: { id: string; company_name: string; gstin: string | null; pan: string | null; account_manager: { full_name: string } | null }[],
  service: GstService,
): Case[] {
  const isExternal = service.shape === 'externally-triggered';
  const prefix = casePrefix(service.slug);
  return clients.map((c, idx) => {
    const h = hash(c.id + service.slug);
    const stage = caseStageFor(c.id, service.slug);
    const openedDaysAgo = 1 + (h % 25);
    const daysInStage = h % 6;
    const contactRef = service.slug === 'registration'
      ? c.pan ?? '—'
      : c.gstin ?? '—';
    const caseId = `${prefix}-2026-${String(30 - (idx % 30)).padStart(3, '0')}`;
    return {
      caseId,
      clientId: c.id,
      clientName: c.company_name,
      contactRef,
      assignedTo: c.account_manager?.full_name ?? 'Unassigned',
      openedAt: dayOffset(-openedDaysAgo),
      daysInStage,
      stage,
      noticeRef: isExternal ? `${NOTICE_TYPES[h % NOTICE_TYPES.length]} / 2026-${String(1 + (h % 12)).padStart(2, '0')}` : undefined,
    };
  });
}

export function GstProjectWorkspace({ service }: { service: GstService }) {
  const [stageFilter, setStageFilter] = useState<Stage | 'all'>('all');
  const clientsQuery = useQuery({
    queryKey: ['workstation', 'clients', { for: 'gst-workspace' }],
    queryFn: () => workstationApi.listClients({}),
  });
  const clients = clientsQuery.data?.items ?? [];
  const cases = useMemo(() => generateCases(clients, service), [clients, service]);
  const rows = stageFilter === 'all' ? cases : cases.filter((c) => c.stage === stageFilter);
  const summary = summarise(cases);
  const tint = SHAPE_TINT[service.shape];
  const isExternal = service.shape === 'externally-triggered';

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
            <h1 className="text-18 font-semibold text-neutral-900 truncate">{service.name} · Cases</h1>
            <span
              className="inline-flex items-center h-5 px-2 text-11 font-medium rounded-md"
              style={{ backgroundColor: tint.bg, color: tint.fg }}
            >
              {tint.label}
            </span>
          </div>
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
          {!isExternal ? (
            <button
              type="button"
              disabled
              title="Case creation wires up once the project engine ships"
              className="inline-flex items-center gap-2 h-9 px-4 text-13 font-medium text-white bg-primary hover:bg-primaryHover rounded-md disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Plus size={14} strokeWidth={2} />
              New case
            </button>
          ) : null}
        </div>
      </header>

      <section className="bg-white border border-neutral-200 rounded-lg shadow-card">
        {/* Inline stat chips */}
        <div className="flex items-center gap-1 px-4 py-3 border-b border-neutral-100 overflow-x-auto flex-wrap">
          <StatChip
            label="Total"
            value={cases.length}
            active={stageFilter === 'all'}
            onClick={() => setStageFilter('all')}
          />
          {(['not_started', 'documents_pending', 'in_progress', 'submitted', 'officer_query', 'completed'] as Stage[]).map((s) => (
            <StatChip
              key={s}
              label={STAGE_TINT[s].label}
              value={summary[s]}
              tint={STAGE_TINT[s].fg}
              active={stageFilter === s}
              onClick={() => setStageFilter((cur) => (cur === s ? 'all' : s))}
            />
          ))}
        </div>

        {/* Table */}
        <table className="w-full">
          <thead>
            <tr className="text-11 font-semibold uppercase tracking-[0.06em] text-neutral-500 border-b border-neutral-100">
              <th className="text-left px-4 py-2">Case</th>
              <th className="text-left px-4 py-2">Client</th>
              {isExternal ? (
                <th className="text-left px-4 py-2 hidden md:table-cell">Notice</th>
              ) : null}
              <th className="text-left px-4 py-2 hidden lg:table-cell">Assigned</th>
              <th className="text-left px-4 py-2 hidden sm:table-cell">Days</th>
              <th className="text-left px-4 py-2">Stage</th>
              <th className="text-right px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {clientsQuery.isLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-13 text-neutral-500">
                  Loading clients…
                </td>
              </tr>
            ) : clientsQuery.isError ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-13 text-danger">
                  Could not load clients.
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-13 text-neutral-500">
                  {cases.length === 0
                    ? 'No clients in workstation yet — nothing to model as a case.'
                    : 'No cases match this filter.'}
                </td>
              </tr>
            ) : (
              rows.map((c) => <CaseRow key={c.caseId} row={c} service={service} isExternal={isExternal} />)
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function summarise(rows: Case[]): Record<Stage, number> {
  const acc: Record<Stage, number> = {
    not_started: 0, documents_pending: 0, in_progress: 0, under_review: 0,
    submitted: 0, officer_query: 0, completed: 0, failed: 0,
  };
  for (const r of rows) acc[r.stage]++;
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
        'inline-flex items-center gap-1 h-7 px-2 text-12 rounded-md border transition-colors whitespace-nowrap ' +
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

function CaseRow({
  row, service, isExternal,
}: { row: Case; service: GstService; isExternal: boolean }) {
  const tint = STAGE_TINT[row.stage];
  return (
    <tr className="border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50/50">
      <td className="px-4 py-2 text-13 font-mono text-neutral-700">{row.caseId}</td>
      <td className="px-4 py-2">
        <div className="text-13 font-medium text-neutral-900">{row.clientName}</div>
        <div className="text-11 text-neutral-500 font-mono">{row.contactRef}</div>
      </td>
      {isExternal ? (
        <td className="px-4 py-2 text-12 text-neutral-700 hidden md:table-cell">{row.noticeRef ?? '—'}</td>
      ) : null}
      <td className="px-4 py-2 text-13 text-neutral-700 hidden lg:table-cell">{row.assignedTo}</td>
      <td className="px-4 py-2 text-13 tabular-nums hidden sm:table-cell">
        <span className={row.daysInStage > 3 ? 'text-danger font-medium' : 'text-neutral-700'}>
          {row.daysInStage}d
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
      <td className="px-4 py-2 text-right">
        <Link
          to={`/workstation/services/gst/${service.slug}?client=${row.clientId}`}
          className="text-12 font-medium text-primary hover:text-primaryHover whitespace-nowrap"
        >
          Open →
        </Link>
      </td>
    </tr>
  );
}
