/**
 * Requests list — dual purpose.
 *   - "mine"  : requester view (cancel button for pending/future-approved)
 *   - "queue" : approver view (Approve/Reject inline for the caller's stage)
 *
 * Left-border encoding: pending amber, rejected/cancelled red, approved none.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { leaveApi, type RequestWithEmp } from './api';
import { Button } from '@/components/Button';
import { StatusLabel, type StatusVariant } from '@/components/StatusRow';
import { useToast } from '@/components/Toast';
import { fmtDate } from '@/lib/format';
import { istToday } from '@/lib/dates';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';

interface Props {
  mode: 'mine' | 'queue';
}

export function RequestsList({ mode }: Props) {
  const { session } = useAuth();
  const canApprove =
    can(session?.role.code, 'leave.approve', 'department') ||
    can(session?.role.code, 'leave.approve', 'organisation');

  const q = useQuery({
    queryKey: ['leaves', mode === 'mine' ? 'mine' : 'queue'],
    queryFn: () =>
      mode === 'mine'
        ? leaveApi.list({ employeeId: session?.employee?.id })
        : leaveApi.list({ queue: true }),
    enabled: mode === 'mine' ? !!session?.employee?.id : true,
  });

  return (
    <section data-testid={`leave-list-${mode}`}>
      <div className="bg-white border border-neutral-200 rounded overflow-hidden">
        {q.isLoading ? (
          <div className="h-40 bg-neutral-100" aria-label="Loading requests" />
        ) : (q.data?.items.length ?? 0) === 0 ? (
          <Empty mode={mode} />
        ) : (
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                {[
                  mode === 'queue' ? 'Requester' : null,
                  'Type',
                  'Dates',
                  'Days',
                  'Reason',
                  'Status',
                  'Actions',
                ]
                  .filter(Boolean)
                  .map((c) => (
                    <th
                      key={c as string}
                      className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium"
                    >
                      {c as string}
                    </th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {q.data!.items.map((r) => (
                <Row key={r.id} row={r} mode={mode} canApprove={canApprove} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function Empty({ mode }: { mode: 'mine' | 'queue' }) {
  return (
    <div className="p-6">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">
        {mode === 'mine' ? 'No requests' : 'Empty queue'}
      </div>
      <p className="text-13 text-neutral-500 mt-1">
        {mode === 'mine'
          ? 'Apply for leave from the button above.'
          : 'Nothing needs your attention right now.'}
      </p>
    </div>
  );
}

function styleForStatus(r: RequestWithEmp): { variant: StatusVariant; label: string } {
  if (r.status === 'approved') return { variant: 'ok', label: 'Approved' };
  if (r.status === 'rejected') return { variant: 'problem', label: 'Rejected' };
  if (r.status === 'cancelled') return { variant: 'awaiting', label: 'Cancelled' };
  // pending — reveal chain stage
  if (r.stage === 'awaiting_hr') return { variant: 'pending', label: 'Awaiting HR' };
  return { variant: 'pending', label: 'Awaiting Manager' };
}

function Row({ row, mode, canApprove }: { row: RequestWithEmp; mode: 'mine' | 'queue'; canApprove: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const approve = useMutation({
    mutationFn: () => leaveApi.approve(row.id),
    onSuccess: () => {
      toast.push('success', 'Approved.');
      qc.invalidateQueries({ queryKey: ['leaves'] });
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const reject = useMutation({
    mutationFn: () => leaveApi.reject(row.id, reason),
    onSuccess: () => {
      toast.push('success', 'Rejected.');
      qc.invalidateQueries({ queryKey: ['leaves'] });
      setRejecting(false);
      setReason('');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const cancel = useMutation({
    mutationFn: () => leaveApi.cancel(row.id),
    onSuccess: () => {
      toast.push('success', 'Request cancelled.');
      qc.invalidateQueries({ queryKey: ['leaves'] });
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const s = styleForStatus(row);
  const border =
    s.variant === 'problem'
      ? 'border-red'
      : s.variant === 'pending'
        ? 'border-amber'
        : s.variant === 'awaiting'
          ? 'border-neutral-400'
          : 'border-transparent';

  const today = istToday();
  const canCancel =
    mode === 'mine' &&
    ((row.status === 'pending') ||
      (row.status === 'approved' && row.start_date > today));

  return (
    <tr className="border-b border-neutral-200 align-top" data-testid={`leave-row-${row.id}`}>
      {mode === 'queue' ? (
        <td className="px-3 py-3">
          <div className="text-13 text-neutral-900">{row.employee?.full_name ?? '—'}</div>
          <div className="text-11 text-neutral-500">{row.employee?.employee_code ?? ''}</div>
        </td>
      ) : null}
      <td className={`px-3 py-3 text-13 text-neutral-900 border-l-2 ${border}`}>
        {row.type?.name ?? '—'}
        {row.half_day ? <span className="ml-1 text-11 text-neutral-500">(half)</span> : null}
      </td>
      <td className="px-3 py-3 text-13 text-neutral-900">
        {fmtDate(row.start_date + 'T00:00:00Z')}
        {row.start_date !== row.end_date ? (
          <>
            {' → '}
            {fmtDate(row.end_date + 'T00:00:00Z')}
          </>
        ) : null}
      </td>
      <td className="px-3 py-3 text-13 text-neutral-900">
        {row.computed_working_days.toFixed(1)}
      </td>
      <td className="px-3 py-3 text-13 text-neutral-700 max-w-[240px]">{row.reason}</td>
      <td className="px-3 py-3">
        <StatusLabel variant={s.variant} label={s.label} />
        {row.rejection_reason ? (
          <div className="text-11 text-neutral-500 mt-1">Note: {row.rejection_reason}</div>
        ) : null}
      </td>
      <td className="px-3 py-3">
        {mode === 'queue' && canApprove && row.status === 'pending' ? (
          rejecting ? (
            <div className="flex flex-col gap-2 w-[220px]">
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason for rejection"
                className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded"
              />
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  disabled={!reason.trim() || reject.isPending}
                  onClick={() => reject.mutate()}
                  data-testid={`leave-reject-confirm-${row.id}`}
                >
                  Reject
                </Button>
                <Button variant="ghost" onClick={() => setRejecting(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                variant="primary"
                disabled={approve.isPending}
                onClick={() => approve.mutate()}
                data-testid={`leave-approve-${row.id}`}
              >
                Approve
              </Button>
              <Button
                variant="secondary"
                onClick={() => setRejecting(true)}
                data-testid={`leave-reject-${row.id}`}
              >
                Reject
              </Button>
            </div>
          )
        ) : canCancel ? (
          <Button
            variant="secondary"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
            data-testid={`leave-cancel-${row.id}`}
          >
            Cancel
          </Button>
        ) : null}
      </td>
    </tr>
  );
}
