/**
 * Corrections queue — approve/reject workflow for managers + HR.
 * Employees see their own submitted corrections in a read-only list.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { attendanceApi, type CorrectionWithEmployee } from './api';
import { fmtDate, fmtTime } from '@/lib/format';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { StatusLabel } from '@/components/StatusRow';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';

export function CorrectionsQueue() {
  const { session } = useAuth();
  const canReview =
    can(session?.role.code, 'attendance.correct.approve', 'department') ||
    can(session?.role.code, 'attendance.correct.approve', 'organisation');

  const [statusFilter, setStatusFilter] = useState<'' | 'pending' | 'approved' | 'rejected'>(
    canReview ? 'pending' : '',
  );

  const query = useQuery({
    queryKey: ['attendance', 'corrections', statusFilter],
    queryFn: () => attendanceApi.listCorrections(statusFilter || undefined),
  });

  return (
    <section className="space-y-4" data-testid="corrections-queue">
      <div className="flex items-end gap-3">
        <label className="block">
          <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">
            Status
          </span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded"
          >
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </label>
      </div>

      <div className="bg-white border border-neutral-200 rounded overflow-hidden">
        {query.isLoading ? (
          <div className="h-40 bg-neutral-100" aria-label="Loading corrections" />
        ) : (query.data?.items.length ?? 0) === 0 ? (
          <div className="p-6">
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">
              No corrections
            </div>
            <p className="text-13 text-neutral-500 mt-1">
              {canReview
                ? 'Your team has no pending corrections.'
                : 'You have not submitted any corrections.'}
            </p>
          </div>
        ) : (
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                {['Requester', 'Date', 'Requested check-in', 'Requested check-out', 'Reason', 'Status', canReview ? 'Actions' : null]
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
              {query.data!.items.map((c) => (
                <CorrectionRow key={c.id} row={c} canReview={canReview} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function CorrectionRow({ row, canReview }: { row: CorrectionWithEmployee; canReview: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [notes, setNotes] = useState('');

  const approve = useMutation({
    mutationFn: () => attendanceApi.approveCorrection(row.id),
    onSuccess: () => {
      toast.push('success', 'Correction approved.');
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const reject = useMutation({
    mutationFn: () => attendanceApi.rejectCorrection(row.id, notes),
    onSuccess: () => {
      toast.push('success', 'Correction rejected.');
      qc.invalidateQueries({ queryKey: ['attendance'] });
      setRejecting(false);
      setNotes('');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const statusLabel =
    row.status === 'pending' ? 'Pending' : row.status === 'approved' ? 'Approved' : 'Rejected';
  const statusVariant =
    row.status === 'pending' ? 'pending' : row.status === 'approved' ? 'ok' : 'problem';

  return (
    <tr className="border-b border-neutral-200 align-top">
      <td className="px-3 py-3">
        <div className="text-13 text-neutral-900">{row.employee?.full_name ?? '—'}</div>
        <div className="text-11 text-neutral-500">{row.employee?.employee_code ?? ''}</div>
      </td>
      <td className="px-3 py-3 text-13 text-neutral-900">{fmtDate(row.date + 'T00:00:00Z')}</td>
      <td className="px-3 py-3 text-13 text-neutral-900">
        {row.requested_check_in_at ? fmtTime(row.requested_check_in_at) : <span className="text-neutral-400">—</span>}
      </td>
      <td className="px-3 py-3 text-13 text-neutral-900">
        {row.requested_check_out_at ? fmtTime(row.requested_check_out_at) : <span className="text-neutral-400">—</span>}
      </td>
      <td className="px-3 py-3 text-13 text-neutral-700 max-w-[280px]">{row.reason}</td>
      <td className="px-3 py-3">
        <StatusLabel variant={statusVariant} label={statusLabel} />
        {row.review_notes ? (
          <div className="text-11 text-neutral-500 mt-1">Note: {row.review_notes}</div>
        ) : null}
      </td>
      {canReview ? (
        <td className="px-3 py-3">
          {row.status !== 'pending' ? (
            <span className="text-11 text-neutral-500">
              Reviewed {row.reviewed_at ? fmtDate(row.reviewed_at) : ''}
            </span>
          ) : rejecting ? (
            <div className="flex flex-col gap-2 w-[220px]">
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Reason for rejection"
                className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded"
              />
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  data-testid={`reject-confirm-${row.id}`}
                  onClick={() => reject.mutate()}
                  disabled={!notes.trim() || reject.isPending}
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
                data-testid={`approve-${row.id}`}
                onClick={() => approve.mutate()}
                disabled={approve.isPending}
              >
                Approve
              </Button>
              <Button
                variant="secondary"
                data-testid={`reject-${row.id}`}
                onClick={() => setRejecting(true)}
              >
                Reject
              </Button>
            </div>
          )}
        </td>
      ) : null}
    </tr>
  );
}
