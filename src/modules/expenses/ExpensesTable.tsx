/**
 * Reusable expenses table.
 *   mode='mine'     — owner view (Submit, Edit-if-draft)
 *   mode='team'     — manager view (Approve, Reject)
 *   mode='finance'  — Finance view (Approve, Reject, Pay)
 *
 * Same table shape, gated actions per mode.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { expensesApi, STAGE_LABEL, type ExpenseWithRefs } from './api';
import { fmtDate, inr } from '@/lib/format';
import { StatusLabel, type StatusVariant } from '@/components/StatusRow';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import type { ExpenseStage } from '@/data/models';

interface Props {
  mode: 'mine' | 'team' | 'finance' | 'employee-profile';
  employeeId?: string;
}

function stageStyle(s: ExpenseStage): { variant: StatusVariant; label: string } {
  switch (s) {
    case 'draft': return { variant: 'awaiting', label: STAGE_LABEL.draft };
    case 'pending_manager': return { variant: 'pending', label: STAGE_LABEL.pending_manager };
    case 'pending_finance': return { variant: 'pending', label: STAGE_LABEL.pending_finance };
    case 'approved': return { variant: 'pending', label: STAGE_LABEL.approved };
    case 'paid': return { variant: 'ok', label: STAGE_LABEL.paid };
    case 'rejected': return { variant: 'problem', label: STAGE_LABEL.rejected };
  }
}

export function ExpensesTable({ mode, employeeId }: Props) {
  const q = useQuery({
    queryKey: ['expenses', mode, employeeId ?? null],
    queryFn: () => {
      if (mode === 'mine') return expensesApi.list({ scope: 'mine' });
      if (mode === 'team') return expensesApi.list({ scope: 'team-queue' });
      if (mode === 'finance') return expensesApi.list({ scope: 'finance-queue' });
      // employee-profile — fetch everything the caller can see and filter client-side.
      return expensesApi.list();
    },
  });

  if (q.isLoading) return <div className="h-40 bg-neutral-100" aria-label="Loading" />;
  if (q.isError) return <div className="p-4 text-13 text-red">Could not load expenses.</div>;
  let items = q.data?.items ?? [];
  if (mode === 'employee-profile' && employeeId) {
    items = items.filter((e) => e.employee_id === employeeId);
  }

  const showEmployeeColumn = mode !== 'mine' && mode !== 'employee-profile';

  return (
    <div className="bg-white border border-neutral-200 rounded overflow-hidden" data-testid={`expenses-${mode}`}>
      {items.length === 0 ? (
        <div className="p-6 text-13 text-neutral-500">Nothing here.</div>
      ) : (
        <table className="w-full border-collapse tabular-nums">
          <thead>
            <tr>
              {[
                showEmployeeColumn ? 'Employee' : null,
                'Date',
                'Title',
                'Category',
                'Amount',
                'Stage',
                'Actions',
              ]
                .filter(Boolean)
                .map((c) => (
                  <th key={c as string} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">
                    {c as string}
                  </th>
                ))}
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <Row key={row.id} row={row} mode={mode} showEmployee={showEmployeeColumn} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Row({ row, mode, showEmployee }: { row: ExpenseWithRefs; mode: Props['mode']; showEmployee: boolean }) {
  const s = stageStyle(row.stage);
  const border =
    s.variant === 'problem' ? 'border-red'
      : s.variant === 'pending' ? 'border-amber'
      : s.variant === 'awaiting' ? 'border-neutral-400'
      : 'border-transparent';
  return (
    <tr className="border-b border-neutral-200 align-top" data-testid={`exp-row-${row.id}`}>
      {showEmployee ? (
        <td className="px-3 py-2">
          <div className="text-13 text-neutral-900">{row.employee?.full_name ?? '—'}</div>
          <div className="text-11 text-neutral-500">{row.employee?.employee_code}</div>
        </td>
      ) : null}
      <td className={`px-3 py-2 text-13 text-neutral-900 border-l-2 ${border}`}>{fmtDate(row.expense_date + 'T00:00:00Z')}</td>
      <td className="px-3 py-2">
        <div className="text-13 text-neutral-900">{row.title}</div>
        {row.description ? <div className="text-11 text-neutral-500 max-w-[260px]">{row.description}</div> : null}
      </td>
      <td className="px-3 py-2 text-13 text-neutral-700">{row.category?.name ?? '—'}</td>
      <td className="px-3 py-2 text-13 text-neutral-900 font-medium">{inr(row.amount_paise)}</td>
      <td className="px-3 py-2">
        <StatusLabel variant={s.variant} label={s.label} />
        {row.rejection_reason ? (
          <div className="text-11 text-neutral-500 mt-1">Note: {row.rejection_reason}</div>
        ) : null}
      </td>
      <td className="px-3 py-2"><RowActions row={row} mode={mode} /></td>
    </tr>
  );
}

function RowActions({ row, mode }: { row: ExpenseWithRefs; mode: Props['mode'] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const submit = useMutation({
    mutationFn: () => expensesApi.submit(row.id),
    onSuccess: () => { toast.push('success', 'Submitted for approval.'); qc.invalidateQueries({ queryKey: ['expenses'] }); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const approve = useMutation({
    mutationFn: () => expensesApi.approve(row.id),
    onSuccess: () => { toast.push('success', 'Approved.'); qc.invalidateQueries({ queryKey: ['expenses'] }); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const reject = useMutation({
    mutationFn: () => expensesApi.reject(row.id, reason),
    onSuccess: () => { toast.push('success', 'Rejected.'); qc.invalidateQueries({ queryKey: ['expenses'] }); setRejecting(false); setReason(''); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const pay = useMutation({
    mutationFn: () => expensesApi.pay(row.id),
    onSuccess: () => { toast.push('success', 'Paid — Payment + Ledger recorded.'); qc.invalidateQueries({ queryKey: ['expenses'] }); },
    onError: (e: Error) => toast.push('error', e.message),
  });

  if (mode === 'mine' || mode === 'employee-profile') {
    if (row.stage === 'draft') {
      return (
        <Button variant="primary" onClick={() => submit.mutate()} disabled={submit.isPending} data-testid={`exp-submit-${row.id}`}>
          {submit.isPending ? '…' : 'Submit'}
        </Button>
      );
    }
    return null;
  }
  if (row.stage === 'paid' || row.stage === 'rejected') return null;
  if (rejecting) {
    return (
      <div className="flex flex-col gap-2 w-[220px]">
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for rejection"
          className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded"
        />
        <div className="flex gap-2">
          <Button variant="primary" disabled={!reason.trim() || reject.isPending} onClick={() => reject.mutate()} data-testid={`exp-reject-confirm-${row.id}`}>Reject</Button>
          <Button variant="ghost" onClick={() => setRejecting(false)}>Cancel</Button>
        </div>
      </div>
    );
  }
  const showApprove =
    (mode === 'team' && row.stage === 'pending_manager') ||
    (mode === 'finance' && row.stage === 'pending_finance');
  const showPay = mode === 'finance' && row.stage === 'approved';
  return (
    <div className="flex gap-2">
      {showApprove ? (
        <Button variant="primary" disabled={approve.isPending} onClick={() => approve.mutate()} data-testid={`exp-approve-${row.id}`}>Approve</Button>
      ) : null}
      {showPay ? (
        <Button variant="primary" disabled={pay.isPending} onClick={() => pay.mutate()} data-testid={`exp-pay-${row.id}`}>Pay</Button>
      ) : null}
      {row.stage === 'pending_manager' || row.stage === 'pending_finance' ? (
        <Button variant="secondary" onClick={() => setRejecting(true)} data-testid={`exp-reject-${row.id}`}>Reject</Button>
      ) : null}
    </div>
  );
}
