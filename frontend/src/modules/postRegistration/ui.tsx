/**
 * Post-registration compliance UI shared by the Private Limited case screen
 * (Post-Registration Compliance tab) and the main Dashboard. Every status is
 * shown as words plus the due date — colour only reinforces it.
 */
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fmtDate } from '@/lib/format';
import { useToast } from '@/components/Toast';
import type { ApiError } from '@/services/api';
import { postRegistrationApi, postRegistrationKeys, type ComplianceItem, type ComplianceStatus } from './api';

export const STATUS_TEXT: Record<ComplianceStatus, string> = {
  NOT_STARTED: 'Not Started',
  UPCOMING: 'Upcoming',
  DUE_SOON: 'Due Soon',
  DUE_TODAY: 'Due Today',
  OVERDUE: 'Overdue',
  COMPLETED: 'Completed',
};

const STATUS_CLS: Record<ComplianceStatus, string> = {
  NOT_STARTED: 'bg-neutral-100 text-neutral-700 border-neutral-200',
  UPCOMING: 'bg-blue-50 text-blue-800 border-blue-200',
  DUE_SOON: 'bg-amber-50 text-amber-900 border-amber-200',
  DUE_TODAY: 'bg-amber-50 text-amber-900 border-amber-300 font-semibold',
  OVERDUE: 'bg-red-50 text-red-800 border-red-200 font-semibold',
  COMPLETED: 'bg-green-50 text-green-800 border-green-200',
};

export function ComplianceStatusBadge({ status }: { status: ComplianceStatus }) {
  return <span className={`inline-flex items-center h-6 px-2 rounded-full border text-12 whitespace-nowrap ${STATUS_CLS[status]}`}>{STATUS_TEXT[status]}</span>;
}

/** "150 days remaining" · "Due today" · "Overdue by 5 days" · "Completed 12 Nov 2026". */
export function daysText(i: Pick<ComplianceItem, 'status' | 'days_remaining' | 'completed_on'>): string {
  if (i.status === 'COMPLETED') return i.completed_on ? `Completed ${fmtDate(i.completed_on)}` : 'Completed';
  if (i.days_remaining === null) return 'Date not entered';
  const n = Math.abs(i.days_remaining);
  const days = `${n} day${n === 1 ? '' : 's'}`;
  if (i.days_remaining < 0) return `Overdue by ${days}`;
  if (i.days_remaining === 0) return 'Due today';
  return `${days} remaining`;
}

export function daysClass(i: Pick<ComplianceItem, 'status'>): string {
  return i.status === 'OVERDUE' ? 'text-red font-medium' : i.status === 'DUE_TODAY' || i.status === 'DUE_SOON' ? 'text-amber font-medium' : 'text-neutral-700';
}

function useComplianceMutation<T>(fn: (v: T) => Promise<unknown>, success: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: postRegistrationKeys.all });
      toast.push('success', success);
    },
    onError: (e: ApiError) => toast.push('error', e.message),
  });
}

const input = 'h-8 px-2 text-13 bg-white border border-neutral-300 rounded focus:outline-none focus:border-gold';
const btn = 'h-8 px-3 text-13 rounded border';

/**
 * The Post-Registration Compliance tab of one Private Limited case: each
 * compliance with its trigger date, due date, days remaining, status and
 * completion — and the history of completed ones.
 */
export function CaseCompliancePanel({ caseId, caseStatus, canEdit }: { caseId: string; caseStatus: string; canEdit: boolean }) {
  // Always fresh on open: completing the registration may have just created the rows.
  const q = useQuery({ queryKey: postRegistrationKeys.list({ case_id: caseId }), queryFn: () => postRegistrationApi.list({ case_id: caseId }), refetchOnMount: 'always' });

  if (caseStatus !== 'COMPLETED' && !(q.data?.items.length)) {
    return (
      <section className="bg-white border border-neutral-200 rounded-lg p-5 text-13 text-neutral-600">
        <div className="text-14 font-semibold text-neutral-900 mb-1">Post-Registration Compliance</div>
        INC-20A (180 days from incorporation) and ADTC (30 days, also from incorporation) are created automatically when
        this registration's status is set to <b>Completed</b>. Enter the Date of Incorporation then, or here afterwards.
      </section>
    );
  }
  if (q.isLoading) return <div className="h-40 bg-neutral-100 rounded-lg" aria-label="Loading" />;
  if (q.error) return <div className="p-4 text-13 text-red">Could not load the compliance items.</div>;
  const items = q.data?.items ?? [];
  const open = items.filter((i) => i.status !== 'COMPLETED');
  const done = items.filter((i) => i.status === 'COMPLETED');

  return (
    <div className="space-y-4">
      <section className="bg-white border border-neutral-200 rounded-lg">
        <div className="px-5 h-11 flex items-center border-b border-neutral-200">
          <span className="text-13 font-semibold text-neutral-900">Post-Registration Compliance</span>
          <span className="ml-2 text-12 text-neutral-500">Today {fmtDate(q.data!.today)}</span>
        </div>
        {open.length === 0 ? (
          <div className="p-5 text-13 text-neutral-600">All post-registration compliances are completed — see the history below.</div>
        ) : (
          <ul className="divide-y divide-neutral-200">
            {open.map((i) => <ComplianceRow key={i.id} item={i} canEdit={canEdit} />)}
          </ul>
        )}
      </section>

      <section className="bg-white border border-neutral-200 rounded-lg">
        <div className="px-5 h-11 flex items-center border-b border-neutral-200">
          <span className="text-13 font-semibold text-neutral-900">Compliance History</span>
        </div>
        {done.length === 0 ? (
          <div className="p-5 text-13 text-neutral-500">No compliance completed yet.</div>
        ) : (
          <ul className="divide-y divide-neutral-200">
            {done.map((i) => <ComplianceRow key={i.id} item={i} canEdit={canEdit} />)}
          </ul>
        )}
      </section>
    </div>
  );
}

