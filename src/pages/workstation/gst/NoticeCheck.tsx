/**
 * Weekly notice-check discovery workflow — spec §3.4 and §8.
 *
 * "The operational problem is not the reply. It is knowing the notice
 * exists. The portal does not push notifications reliably, and a missed
 * ASMT-10 becomes a DRC-01 becomes a demand order."
 *
 * This page lists every client with a signal that says "check the notices
 * tab for this one." The operator clicks Check now (which opens the portal
 * to Services › User Services › View Additional Notices and Orders), then
 * marks the outcome — clear or opened a case.
 *
 * v1 caveats: last-checked timestamps are deterministic placeholders, and
 * "No notices" / "Found a notice" actions are non-persistent. Real state
 * ships with the notice-reply case engine (task #4).
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertOctagon,
  ArrowLeft,
  Bell,
  BellRing,
  CalendarClock,
  Check,
  ClipboardCheck,
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

// The portal path the operator will click through after login.
const NOTICE_PATH = ['Services', 'User Services', 'View Additional Notices and Orders'];

type Priority = 'due' | 'soon' | 'ok';

interface CheckState {
  lastChecked: string;      // ISO
  daysSince: number;
  openCases: number;        // placeholder
  priority: Priority;
  /** Persisted outcome from localStorage, if any. */
  outcome?: NoticeOutcome;
}

const PRIORITY_TINT: Record<Priority, { bg: string; fg: string; label: string }> = {
  due:  { bg: '#FDE7EA', fg: '#B91C1C', label: 'Due this week' },
  soon: { bg: '#FEF3C7', fg: '#B45309', label: 'Coming up' },
  ok:   { bg: '#E7F5EE', fg: '#166534', label: 'Recently checked' },
};

