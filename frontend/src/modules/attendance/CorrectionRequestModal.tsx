/**
 * Employee-facing correction request. 7-day window enforced server-side;
 * this UI gates the date input but the API is the security control.
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { attendanceApi } from './api';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { addDays, istToday } from '@/lib/dates';

interface Props {
  open: boolean;
  defaultDate?: string;
  onClose: () => void;
}

/**
 * Build an IST-local wall-clock ISO from date + HH:mm. We construct the
 * timestamp as UTC minus 5:30 so `istTimeOf(result)` returns the entered HH:mm.
 */
function istWallToUTC(dateISO: string, hhmm: string): string {
  if (!hhmm) return '';
  const [y, m, d] = dateISO.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d, hh, mm) - 330 * 60_000);
  return utc.toISOString();
}

export function CorrectionRequestModal({ open, defaultDate, onClose }: Props) {
  const today = istToday();
  const min = addDays(today, -7);

  const [date, setDate] = useState(defaultDate ?? today);
  const [checkIn, setCheckIn] = useState('09:30');
  const [checkOut, setCheckOut] = useState('18:30');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const submit = useMutation({
    mutationFn: attendanceApi.requestCorrection,
    onSuccess: () => {
      toast.push('success', 'Correction submitted — your manager will review it.');
      qc.invalidateQueries({ queryKey: ['attendance'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  if (!open) return null;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!reason.trim()) {
      setError('A reason is required.');
      return;
    }
    if (!checkIn && !checkOut) {
      setError('Enter at least one requested time.');
      return;
    }
    submit.mutate({
      date,
      requested_check_in_at: checkIn ? istWallToUTC(date, checkIn) : undefined,
      requested_check_out_at: checkOut ? istWallToUTC(date, checkOut) : undefined,
      reason: reason.trim(),
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="correction-title"
      className="fixed inset-0 z-40 grid place-items-center bg-neutral-900/30 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="correction-modal"
    >
      <div className="w-full max-w-[420px] bg-white border border-neutral-200 rounded shadow-drawer p-6">
        <div className="flex items-baseline justify-between">
          <h2 id="correction-title" className="text-20 font-semibold text-neutral-900">
            Request correction
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
        <p className="text-13 text-neutral-500 mt-1">
          For dates within the last 7 days. Manager or HR will review.
        </p>

        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <Input
            label="Date"
            type="date"
            value={date}
            min={min}
            max={today}
            onChange={(e) => setDate(e.target.value)}
            required
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Requested check-in"
              type="time"
              value={checkIn}
              onChange={(e) => setCheckIn(e.target.value)}
            />
            <Input
              label="Requested check-out"
              type="time"
              value={checkOut}
              onChange={(e) => setCheckOut(e.target.value)}
            />
          </div>
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
              placeholder="Meeting at client office ran long; forgot to check out."
            />
          </label>
          {error ? (
            <div className="text-12 text-red border-l-2 border-red pl-2">{error}</div>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={submit.isPending}>
              {submit.isPending ? 'Submitting…' : 'Submit'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
