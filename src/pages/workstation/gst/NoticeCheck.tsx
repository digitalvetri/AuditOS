/**
 * Weekly notice-check discovery workflow — v2 compact layout (spec §3.4).
 *
 * Same functionality as v1.5: real client list, priority derived from
 * days-since, localStorage persistence of outcomes, per-row Check now /
 * No notices / Found notice actions. Laid out with an inline stat-chip
 * bar and a tighter table.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  BellRing,
  Check,
  ExternalLink,
} from 'lucide-react';
import { workstationApi } from '@/modules/workstation/api';
import type { ClientListItem } from '@/modules/workstation/types';
import { findGstService } from './services';
import { daysSinceNoticeCheck, hash } from './placeholder';
import {
  clearNoticeLog,
  daysSinceISO,
  readNoticeLog,
  writeNoticeCheck,
  type NoticeCheckLog,
  type NoticeOutcome,
} from './noticeCheckStore';

const NOTICE_PATH = ['Services', 'User Services', 'View Additional Notices and Orders'];

type Priority = 'due' | 'soon' | 'ok';

interface CheckState {
  lastChecked: string;
  daysSince: number;
  openCases: number;
  priority: Priority;
  outcome?: NoticeOutcome;
}

const PRIORITY_TINT: Record<Priority, { bg: string; fg: string; label: string }> = {
  due:  { bg: '#FDE7EA', fg: '#B91C1C', label: 'Due' },
  soon: { bg: '#FEF3C7', fg: '#B45309', label: 'Soon' },
  ok:   { bg: '#E7F5EE', fg: '#166534', label: 'Recent' },
};

function makeCheckState(clientId: string, log: NoticeCheckLog): CheckState {
  const stored = log[clientId];
  if (stored) {
    const daysSince = daysSinceISO(stored.lastCheckedAt);
    const priority: Priority = daysSince >= 7 ? 'due' : daysSince >= 4 ? 'soon' : 'ok';
    return {
      lastChecked: stored.lastCheckedAt,
      daysSince,
      openCases: stored.outcome === 'found' ? 1 : hash(clientId) % 3 === 0 ? 1 : 0,
      priority,
      outcome: stored.outcome,
    };
  }
  const daysSince = daysSinceNoticeCheck(clientId);
  const priority: Priority = daysSince >= 7 ? 'due' : daysSince >= 4 ? 'soon' : 'ok';
  const d = new Date();
  d.setDate(d.getDate() - daysSince);
  return {
    lastChecked: d.toISOString().slice(0, 10),
    daysSince,
    openCases: hash(clientId) % 3 === 0 ? 1 : 0,
    priority,
  };
}

export function GstNoticeCheck() {
  const [filter, setFilter] = useState<Priority | 'all'>('all');
  const [log, setLog] = useState<NoticeCheckLog>(() => readNoticeLog());

  const clientsQuery = useQuery({
    queryKey: ['workstation', 'clients', { for: 'gst-notice-check' }],
    queryFn: () => workstationApi.listClients({}),
  });
  const clients = clientsQuery.data?.items ?? [];

  const rows = useMemo(() => {
    return clients
      .map((c) => ({ client: c, state: makeCheckState(c.id, log) }))
      .sort((a, b) => b.state.daysSince - a.state.daysSince);
  }, [clients, log]);

  const filtered = filter === 'all' ? rows : rows.filter((r) => r.state.priority === filter);

  const summary = useMemo(() => {
    const acc = { due: 0, soon: 0, ok: 0, cases_open: 0 };
    for (const r of rows) {
      acc[r.state.priority]++;
      acc.cases_open += r.state.openCases;
    }
    return acc;
  }, [rows]);

  const markCheck = (clientId: string, outcome: NoticeOutcome) => {
    setLog(writeNoticeCheck(clientId, outcome));
  };

  const resetLog = () => {
    if (!confirm('Clear the local notice-check log for every client?')) return;
    clearNoticeLog();
    setLog({});
  };
  const loggedCount = Object.keys(log).length;

  const service = findGstService('notice-reply');

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

      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-18 font-semibold text-neutral-900">Weekly notice check</h1>
            {loggedCount > 0 ? (
              <span className="text-12 text-neutral-500">{loggedCount} logged</span>
            ) : null}
          </div>
          <p className="text-13 text-neutral-500 mt-1 max-w-[720px]">
            Portal doesn’t push reliably. Walk the list, check each notices tab, log the outcome.
            {service ? (
              <>
                {' '}Open cases live in{' '}
                <Link to="/workstation/services/gst/notice-reply/workspace" className="text-gold hover:text-gold-hover font-medium">
                  Notice Reply
                </Link>.
              </>
            ) : null}
          </p>
        </div>
        {loggedCount > 0 ? (
          <button
            type="button"
            onClick={resetLog}
            className="inline-flex items-center gap-1 h-9 px-3 text-13 font-medium text-neutral-700 border border-neutral-200 rounded-md hover:bg-neutral-50"
          >
            Reset log
          </button>
        ) : null}
      </header>

      <section className="bg-white border border-neutral-200 rounded-lg shadow-card">
        {/* Inline stat chips */}
        <div className="flex items-center gap-1 px-4 py-3 border-b border-neutral-100 flex-wrap">
          <StatChip
            label="Total"
            value={rows.length}
            active={filter === 'all'}
            onClick={() => setFilter('all')}
          />
          <StatChip
            label="Due"
            value={summary.due}
            tint={PRIORITY_TINT.due.fg}
            active={filter === 'due'}
            onClick={() => setFilter((f) => (f === 'due' ? 'all' : 'due'))}
          />
          <StatChip
            label="Soon"
            value={summary.soon}
            tint={PRIORITY_TINT.soon.fg}
            active={filter === 'soon'}
            onClick={() => setFilter((f) => (f === 'soon' ? 'all' : 'soon'))}
          />
          <StatChip
            label="Recent"
            value={summary.ok}
            tint={PRIORITY_TINT.ok.fg}
            active={filter === 'ok'}
            onClick={() => setFilter((f) => (f === 'ok' ? 'all' : 'ok'))}
          />
          <div className="ml-auto text-12 text-neutral-500">
            Open cases <span className="font-medium text-neutral-900 tabular-nums">{summary.cases_open}</span>
          </div>
        </div>

        {/* Table */}
        <table className="w-full">
          <thead>
            <tr className="text-11 font-semibold uppercase tracking-[0.06em] text-neutral-500 border-b border-neutral-100">
              <th className="text-left px-4 py-2">Client</th>
              <th className="text-left px-4 py-2 hidden sm:table-cell">Last check</th>
              <th className="text-left px-4 py-2">Priority</th>
              <th className="text-right px-4 py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {clientsQuery.isLoading ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-13 text-neutral-500">
                  Loading clients…
                </td>
              </tr>
            ) : clientsQuery.isError ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-13 text-danger">
                  Could not load clients.
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-13 text-neutral-500">
                  {rows.length === 0 ? 'No clients to check.' : 'No clients match this filter.'}
                </td>
              </tr>
            ) : (
              filtered.map(({ client, state }) => (
                <NoticeRow
                  key={client.id}
                  client={client}
                  state={state}
                  onMark={(outcome) => markCheck(client.id, outcome)}
                />
              ))
            )}
          </tbody>
        </table>
      </section>

      <p className="text-11 text-neutral-500">
        Outcomes persist in this browser under{' '}
        <code className="text-neutral-700">audit-os:gst-notice-check</code>. Server audit log +
        real case creation land with the engine.
      </p>
    </div>
  );
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

