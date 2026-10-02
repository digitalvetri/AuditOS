import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { Field, Modal, SimulatedNotice, fieldErrors, inputClass, textareaClass } from '@/modules/workstation/components';
import { workstationApi } from '@/modules/workstation/api';

/**
 * Create a follow-up against a client or lead.
 *
 * Shared by the Follow-ups list and the Calendar: the Calendar passes
 * `defaultDateTime` so clicking an empty day prefills the schedule.
 *
 * Dates round-trip through <input type="datetime-local">, so the shape is
 * `YYYY-MM-DDTHH:mm` (not an ISO Z string). The create call converts to ISO.
 */
export function NewFollowUpModal({ open, onClose, defaultDateTime }: {
  open: boolean;
  onClose: () => void;
  /** `YYYY-MM-DDTHH:mm` — passed to the datetime-local input. */
  defaultDateTime?: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const employees = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees });
  const clients = useQuery({ queryKey: ['workstation', 'clients', 'picker'], queryFn: () => workstationApi.listClients() });
  const leads = useQuery({ queryKey: ['workstation', 'leads', 'picker'], queryFn: () => workstationApi.listLeads() });

  const [subjectKind, setSubjectKind] = useState<'client' | 'lead'>('client');
  const [form, setForm] = useState({
    subject_id: '', title: '', type: 'call',
    scheduled_at: defaultDateTime ?? '',
    assigned_employee_id: '', notes: '',
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Picking a different day on the calendar reopens the modal — reflect the
  // new day in the already-mounted form.
  useEffect(() => {
    if (open) setForm((f) => ({ ...f, scheduled_at: defaultDateTime ?? f.scheduled_at }));
  }, [open, defaultDateTime]);

  const create = useMutation({
    mutationFn: () => workstationApi.createFollowUp({
      ...(subjectKind === 'client' ? { client_id: form.subject_id } : { lead_id: form.subject_id }),
      title: form.title,
      type: form.type,
      scheduled_at: form.scheduled_at ? new Date(form.scheduled_at).toISOString() : '',
      assigned_employee_id: form.assigned_employee_id,
      notes: form.notes || undefined,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', 'Follow-up scheduled.');
      onClose();
    },
  });
  const e = fieldErrors(create.error);

  return (
    <Modal
      open={open} title="New Follow-up" onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>Schedule</Button>
        </>
      }
    >
      {/* One entity, two subjects — the form picks which side it hangs off. */}
      <Field label="Follow up with">
        <div className="flex gap-4 h-8 items-center">
          <label className="flex items-center gap-2 text-13">
            <input type="radio" checked={subjectKind === 'client'} onChange={() => { setSubjectKind('client'); set('subject_id', ''); }} />
            Client
          </label>
          <label className="flex items-center gap-2 text-13">
            <input type="radio" checked={subjectKind === 'lead'} onChange={() => { setSubjectKind('lead'); set('subject_id', ''); }} />
            Lead
          </label>
        </div>
      </Field>
      <Field label={subjectKind === 'client' ? 'Client' : 'Lead'} error={e.client_id ?? e.lead_id}>
        <select className={inputClass} value={form.subject_id} onChange={(ev) => set('subject_id', ev.target.value)}>
          <option value="">Select…</option>
          {subjectKind === 'client'
            ? (clients.data?.items ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.client_id} · {c.company_name}</option>
              ))
            : (leads.data?.items ?? []).map((l) => (
                <option key={l.id} value={l.id}>{l.lead_id} · {l.name}</option>
              ))}
        </select>
      </Field>
      <Field label="Title" error={e.title}>
        <input className={inputClass} value={form.title} onChange={(ev) => set('title', ev.target.value)} />
      </Field>
      <Field label="Type" error={e.type}>
        <select className={inputClass} value={form.type} onChange={(ev) => set('type', ev.target.value)}>
          {['call', 'whatsapp', 'email', 'meeting', 'document_request', 'payment_followup', 'service_followup', 'other'].map((t) => (
            <option key={t} value={t}>{t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</option>
          ))}
        </select>
      </Field>
      <Field label="Date & Time" error={e.scheduled_at}>
        <input className={inputClass} type="datetime-local" value={form.scheduled_at} onChange={(ev) => set('scheduled_at', ev.target.value)} />
      </Field>
      <Field label="Assigned To" error={e.assigned_employee_id}>
        <select className={inputClass} value={form.assigned_employee_id} onChange={(ev) => set('assigned_employee_id', ev.target.value)}>
          <option value="">Select an employee…</option>
          {(employees.data?.items ?? []).map((emp) => (
            <option key={emp.id} value={emp.id}>{emp.full_name} · {emp.designation}</option>
          ))}
        </select>
      </Field>
      <Field label="Notes" error={e.notes}>
        <textarea className={textareaClass} rows={3} value={form.notes} onChange={(ev) => set('notes', ev.target.value)} />
      </Field>
      <SimulatedNotice>
        Reminders appear in JNS Accounting Solutions notifications only. No SMS, WhatsApp or email is sent.
      </SimulatedNotice>
    </Modal>
  );
}
