import { useEffect, useState } from 'react';
import { formatMinutes, type Task } from './api';

/**
 * Small presentation pieces shared by the Task screens. Kept here rather
 * than added to modules/workstation/components.tsx so the existing shared
 * component file is untouched.
 */

/** Priority pill. Urgent and high read at a glance; low stays quiet. */
export function Priority({ value }: { value: string }) {
  const tone =
    value === 'urgent' ? 'bg-red/10 text-red border-red/30'
    : value === 'high' ? 'bg-amber/10 text-amber-700 border-amber/40'
    : value === 'medium' ? 'bg-neutral-100 text-neutral-700 border-neutral-200'
    : 'bg-neutral-50 text-neutral-500 border-neutral-200';
  return (
    <span className={`inline-block text-11 px-1.5 py-0.5 rounded border capitalize ${tone}`}>{value}</span>
  );
}

/**
 * Task status. `paused` and the overdue flag are not in the shared status
 * vocabulary, so this renders them itself rather than changing that file.
 */
export function TaskStatusPill({ status, overdue }: { status: string; overdue?: boolean }) {
  const tone =
    status === 'completed' ? 'bg-green/10 text-green-700 border-green/30'
    : status === 'in_progress' ? 'bg-blue-50 text-blue-700 border-blue-200'
    : status === 'paused' ? 'bg-amber/10 text-amber-700 border-amber/40'
    : status === 'cancelled' ? 'bg-neutral-100 text-neutral-500 border-neutral-200'
    : 'bg-neutral-50 text-neutral-600 border-neutral-200';
  const label = status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block text-11 px-1.5 py-0.5 rounded border ${tone}`}>{label}</span>
      {overdue ? <span className="inline-block text-11 px-1.5 py-0.5 rounded border bg-red/10 text-red border-red/30">Overdue</span> : null}
    </span>
  );
}

/**
 * The live elapsed-time display for a running task.
 *
 * THIS IS DECORATION. It starts from the server's banked minutes plus the
 * server's open-session start time, and ticks locally only so the number
 * moves. Every refresh, and every action, replaces it with what the database
 * says — the browser's clock never becomes the record.
 */
export function useLiveMinutes(task: Pick<Task, 'running' | 'actual_minutes' | 'current_session_started_at'>): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!task.running) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [task.running]);

  if (!task.running || !task.current_session_started_at) return task.actual_minutes;
  // actual_minutes already includes the open session up to the moment the
  // server answered; recompute from the session start so the two never
  // double-count.
  const bankedBeforeSession = Math.max(
    0,
    task.actual_minutes - Math.round((Date.now() - Date.parse(task.current_session_started_at)) / 60_000),
  );
  const openFor = Math.max(0, Math.round((Date.now() - Date.parse(task.current_session_started_at)) / 60_000));
  return bankedBeforeSession + openFor;
}

/** A running task's timer, to the second, for the detail page. */
export function LiveTimer({ startedAt, bankedMinutes }: { startedAt: string; bankedMinutes: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const openSeconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const openMinutes = Math.floor(openSeconds / 60);
  const banked = Math.max(0, bankedMinutes - openMinutes);
  const totalSeconds = banked * 60 + openSeconds;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return (
    <span className="tabular-nums font-medium" title="Ticking locally; the database holds the real total">
      {h > 0 ? `${h}:` : ''}{String(m).padStart(h > 0 ? 2 : 1, '0')}:{String(s).padStart(2, '0')}
    </span>
  );
}

/** Estimated vs actual, coloured only when there is an estimate to compare. */
export function Variance({ minutes }: { minutes: number | null }) {
  if (minutes === null) return <span className="text-neutral-400">—</span>;
  if (minutes === 0) return <span className="text-neutral-600">on estimate</span>;
  const over = minutes > 0;
  return (
    <span className={over ? 'text-amber-700 tabular-nums' : 'text-green-700 tabular-nums'}>
      {over ? '+' : '−'}{formatMinutes(Math.abs(minutes))}
    </span>
  );
}
