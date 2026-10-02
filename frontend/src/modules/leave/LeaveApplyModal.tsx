/**
 * Leave apply modal with live day-count preview.
 *
 * The count in the preview is computed client-side using the same
 * lib/leaveDays helper the server uses. The server recomputes on submit and
 * stores its own count — the preview is a hint, not a contract (per §8.3
 * "show the computed day count before submission").
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/platform/auth/AuthContext';
import { leaveApi, type BalanceRow } from './api';
import { computeWorkingDays } from '@/lib/leaveDays';
import { istToday, daysBetween } from '@/lib/dates';
import { api } from '@/services/api';
import type { LeaveType, WorkSchedule } from '@/data/models';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function LeaveApplyModal({ open, onClose }: Props) {
  const { session } = useAuth();
  const employeeId = session?.employee?.id ?? null;
  const qc = useQueryClient();
  const toast = useToast();

  const holidaysQ = useQuery({
    queryKey: ['leaves', 'holidays'],
    queryFn: leaveApi.holidays,
    staleTime: 5 * 60_000,
  });
  const balancesQ = useQuery({
    queryKey: ['leaves', 'balances', employeeId],
    queryFn: () => leaveApi.balances(employeeId!),
    enabled: !!employeeId && open,
  });
  // Fetch the caller's work schedule so the client preview matches the
  // server's rule set. Fallback stays in place for the brief window before
  // the query resolves, and if the endpoint is ever removed the preview
  // degrades gracefully rather than crashing.
  const scheduleQ = useQuery({
    queryKey: ['settings', 'work-schedule', 'mine'],
    queryFn: () => api.get<{ schedule: WorkSchedule }>(`/api/settings/work-schedules/mine`),
    enabled: !!employeeId && open,
    staleTime: 60_000,
  });
  const schedule: WorkSchedule = scheduleQ.data?.schedule ?? {
    id: 'ws-standard',
    organisation_id: '',
    name: 'Standard',
    standard_start: '09:30',
    standard_end: '18:30',
    full_day_hours: 8,
    half_day_hours: 4,
    break_minutes: 60,
    working_days: [1, 2, 3, 4, 5, 6],
    alternate_saturday_off: true,
    created_at: '',
    updated_at: '',
    created_by: null,
    updated_by: null,
    deleted_at: null,
  };
  const holidays = holidaysQ.data?.items ?? [];

  const [typeId, setTypeId] = useState<string>('');
  const [start, setStart] = useState<string>(istToday());
  const [end, setEnd] = useState<string>(istToday());
  const [halfDay, setHalfDay] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const selectedType: LeaveType | null = useMemo(() => {
    return balancesQ.data?.items.find((b) => b.type.id === typeId)?.type ?? null;
  }, [balancesQ.data, typeId]);

  const balanceRow = useMemo(() => {
    return balancesQ.data?.items.find((b) => b.type.id === typeId) ?? null;
  }, [balancesQ.data, typeId]);

  const days = useMemo(() => {
    if (!start || !end) return 0;
    if (halfDay && start !== end) return 0;
    return computeWorkingDays({
      startISO: start,
      endISO: end,
      halfDay,
      schedule,
      holidays,
    });
  }, [start, end, halfDay, holidays, schedule]);

  const validation = useMemo(() => {
    if (!selectedType) return { ok: false, note: 'Choose a leave type.' };
    if (start > end) return { ok: false, note: 'End date must be on or after start.' };
    if (halfDay && !selectedType.half_day_allowed) {
      return { ok: false, note: `${selectedType.name} does not allow half-day.` };
    }
    if (halfDay && start !== end) {
      return { ok: false, note: 'Half-day must be a single date.' };
    }
    const today = istToday();
    const daysUntil = daysBetween(today, start);
    if (daysUntil < 0 && selectedType.min_notice_days > 0) {
      return { ok: false, note: `${selectedType.name} cannot be past-dated.` };
    }
    if (daysUntil >= 0 && daysUntil < selectedType.min_notice_days) {
      return {
        ok: false,
        note: `${selectedType.name} needs ${selectedType.min_notice_days} day(s) of notice.`,
      };
    }
    if (days <= 0) return { ok: false, note: 'No working days in this range.' };
    if (selectedType.code !== 'lop' && balanceRow) {
      const available =
        balanceRow.entitled + balanceRow.carried_forward - balanceRow.availed - balanceRow.pending;
      if (days > available) {
        return {
          ok: false,
          note: `Insufficient balance — ${available.toFixed(1)} available, ${days.toFixed(1)} requested.`,
        };
      }
    }
    return { ok: true, note: null };
  }, [selectedType, start, end, halfDay, days, balanceRow]);

  const approvalHint = useMemo(() => {
    if (days > 5) return 'Reporting Manager, then HR Admin';
    return 'Reporting Manager';
  }, [days]);

  const submit = useMutation({
    mutationFn: leaveApi.apply,
    onSuccess: () => {
      toast.push('success', 'Leave request submitted.');
      qc.invalidateQueries({ queryKey: ['leaves'] });
      // Attendance list may already have same-date rows; invalidate so the
      // pending correction indicator and "On Leave" flip render on approval.
      qc.invalidateQueries({ queryKey: ['attendance'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  if (!open) return null;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!validation.ok || !selectedType) {
      setError(validation.note ?? 'Please complete the form.');
      return;
    }
    submit.mutate({
      leave_type_id: selectedType.id,
      start_date: start,
      end_date: end,
      half_day: halfDay,
      reason: reason.trim(),
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="leave-apply-title"
      className="fixed inset-0 z-40 grid place-items-center bg-neutral-900/30 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="leave-apply-modal"
    >
      <div className="w-full max-w-[560px] bg-white border border-neutral-200 rounded shadow-drawer p-6">
        <div className="flex items-baseline justify-between">
          <h2 id="leave-apply-title" className="text-20 font-semibold text-neutral-900">
            Apply for leave
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-13 text-neutral-500 hover:text-neutral-900"
            aria-label="Close"
          >
            Close
          </button>
        </div>

        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <label className="block">
            <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">
              Type
            </span>
            <select
              value={typeId}
              onChange={(e) => setTypeId(e.target.value)}
              className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded w-full"
              data-testid="leave-type"
            >
              <option value="">Select a type</option>
              {balancesQ.data?.items.map((b) => (
                <option key={b.type.id} value={b.type.id}>
                  {b.type.name}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Start date"
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              required
            />
            <Input
              label="End date"
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              required
            />
          </div>

          <label className="flex items-center gap-2 text-13 text-neutral-700">
            <input
              type="checkbox"
              checked={halfDay}
              onChange={(e) => setHalfDay(e.target.checked)}
              disabled={!selectedType?.half_day_allowed}
              data-testid="leave-half-day"
            />
            Half-day
            {selectedType && !selectedType.half_day_allowed ? (
              <span className="text-11 text-neutral-500 ml-1">
                (not allowed for {selectedType.name})
              </span>
            ) : null}
          </label>

          <label className="block">
            <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">
              Reason
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              required
              className="block w-full px-3 py-2 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
            />
          </label>

          {/* Preview */}
          <PreviewPanel
            days={days}
            balanceRow={balanceRow}
            approvalHint={approvalHint}
            validation={validation}
          />

          {error ? (
            <div className="text-12 text-red border-l-2 border-red pl-2">{error}</div>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={!validation.ok || submit.isPending}
              data-testid="leave-submit"
            >
              {submit.isPending ? 'Submitting…' : 'Submit'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function PreviewPanel({
  days,
  balanceRow,
  approvalHint,
  validation,
}: {
  days: number;
  balanceRow: BalanceRow | null;
  approvalHint: string;
  validation: { ok: boolean; note: string | null };
}) {
  const remaining = balanceRow
    ? balanceRow.entitled + balanceRow.carried_forward - balanceRow.availed - balanceRow.pending - days
    : null;
  return (
    <div
      className="border-l-2 border-neutral-200 pl-3 text-13 space-y-1"
      data-testid="leave-preview"
    >
      <div className="flex items-baseline gap-4 tabular-nums">
        <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">Days</span>
        <span className="text-neutral-900 font-medium" data-testid="leave-days">
          {isNaN(days) ? '—' : days.toFixed(1)}
        </span>
      </div>
      {balanceRow ? (
        <div className="flex items-baseline gap-4 tabular-nums">
          <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">
            Balance after
          </span>
          <span className="text-neutral-900" data-testid="leave-balance-after">
            {remaining == null ? '—' : remaining.toFixed(1)}
          </span>
        </div>
      ) : null}
      <div className="flex items-baseline gap-4">
        <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">Approver</span>
        <span className="text-neutral-700">{approvalHint}</span>
      </div>
      {!validation.ok && validation.note ? (
        <div className="text-12 text-amber pt-1">{validation.note}</div>
      ) : null}
    </div>
  );
}
