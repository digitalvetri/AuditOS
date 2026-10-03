/**
 * Today's attendance card — the hero widget (§6.2).
 *
 * Simple check-in / check-out — the GPS geofence and off-site reason flow
 * were removed with the Work Locations concept. The server records the
 * timestamp when the user clicks; nothing more.
 *
 * State machine:
 *   not_checked_in  → CHECK IN button (primary)
 *   in_progress     → CHECK OUT + live worked-time counter
 *   done            → "Attendance completed · 08h 49m"
 *   on_leave        → "On leave today"
 *   missing         → correction hint
 */
import { useEffect, useState, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { attendanceApi } from './api';
import { CircleAlert, CircleCheck, Clock, Plane, Timer } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { fmtTime, fmtDuration } from '@/lib/format';
import { istTimeOf } from '@/lib/dates';

export function TodayCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['attendance', 'today'],
    queryFn: attendanceApi.today,
  });

  const today = data?.today ?? null;
  const stage: 'not_checked_in' | 'in_progress' | 'done' | 'on_leave' | 'missing' =
    today == null || !today.check_in_at
      ? today?.status === 'on_leave'
        ? 'on_leave'
        : today?.status === 'missing_check_in'
          ? 'missing'
          : 'not_checked_in'
      : today.check_out_at
        ? 'done'
        : 'in_progress';

  const workedNow = useLiveWorkedMinutes(today?.check_in_at ?? null, stage === 'in_progress');

  const checkIn = useMutation({
    mutationFn: attendanceApi.checkIn,
    onSuccess: () => {
      toast.push('success', 'Checked in');
      qc.invalidateQueries({ queryKey: ['attendance'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const checkOut = useMutation({
    mutationFn: attendanceApi.checkOut,
    onSuccess: (res) => {
      const worked = res.attendance.worked_minutes ?? 0;
      toast.push('success', `Checked out · ${fmtDuration(worked)}`);
      qc.invalidateQueries({ queryKey: ['attendance'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  if (isLoading) return <CardShell><LoadingBlock /></CardShell>;
  if (isError)
    return (
      <CardShell>
        <ErrorBlock retry={() => refetch()} />
      </CardShell>
    );

  return (
    <CardShell>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4 min-w-0">
          <StageBadge stage={stage} />
          <div className="min-w-0">
            <div className="text-12 font-medium text-neutral-500">
              Today · {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })}
            </div>
            <TimesRow row={today} live={workedNow} stage={stage} />
          </div>
        </div>
        <div className="flex items-center gap-2" data-testid="today-card-actions">
          {stage === 'not_checked_in' && (
            <Button
              variant="primary"
              data-testid="check-in"
              onClick={() => checkIn.mutate()}
              disabled={checkIn.isPending}
            >
              {checkIn.isPending ? 'Checking in…' : 'Check in'}
            </Button>
          )}
          {stage === 'in_progress' && (
            <Button
              variant="primary"
              data-testid="check-out"
              onClick={() => checkOut.mutate()}
              disabled={checkOut.isPending}
            >
              {checkOut.isPending ? 'Checking out…' : 'Check out'}
            </Button>
          )}
          {stage === 'done' && (
            <span className="inline-flex items-center gap-2 h-8 px-3 rounded-full text-13 font-medium bg-[#ecfdf5] text-[#047857]">
              <span className="rounded-full" style={{ background: '#10b981', width: 7, height: 7 }} />Attendance completed
            </span>
          )}
        </div>
      </div>
      {stage === 'in_progress' || stage === 'done' ? (
        <DayStats row={today} live={workedNow} done={stage === 'done'} />
      ) : null}
    </CardShell>
  );
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="dash-card p-5" data-testid="today-card">
      {children}
    </div>
  );
}

function LoadingBlock() {
  return (
    <div className="h-16 rounded-md bg-neutral-100" aria-label="Loading today's attendance" />
  );
}

function ErrorBlock({ retry }: { retry: () => void }) {
  return (
    <div>
      <div className="text-13 text-red">Could not load today's attendance.</div>
      <button type="button" onClick={retry} className="mt-2 text-13 text-gold hover:text-gold-hover">
        Try again
      </button>
    </div>
  );
}

function TimesRow({
  row,
  live,
  stage,
}: {
  row: { check_in_at: string | null; check_out_at: string | null; worked_minutes: number | null } | null;
  live: number;
  stage: string;
}) {
  if (stage === 'on_leave') {
    return <div className="text-18 font-semibold text-neutral-900 mt-px">On leave today</div>;
  }
  if (stage === 'not_checked_in' || !row?.check_in_at) {
    return (
      <div>
        <div className="text-18 font-semibold text-neutral-900 mt-px">Not checked in yet</div>
        <div className="text-13 text-neutral-500 mt-1">
          Standard hours 09:30 AM – 06:30 PM. Late after 09:45 AM.
        </div>
      </div>
    );
  }
  const inHHMM = fmtTime(row.check_in_at);
  const outHHMM = row.check_out_at ? fmtTime(row.check_out_at) : null;
  return (
    <div>
      <div className="num-display text-20 text-neutral-900 mt-px" data-testid="today-times">
        {inHHMM}
        <span className="mx-2 text-neutral-400 font-normal">→</span>
        {outHHMM ? outHHMM : <span className="text-neutral-400">—</span>}
      </div>
      <div className="text-13 text-neutral-500 mt-1 tabular-nums">
        {outHHMM
          ? `${fmtDuration(row.worked_minutes ?? 0)} worked`
          : `${fmtDuration(live)} elapsed (in progress)`}
        {row.check_in_at ? (
          <span className="ml-2 text-neutral-400">Started {istTimeOf(row.check_in_at)} IST</span>
        ) : null}
      </div>
    </div>
  );
}

/** The state at a glance: a tinted icon square in the state's colour. */
const STAGE_LOOK = {
  not_checked_in: { bg: '#f1f5f9', fg: '#475569', Icon: Clock },
  in_progress: { bg: '#e8eef8', fg: '#1a4b8c', Icon: Timer },
  done: { bg: '#e9f9f1', fg: '#047857', Icon: CircleCheck },
  on_leave: { bg: '#fff7e6', fg: '#b45309', Icon: Plane },
  missing: { bg: '#fef2f2', fg: '#b91c1c', Icon: CircleAlert },
} as const;

function StageBadge({ stage }: { stage: keyof typeof STAGE_LOOK }) {
  const { bg, fg, Icon } = STAGE_LOOK[stage];
  return (
    <span className="h-12 w-12 shrink-0 rounded-lg inline-flex items-center justify-center" style={{ background: bg, color: fg }} aria-hidden>
      <Icon size={22} strokeWidth={1.8} />
    </span>
  );
}

/** Check in · Check out · Worked, and how far through the 9-hour day. */
function DayStats({
  row, live, done,
}: {
  row: { check_in_at: string | null; check_out_at: string | null; worked_minutes: number | null } | null;
  live: number;
  done: boolean;
}) {
  const worked = done ? (row?.worked_minutes ?? 0) : live;
  const pct = Math.min(100, Math.round((worked / 540) * 100));
  const box = (label: string, value: string) => (
    <div className="rounded-md px-4 py-3" style={{ background: '#f4f6fa', border: '1px solid #e8ecf3' }}>
      <div className="text-12 text-neutral-500">{label}</div>
      <div className="num-display text-18 text-neutral-900 mt-px">{value}</div>
    </div>
  );
  return (
    <div className="mt-5">
      <div className="grid grid-cols-3 gap-3">
        {box('Check in', row?.check_in_at ? fmtTime(row.check_in_at) : '—')}
        {box('Check out', row?.check_out_at ? fmtTime(row.check_out_at) : '—')}
        {box('Worked', fmtDuration(worked))}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: '#e7ece9' }} aria-label={`${pct}% of the working day`}>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: done ? 'linear-gradient(90deg, #34d399, #10b981)' : 'linear-gradient(90deg, #60a5fa, #1a4b8c)' }} />
        </div>
        <span className="text-12 text-neutral-500 tabular-nums whitespace-nowrap">{pct}% of the 9h day</span>
      </div>
    </div>
  );
}

function useLiveWorkedMinutes(checkInAt: string | null, active: boolean): number {
  const start = useMemo(() => (checkInAt ? new Date(checkInAt).getTime() : null), [checkInAt]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 30_000); // update every 30s
    return () => clearInterval(id);
  }, [active]);
  if (!start) return 0;
  return Math.max(0, Math.floor((now - start) / 60_000));
}
