import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { workstationApi } from '@/modules/workstation/api';
import {
  Card, Detail, Field, Modal, PageHeader, QueryState, SimulatedNotice, Status,
  fieldErrors, inputClass, textareaClass,
} from '@/modules/workstation/components';
import type { Activity, Lead, LeadStatus, ListResponse } from '@/modules/workstation/types';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { fmtDate, fmtDateTime, fmtTime, inr } from '@/lib/format';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';

/**
 * §7.2 — Lead detail: Lead Information + Activity Timeline, and the actions
 * that write to it. Conversion is the centrepiece.
 */

/** Mirrors the server's adjacency map so the UI offers only legal moves. */
const NEXT: Record<LeadStatus, LeadStatus[]> = {
  new: ['contacted', 'lost'],
  contacted: ['requirement_identified', 'lost'],
  requirement_identified: ['quote_sent', 'lost'],
  quote_sent: ['negotiation', 'won', 'lost'],
  negotiation: ['won', 'lost'],
  won: [],
  lost: ['contacted'],
};

const LABEL: Record<LeadStatus, string> = {
  new: 'New', contacted: 'Contacted', requirement_identified: 'Requirement Identified',
  quote_sent: 'Quote Sent', negotiation: 'Negotiation', won: 'Won', lost: 'Lost',
};

export function LeadDetailPage() {
  const { id = '' } = useParams();
  const query = useQuery({ queryKey: ['workstation', 'lead', id], queryFn: () => workstationApi.getLead(id) });

  return (
    <div className="max-w-[1000px] mx-auto">
      <QueryState query={query}>{(lead: Lead) => <LeadBody lead={lead} />}</QueryState>
    </div>
  );
}