function ComplianceRow({ item: i, canEdit }: { item: ComplianceItem; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [trigger, setTrigger] = useState(i.trigger_date ?? '');
  const [label, setLabel] = useState(i.trigger_label);
  const [offset, setOffset] = useState(String(i.offset_days));
  const [doneOn, setDoneOn] = useState(new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10));
  const save = useComplianceMutation(
    (v: Parameters<typeof postRegistrationApi.update>[1]) => postRegistrationApi.update(i.id, v),
    `${i.label} updated`,
  );
  const complete = useComplianceMutation((on: string) => postRegistrationApi.complete(i.id, on), `${i.label} marked completed`);
  const reopen = useComplianceMutation(() => postRegistrationApi.reopen(i.id), `${i.label} reopened`);
  const done = i.status === 'COMPLETED';

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <div className="min-w-[200px] flex-1">
          <div className="text-14 font-semibold text-neutral-900">{i.label} <span className="font-normal text-neutral-500">— {i.offset_days} days</span></div>
          <div className="text-12 text-neutral-500">{i.title}</div>
        </div>
        <Field label={i.trigger_label}>{i.trigger_date ? fmtDate(i.trigger_date) : <span className="text-neutral-400">Not entered</span>}</Field>
        <Field label="Due date">{i.due_date ? fmtDate(i.due_date) : <span className="text-neutral-400">—</span>}</Field>
        <Field label="Days remaining"><span className={daysClass(i)}>{daysText(i)}</span></Field>
        <Field label="Status"><ComplianceStatusBadge status={i.status} /></Field>
        {done ? <Field label="Completion date">{i.completed_on ? fmtDate(i.completed_on) : '—'}</Field> : null}
      </div>

      {i.status === 'NOT_STARTED' ? (
        <p className="mt-2 text-12 text-neutral-600">Enter the {i.trigger_label} to start the {i.offset_days}-day countdown.</p>
      ) : null}
      {i.status === 'OVERDUE' || i.status === 'DUE_TODAY' || i.status === 'DUE_SOON' ? (
        <p className={`mt-2 text-12 ${daysClass(i)}`} role="status">Reminder: {i.label} is {STATUS_TEXT[i.status].toLowerCase()} — due {fmtDate(i.due_date!)}.</p>
      ) : null}

      {canEdit ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          {!done && !editing && !completing ? (
            <>
              <button type="button" className={`${btn} border-neutral-300 bg-white hover:bg-neutral-50`} onClick={() => setEditing(true)}>
                {i.trigger_date ? `Correct ${i.trigger_label}` : `Enter ${i.trigger_label}`}
              </button>
              <button type="button" className={`${btn} border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-800`} onClick={() => setCompleting(true)}>Mark as completed</button>
            </>
          ) : null}
          {done ? (
            <button type="button" className={`${btn} border-neutral-300 bg-white hover:bg-neutral-50`} disabled={reopen.isPending} onClick={() => reopen.mutate(undefined)}>Reopen</button>
          ) : null}

          {editing ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const v: Parameters<typeof postRegistrationApi.update>[1] = { trigger_date: trigger || null };
                if (i.trigger_editable_label && label.trim() !== i.trigger_label) v.trigger_label = label.trim();
                if (i.trigger_editable_label && Number(offset) !== i.offset_days) v.offset_days = Number(offset);
                save.mutate(v, { onSuccess: () => setEditing(false) });
              }}
            >
              {i.trigger_editable_label ? (
                <label className="block">
                  <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Counts from (event)</span>
                  <input className={`${input} w-[240px]`} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} required />
                </label>
              ) : null}
              <label className="block">
                <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">{i.trigger_editable_label ? 'Event date' : i.trigger_label}</span>
                <input type="date" className={input} value={trigger} onChange={(e) => setTrigger(e.target.value)} />
              </label>
              {i.trigger_editable_label ? (
                <label className="block">
                  <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Days after</span>
                  <input type="number" min={1} max={3650} className={`${input} w-[90px]`} value={offset} onChange={(e) => setOffset(e.target.value)} required />
                </label>
              ) : null}
              <button type="submit" className={`${btn} border-neutral-900 bg-neutral-900 text-white`} disabled={save.isPending}>Save</button>
              <button type="button" className={`${btn} border-neutral-300 bg-white`} onClick={() => { setEditing(false); setTrigger(i.trigger_date ?? ''); setLabel(i.trigger_label); setOffset(String(i.offset_days)); }}>Cancel</button>
            </form>
          ) : null}

          {completing ? (
            <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); complete.mutate(doneOn, { onSuccess: () => setCompleting(false) }); }}>
              <label className="block">
                <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Completion date</span>
                <input type="date" className={input} value={doneOn} onChange={(e) => setDoneOn(e.target.value)} required />
              </label>
              <button type="submit" className={`${btn} border-neutral-900 bg-neutral-900 text-white`} disabled={complete.isPending}>Mark {i.label} completed</button>
              <button type="button" className={`${btn} border-neutral-300 bg-white`} onClick={() => setCompleting(false)}>Cancel</button>
            </form>
          ) : null}
        </div>
      ) : null}
      {i.trigger_editable_label && !done ? (
        <p className="mt-2 text-11 text-neutral-500">
          The event ADTC counts from is configurable until its statutory basis is confirmed — correct the event, its date or the number of days here.
        </p>
      ) : null}
    </li>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-[120px]">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
      <div className="text-13 text-neutral-900 mt-0.5">{children}</div>
    </div>
  );
}