function NoticeRow({
  client, state, onMark,
}: {
  client: ClientListItem;
  state: CheckState;
  onMark: (outcome: NoticeOutcome) => void;
}) {
  const tint = PRIORITY_TINT[state.priority];
  const portalUrl = 'https://www.gst.gov.in/';
  const persisted = state.outcome;

  return (
    <tr className="border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50/50">
      <td className="px-4 py-2">
        <div className="text-13 font-medium text-neutral-900">{client.company_name}</div>
        <div className="text-11 text-neutral-500 font-mono">
          {client.gstin ?? 'not registered'}
        </div>
      </td>
      <td className="px-4 py-2 text-13 tabular-nums hidden sm:table-cell">
        <div className="text-neutral-700">
          {new Date(state.lastChecked).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
        </div>
        <div className="text-11 text-neutral-500">
          {state.daysSince === 0 ? 'today' : `${state.daysSince}d ago`}
        </div>
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
        {persisted === 'clear' ? (
          <div className="inline-flex items-center gap-2">
            <span className="inline-flex items-center gap-1 text-12 text-success">
              <Check size={12} strokeWidth={2.5} /> No notices
            </span>
            <button
              type="button"
              onClick={() => onMark('found')}
              className="text-11 text-neutral-500 hover:text-neutral-900 underline"
            >
              Change
            </button>
          </div>
        ) : persisted === 'found' ? (
          <div className="inline-flex items-center gap-2">
            <span className="inline-flex items-center gap-1 text-12 text-danger">
              <BellRing size={12} strokeWidth={2} /> Case queued
            </span>
            <button
              type="button"
              onClick={() => onMark('clear')}
              className="text-11 text-neutral-500 hover:text-neutral-900 underline"
            >
              Change
            </button>
          </div>
        ) : (
          <div className="inline-flex items-center gap-1">
            <a
              href={portalUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`After login, follow: ${NOTICE_PATH.join(' › ')}`}
              className="inline-flex items-center gap-1 h-7 px-2 text-11 font-medium text-white bg-gold hover:bg-gold-hover rounded-md"
            >
              <ExternalLink size={12} strokeWidth={2} />
              Check
            </a>
            <button
              type="button"
              onClick={() => onMark('clear')}
              className="h-7 px-2 text-11 font-medium text-neutral-700 border border-neutral-200 rounded-md hover:bg-neutral-50"
              title="Mark as no notices"
            >
              None
            </button>
            <button
              type="button"
              onClick={() => onMark('found')}
              className="h-7 px-2 text-11 font-medium text-danger border border-neutral-200 rounded-md hover:bg-neutral-50"
              title="Mark as notice found"
            >
              Found
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}
