/**
 * Today's attendance card — the hero widget (§6.2).
 *
 * State machine:
 *   not_checked_in  → CHECK IN button (primary, gold)
 *   in_progress     → CHECK OUT + live worked-time counter
 *   done            → "Attendance completed · 08h 49m"
 *   on_leave        → "On leave today — Casual Leave"
 *   non_working_day → "Weekly off"    (holiday integration lands with Leave module)
 *   missing         → correction hint
 *
 * Off-site (client_site/field) requires a reason before submit.
 */
import { useEffect, useState, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { attendanceApi } from './api';
import { useGeolocation } from './useGeolocation';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { fmtTime, fmtDuration } from '@/lib/format';
import { istTimeOf } from '@/lib/dates';
import type { LocationType } from '@/data/models';

type OffSiteType = Exclude<LocationType, 'office'>;

export function TodayCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['attendance', 'today'],
    queryFn: attendanceApi.today,
  });

  const [showOffSite, setShowOffSite] = useState(false);
  const [offSiteType, setOffSiteType] = useState<OffSiteType>('client_site');
  const [reason, setReason] = useState('');
  const [poorGPS, setPoorGPS] = useState<null | string>(null);
  const geo = useGeolocation();

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
    onSuccess: (res) => {
      const location = res.location.name ?? 'off-site';
      toast.push('success', `Checked in · ${location}`);
      setShowOffSite(false);
      setReason('');
      setPoorGPS(null);
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

  async function submitCheckIn(locationType: LocationType = 'office') {
    setPoorGPS(null);
    if (locationType !== 'office' && !reason.trim()) {
      toast.push('error', 'Please provide a reason for off-site check-in.');
      return;
    }
    const g = await geo.request();
    if (g.status !== 'granted') {
      if (g.status === 'denied') toast.push('error', 'Location access is required to check in.');
      else if (g.status === 'unavailable')
        toast.push('error', 'This browser does not support geolocation.');
      else if (g.status === 'error') toast.push('error', g.message);
      return;
    }
    if (g.accuracy > 100) {
      setPoorGPS(`Poor GPS signal (±${Math.round(g.accuracy)}m). Move to an open area and retry.`);
      return;
    }
    checkIn.mutate({
      latitude: g.latitude,
      longitude: g.longitude,
      accuracy_m: g.accuracy,
      location_type: locationType,
      off_site_reason: locationType !== 'office' ? reason.trim() : undefined,
    });
  }

  async function submitCheckOut() {
    const g = await geo.request();
    if (g.status !== 'granted') {
      if (g.status === 'denied') toast.push('error', 'Location access is required to check out.');
      else toast.push('error', 'Could not get your location.');
      return;
    }
    checkOut.mutate({
      latitude: g.latitude,
      longitude: g.longitude,
      accuracy_m: g.accuracy,
    });
  }

  if (isLoading) return <CardShell><LoadingBlock /></CardShell>;
  if (isError)
    return (
      <CardShell>
        <ErrorBlock retry={() => refetch()} />
      </CardShell>
    );

  return (
    <CardShell>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Today</div>
      <div className="mt-2 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <TimesRow row={today} live={workedNow} stage={stage} />
        </div>
        <div className="flex items-center gap-2" data-testid="today-card-actions">
          {stage === 'not_checked_in' && !showOffSite && (
            <>
              <Button
                variant="primary"
                data-testid="check-in"
                onClick={() => submitCheckIn('office')}
                disabled={checkIn.isPending || geo.state.status === 'requesting'}
              >
                {geo.state.status === 'requesting'
                  ? 'Checking your location…'
                  : checkIn.isPending
                    ? 'Checking in…'
                    : 'Check in'}
              </Button>
              <Button
                variant="ghost"
                data-testid="check-in-off-site-toggle"
                onClick={() => setShowOffSite(true)}
              >
                Off-site
              </Button>
            </>
          )}
          {stage === 'not_checked_in' && showOffSite && (
            <OffSiteForm
              type={offSiteType}
              onType={setOffSiteType}
              reason={reason}
              onReason={setReason}
              onCancel={() => {
                setShowOffSite(false);
                setReason('');
              }}
              onSubmit={() => submitCheckIn(offSiteType)}
              busy={checkIn.isPending || geo.state.status === 'requesting'}
            />
          )}
          {stage === 'in_progress' && (
            <Button
              variant="primary"
              data-testid="check-out"
              onClick={submitCheckOut}
              disabled={checkOut.isPending || geo.state.status === 'requesting'}
            >
              {geo.state.status === 'requesting'
                ? 'Checking your location…'
                : checkOut.isPending
                  ? 'Checking out…'
                  : 'Check out'}
            </Button>
          )}
          {stage === 'done' && (
            <span className="text-13 text-neutral-500">Attendance completed</span>
          )}
        </div>
      </div>
      {poorGPS ? (
        <div className="mt-3 text-12 text-red border-l-2 border-red pl-2">{poorGPS}</div>
      ) : null}
      {geo.state.status === 'denied' ? (
        <div className="mt-3 text-12 text-red border-l-2 border-red pl-2">
          Location access is required. Enable location for this site in your browser settings.
        </div>
      ) : null}
      {stage === 'in_progress' && today?.location_type && today.location_type !== 'office' ? (
        <div className="mt-3 text-12 text-neutral-500 border-l-2 border-amber pl-2">
          Off-site check-in ({today.location_type}) — flagged for manager review.
        </div>
      ) : null}
    </CardShell>
  );
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white border border-neutral-200 rounded p-4" data-testid="today-card">
      {children}
    </div>
  );
}

function LoadingBlock() {
  return (
    <div className="h-16 bg-neutral-100" aria-label="Loading today's attendance" />
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
    return <div className="text-16 text-neutral-900">On leave today</div>;
  }
  if (stage === 'not_checked_in' || !row?.check_in_at) {
    return (
      <div>
        <div className="text-16 text-neutral-900">Not checked in yet</div>
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
      <div className="text-16 text-neutral-900 tabular-nums" data-testid="today-times">
        {inHHMM}
        <span className="mx-2 text-neutral-400">→</span>
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

function OffSiteForm({
  type,
  onType,
  reason,
  onReason,
  onCancel,
  onSubmit,
  busy,
}: {
  type: OffSiteType;
  onType: (t: OffSiteType) => void;
  reason: string;
  onReason: (r: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap" data-testid="off-site-form">
      <select
        value={type}
        onChange={(e) => onType(e.target.value as OffSiteType)}
        className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded"
      >
        <option value="client_site">Client site</option>
        <option value="remote">Remote / WFH</option>
        <option value="field">Field visit</option>
      </select>
      <input
        type="text"
        placeholder="Reason (required)"
        value={reason}
        onChange={(e) => onReason(e.target.value)}
        className="h-8 px-3 text-13 bg-white border border-neutral-300 rounded w-[220px]"
        data-testid="off-site-reason"
      />
      <Button variant="primary" data-testid="check-in-off-site" onClick={onSubmit} disabled={busy}>
        Check in
      </Button>
      <Button variant="ghost" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
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
