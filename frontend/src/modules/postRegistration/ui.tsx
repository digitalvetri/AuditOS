/**
 * Post-registration compliance UI shared by the Private Limited / LLP case
 * screens (Post-Registration Compliance tab) and the dashboards. Every status is
 * shown as words plus the due date — colour only reinforces it.
 */
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fmtDate } from '@/lib/format';
import { useToast } from '@/components/Toast';
import type { ApiError } from '@/services/api';
import { EmployeeSelect } from '@/pages/workstation/registration/partnership/shared';
import { postRegistrationApi, postRegistrationKeys, type ComplianceItem, type ComplianceKind, type ComplianceStatus } from './api';

export const STATUS_TEXT: Record<ComplianceStatus, string> = {
  NOT_STARTED: 'Awaiting Date',
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
/** "Awaiting Incorporation Date" — shown instead of guessing a missing trigger date. */
export function awaiting(i: Pick<ComplianceItem, 'trigger_label'>): string {
  return `Awaiting ${i.trigger_label === 'Date of Incorporation' ? 'Incorporation Date' : i.trigger_label}`;
}

export function daysText(i: Pick<ComplianceItem, 'status' | 'days_remaining' | 'completed_on' | 'trigger_label'>): string {
  if (i.status === 'COMPLETED') return i.completed_on ? `Completed ${fmtDate(i.completed_on)}` : 'Completed';
  if (i.days_remaining === null) return awaiting(i);
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
const todayIst = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

/** What the case screen tells the panel about the registration itself. */
export interface ComplianceCaseInfo {
  kind: ComplianceKind;
  name: string;
  status: string;
  statusLabel: string;
  registrationNumber: string | null;
  /** Saves the LLPIN / CIN on the case; absent = read-only. */
  onSaveRegistrationNumber?: (v: string | null) => Promise<unknown>;
}

const INTRO: Record<ComplianceKind, string> = {
  PRIVATE_LIMITED: 'INC-20A (180 days from incorporation) and ADTC (30 days, also from incorporation) are created automatically when this registration\'s status is set to Completed.',
  LLP: 'LLP Form 3 – Initial LLP Agreement (due 30 days from incorporation) is created automatically when this registration\'s status is set to Completed.',
};
export const REG_NO_LABEL: Record<ComplianceKind, string> = { PRIVATE_LIMITED: 'CIN', LLP: 'LLPIN' };

/**
 * The Post-Registration Compliance tab of one Private Limited / LLP case:
 * the entity's details, each open compliance with its trigger date, due date,
 * days remaining, status, assignee and notes — and the history of completed
 * ones (never deleted).
 */
export function CaseCompliancePanel({ caseId, info, canEdit }: { caseId: string; info: ComplianceCaseInfo; canEdit: boolean }) {
  // Always fresh on open: completing the registration may have just created the rows.
  const q = useQuery({ queryKey: postRegistrationKeys.list({ case_id: caseId }), queryFn: () => postRegistrationApi.list({ case_id: caseId }), refetchOnMount: 'always' });
  const items = q.data?.items ?? [];
  const incorporated = items.find((i) => i.trigger_label === 'Date of Incorporation' && i.trigger_date)?.trigger_date ?? null;

  const header = <EntityInfo info={info} incorporated={incorporated} canEdit={canEdit} />;
  if (info.status !== 'COMPLETED' && !items.length) {
    return (
      <div className="space-y-4">
        {header}
        <section className="bg-white border border-neutral-200 rounded-lg p-5 text-13 text-neutral-600">
          <div className="text-14 font-semibold text-neutral-900 mb-1">Post-Registration Compliance</div>
          {INTRO[info.kind]} Enter the Date of Incorporation then, or here afterwards. Nothing is created before incorporation.
        </section>
      </div>
    );
  }
  if (q.isLoading) return <div className="h-40 bg-neutral-100 rounded-lg" aria-label="Loading" />;
  if (q.error) return <div className="p-4 text-13 text-red">Could not load the compliance items.</div>;
  const open = items.filter((i) => i.status !== 'COMPLETED');
  const done = items.filter((i) => i.status === 'COMPLETED');

  return (
    <div className="space-y-4">
      {header}
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
          <div className="overflow-x-auto">
            <table className="w-full text-13">
              <thead>
                <tr className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 border-b border-neutral-200">
                  {['Compliance', 'Trigger Date', 'Original Due Date', 'Completion Date', 'Completed By', 'Status', 'Notes', ''].map((h, n) => (
                    <th key={n} className={`py-2 font-medium ${n === 0 ? 'px-5' : 'px-3'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {done.map((i) => <HistoryRow key={i.id} item={i} canEdit={canEdit} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function EntityInfo({ info, incorporated, canEdit }: { info: ComplianceCaseInfo; incorporated: string | null; canEdit: boolean }) {
  const regLabel = REG_NO_LABEL[info.kind];
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(info.registrationNumber ?? '');
  const [saving, setSaving] = useState(false);
  return (
    <section className="bg-white border border-neutral-200 rounded-lg">
      <div className="px-5 h-11 flex items-center border-b border-neutral-200">
        <span className="text-13 font-semibold text-neutral-900">{info.kind === 'LLP' ? 'LLP Information' : 'Company Information'}</span>
      </div>
      <div className="px-5 py-4 flex flex-wrap gap-x-8 gap-y-3">
        <Field label={info.kind === 'LLP' ? 'LLP Name' : 'Company Name'}>{info.name}</Field>
        <Field label={regLabel}>
          {editing ? (
            <form
              className="flex items-center gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                setSaving(true);
                try { await info.onSaveRegistrationNumber?.(value.trim() || null); setEditing(false); } finally { setSaving(false); }
              }}
            >
              <input className={`${input} w-[160px] uppercase`} value={value} onChange={(e) => setValue(e.target.value)} maxLength={40} aria-label={regLabel} autoFocus />
              <button type="submit" className={`${btn} border-neutral-900 bg-neutral-900 text-white`} disabled={saving}>Save</button>
              <button type="button" className={`${btn} border-neutral-300 bg-white`} onClick={() => { setEditing(false); setValue(info.registrationNumber ?? ''); }}>Cancel</button>
            </form>
          ) : (
            <span className="inline-flex items-center gap-2">
              {info.registrationNumber ?? <span className="text-neutral-400">Not entered</span>}
              {canEdit && info.onSaveRegistrationNumber ? (
                <button type="button" className="text-12 underline text-neutral-600 hover:text-neutral-900" onClick={() => setEditing(true)}>{info.registrationNumber ? 'Edit' : 'Add'}</button>
              ) : null}
            </span>
          )}
        </Field>
        <Field label="Date of Incorporation">{incorporated ? fmtDate(incorporated) : <span className="text-neutral-400">Awaiting Incorporation Date</span>}</Field>
        <Field label="Registration Status">{info.statusLabel}</Field>
      </div>
    </section>
  );
}

function ComplianceRow({ item: i, canEdit }: { item: ComplianceItem; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [trigger, setTrigger] = useState(i.trigger_date ?? '');
  const [label, setLabel] = useState(i.trigger_label);
  const [offset, setOffset] = useState(String(i.offset_days));
  const [assignee, setAssignee] = useState(i.assigned_to?.id ?? '');
  const [notes, setNotes] = useState(i.notes ?? '');
  const [doneOn, setDoneOn] = useState(todayIst());
  const [doneBy, setDoneBy] = useState('');
  const [doneNotes, setDoneNotes] = useState(i.notes ?? '');
  const save = useComplianceMutation(
    (v: Parameters<typeof postRegistrationApi.update>[1]) => postRegistrationApi.update(i.id, v),
    `${i.label} updated`,
  );
  const complete = useComplianceMutation(
    (v: Parameters<typeof postRegistrationApi.complete>[1]) => postRegistrationApi.complete(i.id, v),
    `${i.label} marked completed`,
  );
  const reset = () => { setEditing(false); setTrigger(i.trigger_date ?? ''); setLabel(i.trigger_label); setOffset(String(i.offset_days)); setAssignee(i.assigned_to?.id ?? ''); setNotes(i.notes ?? ''); };

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <div className="min-w-[220px] flex-1">
          <div className="text-14 font-semibold text-neutral-900">{i.title} <span className="font-normal text-neutral-500">— {i.offset_days} days</span></div>
          {i.description ? <div className="text-12 text-neutral-500">{i.description}</div> : null}
        </div>
        <Field label={`Trigger date · ${i.trigger_label}`}>{i.trigger_date ? fmtDate(i.trigger_date) : <span className="text-neutral-400">{awaiting(i)}</span>}</Field>
        <Field label="Due date">{i.due_date ? fmtDate(i.due_date) : <span className="text-neutral-400">—</span>}</Field>
        <Field label="Days remaining"><span className={daysClass(i)}>{daysText(i)}</span></Field>
        <Field label="Status"><ComplianceStatusBadge status={i.status} /></Field>
        <Field label="Assigned to">{i.assigned_to?.name ?? <span className="text-neutral-400">Unassigned</span>}</Field>
      </div>
      {i.notes ? <p className="mt-2 text-12 text-neutral-700"><span className="text-neutral-500">Notes:</span> {i.notes}</p> : null}

      {i.status === 'NOT_STARTED' ? (
        <p className="mt-2 text-12 text-neutral-600">Enter the {i.trigger_label} to start the {i.offset_days}-day countdown — the due date is worked out automatically.</p>
      ) : null}
      {i.reminder_message && (i.status === 'OVERDUE' || i.status === 'DUE_TODAY' || i.status === 'DUE_SOON') ? (
        <p className={`mt-2 text-12 ${daysClass(i)}`} role="status">Reminder: {i.reminder_message}</p>
      ) : null}

      {canEdit ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          {!editing && !completing ? (
            <>
              <button type="button" className={`${btn} border-neutral-300 bg-white hover:bg-neutral-50`} onClick={() => setEditing(true)}>{i.trigger_date ? 'Edit' : `Enter ${i.trigger_label}`}</button>
              <button type="button" className={`${btn} border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-800`} onClick={() => setCompleting(true)}>Mark Completed</button>
            </>
          ) : null}

          {editing ? (
            <form
              className="w-full flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const v: Parameters<typeof postRegistrationApi.update>[1] = { trigger_date: trigger || null, notes: notes.trim() || null };
                if ((assignee || null) !== (i.assigned_to?.id ?? null)) v.assigned_employee_id = assignee || null;
                if (i.trigger_editable_label && label.trim() !== i.trigger_label) v.trigger_label = label.trim();
                if (i.trigger_editable_label && Number(offset) !== i.offset_days) v.offset_days = Number(offset);
                save.mutate(v, { onSuccess: () => setEditing(false) });
              }}
            >
              {i.trigger_editable_label ? (
                <Labelled label="Counts from (event)">
                  <input className={`${input} w-[240px]`} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} required />
                </Labelled>
              ) : null}
              <Labelled label={i.trigger_editable_label ? 'Event date' : i.trigger_label}>
                <input type="date" className={input} value={trigger} max={todayIst()} onChange={(e) => setTrigger(e.target.value)} />
              </Labelled>
              {i.trigger_editable_label ? (
                <Labelled label="Days after">
                  <input type="number" min={1} max={3650} className={`${input} w-[90px]`} value={offset} onChange={(e) => setOffset(e.target.value)} required />
                </Labelled>
              ) : null}
              <Labelled label="Assigned to"><EmployeeSelect value={assignee} onChange={setAssignee} className="h-8 text-13" /></Labelled>
              <Labelled label="Notes" grow>
                <input className={`${input} w-full`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
              </Labelled>
              <button type="submit" className={`${btn} border-neutral-900 bg-neutral-900 text-white`} disabled={save.isPending}>Save</button>
              <button type="button" className={`${btn} border-neutral-300 bg-white`} onClick={reset}>Cancel</button>
            </form>
          ) : null}

          {completing ? (
            <form
              className="w-full flex flex-wrap items-end gap-2 p-3 rounded border border-neutral-200 bg-neutral-50"
              onSubmit={(e) => {
                e.preventDefault();
                complete.mutate(
                  { completed_on: doneOn, ...(doneBy ? { completed_by_employee_id: doneBy } : {}), notes: doneNotes.trim() || null },
                  { onSuccess: () => setCompleting(false) },
                );
              }}
            >
              <div className="basis-full text-13 text-neutral-700">Mark <b>{i.title}</b> completed. The original due date ({i.due_date ? fmtDate(i.due_date) : '—'}) stays on record.</div>
              <Labelled label="Completion date">
                <input type="date" className={input} value={doneOn} max={todayIst()} onChange={(e) => setDoneOn(e.target.value)} required />
              </Labelled>
              <Labelled label="Completed by"><EmployeeSelect value={doneBy} onChange={setDoneBy} placeholder="Me" className="h-8 text-13" /></Labelled>
              <Labelled label="Notes" grow>
                <input className={`${input} w-full`} value={doneNotes} onChange={(e) => setDoneNotes(e.target.value)} maxLength={2000} placeholder="e.g. SRN, filing reference" />
              </Labelled>
              <button type="submit" className={`${btn} border-neutral-900 bg-neutral-900 text-white`} disabled={complete.isPending}>Confirm completed</button>
              <button type="button" className={`${btn} border-neutral-300 bg-white`} onClick={() => setCompleting(false)}>Cancel</button>
            </form>
          ) : null}
        </div>
      ) : null}
      {i.trigger_editable_label ? (
        <p className="mt-2 text-11 text-neutral-500">
          The event {i.label} counts from is configurable until its statutory basis is confirmed — correct the event, its date or the number of days with Edit.
        </p>
      ) : null}
    </li>
  );
}

function HistoryRow({ item: i, canEdit }: { item: ComplianceItem; canEdit: boolean }) {
  const reopen = useComplianceMutation(() => postRegistrationApi.reopen(i.id), `${i.label} reopened`);
  return (
    <tr className="border-b border-neutral-100 last:border-b-0 align-top">
      <td className="px-5 py-2.5 font-medium text-neutral-900">{i.title}</td>
      <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">{i.trigger_date ? fmtDate(i.trigger_date) : '—'}</td>
      <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">{i.due_date ? fmtDate(i.due_date) : '—'}</td>
      <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">{i.completed_on ? fmtDate(i.completed_on) : '—'}</td>
      <td className="px-3 py-2.5">{i.completed_by?.name ?? '—'}</td>
      <td className="px-3 py-2.5"><ComplianceStatusBadge status={i.status} /></td>
      <td className="px-3 py-2.5 text-neutral-700">{i.notes ?? '—'}</td>
      <td className="px-3 py-2.5 text-right">
        {canEdit ? <button type="button" className="text-12 underline text-neutral-600 hover:text-neutral-900" disabled={reopen.isPending} onClick={() => reopen.mutate(undefined)}>Reopen</button> : null}
      </td>
    </tr>
  );
}

function Labelled({ label, grow, children }: { label: string; grow?: boolean; children: ReactNode }) {
  return (
    <label className={`block ${grow ? 'flex-1 min-w-[200px]' : ''}`}>
      <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">{label}</span>
      {children}
    </label>
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