function makeCheckState(clientId: string, log: NoticeCheckLog): CheckState {
  const stored = log[clientId];
  if (stored) {
    // Persisted outcome wins — days-since is measured from the real timestamp.
    const daysSince = daysSinceISO(stored.lastCheckedAt);
    const priority: Priority = daysSince >= 7 ? 'due' : daysSince >= 4 ? 'soon' : 'ok';
    return {
      lastChecked: stored.lastCheckedAt,
      daysSince,
      // Once a case is queued we keep showing it as an open case until the
      // real engine advances the state; deterministic placeholder for others.
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

  const markCheck = (clientId: string, outcome: NoticeOutcome) => {
    const next = writeNoticeCheck(clientId, outcome);
    setLog(next);
  };

  const resetLog = () => {
    if (!confirm('Clear the local notice-check log for every client?')) return;
    clearNoticeLog();
    setLog({});
  };
  const loggedCount = Object.keys(log).length;

  const filtered = filter === 'all' ? rows : rows.filter((r) => r.state.priority === filter);

  const summary = useMemo(() => {
    const acc = { due: 0, soon: 0, ok: 0, cases_open: 0 };
    for (const r of rows) {
      acc[r.state.priority]++;
      acc.cases_open += r.state.openCases;
    }
    return acc;
  }, [rows]);

  const service = findGstService('notice-reply');

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
          <span className="inline-flex items-center justify-center w-12 h-12 rounded-lg bg-neutral-100 text-neutral-700 shrink-0" aria-hidden>
            <BellRing size={22} strokeWidth={1.75} />
          </span>
          <div>
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Workstation · Services · GST</div>
            <h1 className="text-20 font-semibold text-neutral-900 mt-1">Weekly notice check</h1>
            <p className="text-13 text-neutral-500 mt-1 max-w-[720px]">
              The portal doesn’t push reliably. A missed ASMT-10 becomes a DRC-01 becomes a
              demand order. Walk the list, check each client on the portal, log the outcome.
              {service ? (
                <>
                  {' '}Open Notice Reply cases live under{' '}
                  <Link to="/workstation/services/gst/notice-reply/workspace" className="text-gold hover:text-gold-hover font-medium">
                    the Notice Reply pipeline
                  </Link>.
                </>
              ) : null}
            </p>
          </div>
        </div>
        {loggedCount > 0 ? (
          <div className="flex items-center gap-3 text-12 text-neutral-500">
            <span>{loggedCount} client{loggedCount === 1 ? '' : 's'} logged locally</span>
            <button
              type="button"
              onClick={resetLog}
              className="inline-flex items-center gap-1 h-8 px-3 font-medium text-neutral-700 border border-neutral-200 rounded-md hover:bg-neutral-50"
            >
              Reset log
            </button>
          </div>
        ) : null}
      </header>

      {/* Summary strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryTile
          label="Due this week"
          value={summary.due}
          icon={<AlertOctagon size={18} strokeWidth={1.75} />}
          tone={PRIORITY_TINT.due}
          active={filter === 'due'}
          onClick={() => setFilter((f) => (f === 'due' ? 'all' : 'due'))}
        />
        <SummaryTile
          label="Coming up"
          value={summary.soon}
          icon={<CalendarClock size={18} strokeWidth={1.75} />}
          tone={PRIORITY_TINT.soon}
          active={filter === 'soon'}
          onClick={() => setFilter((f) => (f === 'soon' ? 'all' : 'soon'))}
        />
        <SummaryTile
          label="Recently checked"
          value={summary.ok}
          icon={<Check size={18} strokeWidth={1.75} />}
          tone={PRIORITY_TINT.ok}
          active={filter === 'ok'}
          onClick={() => setFilter((f) => (f === 'ok' ? 'all' : 'ok'))}
        />
        <SummaryTile
          label="Open cases"
          value={summary.cases_open}
          icon={<ClipboardCheck size={18} strokeWidth={1.75} />}
          tone={{ bg: '#E6EEFC', fg: '#1D4ED8' }}
        />
      </section>

      {/* Table */}
      <section className="bg-white border border-neutral-200 rounded-lg shadow-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-neutral-50 border-b border-neutral-200">
              {['Client', 'GSTIN', 'Last checked', 'Priority', 'Open cases', 'Action'].map((h) => (
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
                <td colSpan={6} className="px-4 py-8 text-center text-13 text-neutral-500">
                  Loading clients…
                </td>
              </tr>
            ) : clientsQuery.isError ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-13 text-danger">
                  Could not load clients.
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-13 text-neutral-500">
                  {rows.length === 0
                    ? 'No clients to check.'
                    : 'No clients match this filter.'}
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
        v1.5: Outcomes ("No notices" / "Found notice") persist in this browser via localStorage
        under <code className="text-neutral-700">audit-os:gst-notice-check</code>. The
        "days since last check" figure re-derives from the timestamp on every render so it
        keeps ticking accurately. Server-side audit log, real Notice Reply case creation and
        cross-device sync land with the engine — spec §3.4, tracked as a follow-up.
      </p>
    </div>
  );
}

function SummaryTile({
  label, value, icon, tone, active, onClick,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: { bg: string; fg: string };
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={
        'text-left bg-white border rounded-lg shadow-card p-4 transition-colors ' +
        (active
          ? 'border-neutral-400'
          : 'border-neutral-200 ' + (onClick ? 'hover:border-neutral-300' : ''))
      }
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className="inline-flex items-center justify-center w-9 h-9 rounded-md shrink-0"
          style={{ backgroundColor: tone.bg, color: tone.fg }}
          aria-hidden
        >
          {icon}
        </span>
      </div>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mt-3">{label}</div>
      <div className="text-28 font-semibold text-neutral-900 tabular-nums mt-1">{value}</div>
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
  // Once persisted, show the outcome as the action column; the operator can
  // re-check by clicking a button that reverts to the "pending" view.
  const persisted = state.outcome;

  return (
    <tr className="border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50/50">
      <td className="px-4 py-3">
        <div className="text-14 font-medium text-neutral-900">{client.company_name}</div>
      </td>
      <td className="px-4 py-3 text-13 text-neutral-700 font-mono">
        {client.gstin ?? <span className="text-neutral-400">not registered</span>}
      </td>
      <td className="px-4 py-3 text-13 tabular-nums">
        <div className="text-neutral-700">
          {new Date(state.lastChecked).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
        </div>
        <div className="text-11 text-neutral-500">
          {state.daysSince === 0 ? 'today' : `${state.daysSince}d ago`}
        </div>
      </td>
      <td className="px-4 py-3">
        <span
          className="inline-flex items-center h-6 px-2 text-11 font-medium rounded-md whitespace-nowrap"
          style={{ backgroundColor: tint.bg, color: tint.fg }}
        >
          {tint.label}
        </span>
      </td>
      <td className="px-4 py-3">
        {state.openCases > 0 ? (
          <Link
            to="/workstation/services/gst/notice-reply/workspace"
            className="inline-flex items-center gap-1 text-13 text-danger font-medium"
          >
            <Bell size={14} strokeWidth={2} />
            {state.openCases}
          </Link>
        ) : (
          <span className="text-13 text-neutral-400">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        {persisted === 'clear' ? (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1 text-12 font-medium text-success">
              <Check size={14} strokeWidth={2.25} />
              No notices — logged
            </span>
            <button
              type="button"
              onClick={() => onMark('found')}
              className="text-12 text-neutral-500 hover:text-neutral-900 underline"
            >
              Change to Found notice
            </button>
          </div>
        ) : persisted === 'found' ? (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1 text-12 font-medium text-danger">
              <BellRing size={14} strokeWidth={2} />
              Case queued (engine follow-up)
            </span>
            <button
              type="button"
              onClick={() => onMark('clear')}
              className="text-12 text-neutral-500 hover:text-neutral-900 underline"
            >
              Change to No notices
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <a
              href={portalUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`After login, follow: ${NOTICE_PATH.join(' › ')}`}
              className="inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-white bg-gold hover:bg-gold-hover rounded-md"
            >
              <ExternalLink size={12} strokeWidth={2} />
              Check now
            </a>
            <button
              type="button"
              onClick={() => onMark('clear')}
              className="inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-neutral-700 border border-neutral-200 rounded-md hover:bg-neutral-50"
            >
              No notices
            </button>
            <button
              type="button"
              onClick={() => onMark('found')}
              className="inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-danger border border-neutral-200 rounded-md hover:bg-neutral-50"
            >
              Found notice
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}