function LeadBody({ lead }: { lead: Lead }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { session } = useAuth();
  const role = session?.role.code;

  const [convertOpen, setConvertOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [followUpOpen, setFollowUpOpen] = useState(false);

  const activity = useQuery({
    queryKey: ['workstation', 'lead', lead.id, 'activity'],
    queryFn: () => workstationApi.leadActivity(lead.id),
  });

  const setStatus = useMutation({
    mutationFn: (status: LeadStatus) => workstationApi.updateLead(lead.id, { status }),
    onSuccess: (updated) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', `Status changed to ${LABEL[updated.status]}.`);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const canManage = can(role, 'workstation.lead.manage', 'self');
  const canConvert = can(role, 'workstation.lead.convert', 'self');
  const canFollowUp = can(role, 'workstation.followup.manage', 'self');
  const next = NEXT[lead.status];

  return (
    <>
      <PageHeader
        title={lead.name}
        subtitle={
          <>
            {lead.lead_id} · {lead.contact_number} · <Status value={lead.status} />
          </>
        }
        action={
          canConvert && lead.status === 'won' && !lead.converted_client_id ? (
            <Button variant="primary" onClick={() => setConvertOpen(true)}>Convert to Client</Button>
          ) : undefined
        }
      />

      {lead.converted_client_id ? (
        <div className="mb-4 border-l-2 border-neutral-400 bg-white px-3 py-2 text-13">
          Converted to a client on {fmtDate(lead.converted_at ?? lead.updated_at)}.{' '}
          <Link className="underline text-neutral-900" to={`/workstation/clients/${lead.converted_client_id}`}>
            Open Client
          </Link>
          <span className="block text-12 text-neutral-500 mt-1">
            This lead record is preserved — converting never deletes it.
          </span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title="Lead information">
          <div className="p-4">
            <Detail label="Lead ID" value={lead.lead_id} />
            <Detail label="Name" value={lead.name} />
            <Detail label="Contact Number" value={lead.contact_number} />
            <Detail label="Email" value={lead.email ?? '—'} />
            <Detail label="Service Required" value={lead.service_name ?? '—'} />
            <Detail
              label="Price Quoted"
              value={
                <>
                  {inr(lead.price_quoted_paise)}
                  <span className="block text-12 text-neutral-500">
                    Quoted — not an invoice. Billing is handled in Accounts.
                  </span>
                </>
              }
            />
            <Detail label="Assigned Employee" value={lead.assigned_employee?.full_name ?? '—'} />
            <Detail label="Lead Status" value={<Status value={lead.status} />} />
            {/* System-generated, read-only (§5.2). */}
            <Detail label="Created" value={`${fmtDate(lead.created_at)} · ${fmtTime(lead.created_at)}`} />
            {lead.notes ? <Detail label="Notes" value={lead.notes} /> : null}
            {lead.lost_reason ? <Detail label="Lost Reason" value={lead.lost_reason} /> : null}
          </div>

          {canManage && next.length > 0 ? (
            <div className="px-4 py-3 border-t border-neutral-200">
              <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">Change status</div>
              <div className="flex flex-wrap gap-2">
                {next.map((s) => (
                  <Button
                    key={s}
                    disabled={setStatus.isPending}
                    onClick={() => setStatus.mutate(s)}
                  >
                    {s === 'lost' ? 'Mark Lost' : `Move to ${LABEL[s]}`}
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2 mt-2">
                {canFollowUp ? <Button onClick={() => setFollowUpOpen(true)}>Add Follow-up</Button> : null}
                <Button onClick={() => setNoteOpen(true)}>Add Note</Button>
              </div>
            </div>
          ) : null}
        </Card>

        {/* Activity timeline (§11) — every important action lands here. */}
        <Card title="Activity timeline">
          <QueryState query={activity} empty="No activity yet.">
            {(data: ListResponse<Activity>) => (
              <ol className="p-4 space-y-3">
                {data.items.map((a) => (
                  <li key={a.id} className="border-l-2 border-neutral-200 pl-3">
                    <div className="text-13 text-neutral-900">{a.description}</div>
                    <div className="text-12 text-neutral-500 mt-1">
                      {a.actor?.full_name ?? 'System'} · {fmtDateTime(a.created_at)}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </QueryState>
        </Card>
      </div>

      <ConvertModal lead={lead} open={convertOpen} onClose={() => setConvertOpen(false)} />
      <NoteModal lead={lead} open={noteOpen} onClose={() => setNoteOpen(false)} />
      <LeadFollowUpModal lead={lead} open={followUpOpen} onClose={() => setFollowUpOpen(false)} />
    </>
  );
}

/**
 * §7.2 conversion. The confirmation shows name, contact, service and price
 * quoted BEFORE anything is written, and the resulting client is offered
 * immediately.
 */
function ConvertModal({ lead, open, onClose }: { lead: Lead; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const employees = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees });

  const [form, setForm] = useState({
    company_name: '', contact_person: lead.name, contact_number: lead.contact_number,
    email: lead.email ?? '', gstin: '', pan: '',
    account_manager_id: lead.assigned_employee_id, due_date: '',
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const convert = useMutation({
    mutationFn: () => workstationApi.convertLead(lead.id, {
      company_name: form.company_name,
      contact_person: form.contact_person,
      contact_number: form.contact_number,
      email: form.email || undefined,
      gstin: form.gstin || undefined,
      pan: form.pan || undefined,
      account_manager_id: form.account_manager_id,
      due_date: form.due_date || undefined,
    }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', 'Lead successfully converted to client.');
      onClose();
      navigate(`/workstation/clients/${res.client.id}`);
    },
  });

  const e = fieldErrors(convert.error);

  return (
    <Modal
      open={open}
      title="Convert this lead into a client?"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={convert.isPending} onClick={() => convert.mutate()}>
            {convert.isPending ? 'Converting…' : 'Convert to Client'}
          </Button>
        </>
      }
    >
      <div className="border-l-2 border-neutral-400 pl-3 mb-4">
        <Detail label="Lead" value={`${lead.lead_id} · ${lead.name}`} />
        <Detail label="Contact" value={lead.contact_number} />
        <Detail label="Service" value={lead.service_name ?? '—'} />
        <Detail label="Price Quoted" value={inr(lead.price_quoted_paise)} />
      </div>
      <p className="text-12 text-neutral-500 mb-4">
        A new client record and its first service will be created. The lead is kept.
      </p>

      <Field label="Company Name" error={e.company_name}>
        <input className={inputClass} value={form.company_name} onChange={(ev) => set('company_name', ev.target.value)} />
      </Field>
      <Field label="Contact Person" error={e.contact_person}>
        <input className={inputClass} value={form.contact_person} onChange={(ev) => set('contact_person', ev.target.value)} />
      </Field>
      <Field label="Contact Number" error={e.contact_number}>
        <input className={inputClass} value={form.contact_number} onChange={(ev) => set('contact_number', ev.target.value)} />
      </Field>
      <Field label="Email" error={e.email}>
        <input className={inputClass} value={form.email} onChange={(ev) => set('email', ev.target.value)} />
      </Field>
      <Field label="GSTIN" error={e.gstin} hint="Optional — 15 characters, e.g. 33ABCDE1234F1Z5">
        <input className={inputClass} value={form.gstin} onChange={(ev) => set('gstin', ev.target.value.toUpperCase())} />
      </Field>
      <Field label="PAN" error={e.pan} hint="Optional — 10 characters">
        <input className={inputClass} value={form.pan} onChange={(ev) => set('pan', ev.target.value.toUpperCase())} />
      </Field>
      <Field label="Account Manager" error={e.account_manager_id}>
        <select className={inputClass} value={form.account_manager_id} onChange={(ev) => set('account_manager_id', ev.target.value)}>
          <option value="">Select an employee…</option>
          {(employees.data?.items ?? []).map((emp) => (
            <option key={emp.id} value={emp.id}>{emp.full_name} · {emp.designation}</option>
          ))}
        </select>
      </Field>
      <Field label="First Service Due Date" error={e.due_date}>
        <input className={inputClass} type="date" value={form.due_date} onChange={(ev) => set('due_date', ev.target.value)} />
      </Field>
    </Modal>
  );
}

function NoteModal({ lead, open, onClose }: { lead: Lead; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [notes, setNotes] = useState(lead.notes ?? '');
  const save = useMutation({
    mutationFn: () => workstationApi.updateLead(lead.id, { notes }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', 'Note saved.');
      onClose();
    },
  });
  return (
    <Modal
      open={open} title="Add Note" onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </>
      }
    >
      <Field label="Notes" error={fieldErrors(save.error).notes}>
        <textarea className={textareaClass} rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </Modal>
  );
}

function LeadFollowUpModal({ lead, open, onClose }: { lead: Lead; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const employees = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees });
  const [form, setForm] = useState({
    title: `${lead.service_name ?? 'Lead'} follow-up`,
    type: 'call',
    scheduled_at: '',
    assigned_employee_id: lead.assigned_employee_id,
    notes: '',
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const create = useMutation({
    mutationFn: () => workstationApi.createFollowUp({
      lead_id: lead.id,
      title: form.title,
      type: form.type,
      scheduled_at: new Date(form.scheduled_at).toISOString(),
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
      open={open} title="Add Follow-up" onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={create.isPending || !form.scheduled_at} onClick={() => create.mutate()}>
            Schedule
          </Button>
        </>
      }
    >
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
          {(employees.data?.items ?? []).map((emp) => (
            <option key={emp.id} value={emp.id}>{emp.full_name}</option>
          ))}
        </select>
      </Field>
      <Field label="Notes" error={e.notes}>
        <textarea className={textareaClass} rows={3} value={form.notes} onChange={(ev) => set('notes', ev.target.value)} />
      </Field>
      <SimulatedNotice>
        Reminders appear in Audit OS notifications only. No SMS, WhatsApp or email is sent.
      </SimulatedNotice>
    </Modal>
  );
}
