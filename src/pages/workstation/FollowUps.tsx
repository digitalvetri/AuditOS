import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { workstationApi } from '@/modules/workstation/api';
import {
  Card, Cell, Field, FilterBar, Modal, PageHeader, QueryState, Row, Select,
  SimulatedNotice, Status, Table, fieldErrors, inputClass, textareaClass,
} from '@/modules/workstation/components';
import type { FollowUp, ListResponse } from '@/modules/workstation/types';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { fmtDate, fmtTime } from '@/lib/format';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';

/**
 * §7.5 — ONE follow-up list covering leads AND clients. There is no separate
 * lead-follow-up screen anywhere in Workstation; this is the only one.
 */
export function FollowUpsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { session } = useAuth();
  const [addOpen, setAddOpen] = useState(false);

  const range = params.get('range') ?? '';
  const status = params.get('status') ?? '';
  const employeeId = params.get('employee_id') ?? '';

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const followUps = useQuery({
    queryKey: ['workstation', 'follow-ups', { range, status, employeeId }],
    queryFn: () => workstationApi.listFollowUps({
      range: (range || undefined) as 'today' | 'upcoming' | 'overdue' | undefined,
      status, employee_id: employeeId,
    }),
  });
  const employees = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees });

  const complete = useMutation({
    mutationFn: (id: string) => workstationApi.completeFollowUp(id, 'Completed from the follow-up list.'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', 'Follow-up completed.');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const canManage = can(session?.role.code, 'workstation.followup.manage', 'self');
  const now = Date.now();

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Follow-ups"
        subtitle="One list for leads and clients alike."
        action={canManage ? <Button variant="primary" onClick={() => setAddOpen(true)}>New Follow-up</Button> : undefined}
      />

      <FilterBar>
        <Select
          label="When" value={range} onChange={(v) => setParam('range', v)}
          options={[
            { value: 'today', label: 'Today' },
            { value: 'upcoming', label: 'Upcoming' },
            { value: 'overdue', label: 'Overdue' },
          ]}
          allLabel="Any time"
        />
        <Select
          label="Status" value={status} onChange={(v) => setParam('status', v)}
          options={['pending', 'completed', 'rescheduled', 'cancelled', 'missed']
            .map((v) => ({ value: v, label: v.replace(/\b\w/g, (c) => c.toUpperCase()) }))}
        />
        <Select
          label="Employee" value={employeeId} onChange={(v) => setParam('employee_id', v)}
          options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: e.full_name }))}
        />
      </FilterBar>

      <Card>
        <QueryState query={followUps} empty="No follow-ups match these filters.">
          {(data: ListResponse<FollowUp>) => (
            <Table head={['Follow-up', 'Lead / Client', 'Contact', 'Service', 'Date', 'Time', 'Assigned To', 'Status', '']}>
              {data.items.map((f) => {
                const overdue = f.status === 'pending' && Date.parse(f.scheduled_at) < now;
                return (
                  <Row
                    key={f.id}
                    status={overdue ? 'missed' : f.status}
                    onClick={() =>
                      navigate(f.subject_type === 'lead'
                        ? `/workstation/leads/${f.lead_id}`
                        : `/workstation/clients/${f.client_id}/follow-ups`)
                    }
                  >
                    <Cell className="font-medium">{f.title}</Cell>
                    <Cell>
                      {f.subject_name}
                      <span className="block text-12 text-neutral-500">
                        {f.subject_type === 'lead' ? 'Lead' : 'Client'} · {f.subject_code}
                      </span>
                    </Cell>
                    <Cell muted>{f.contact_number ?? '—'}</Cell>
                    <Cell muted>{f.service_name ?? '—'}</Cell>
                    <Cell muted>{fmtDate(f.scheduled_at)}</Cell>
                    <Cell muted>{fmtTime(f.scheduled_at)}</Cell>
                    <Cell muted>{f.assigned_employee?.full_name ?? '—'}</Cell>
                    <Cell>
                      <Status value={f.status} />
                      {overdue ? <span className="block text-12 text-neutral-500">Overdue</span> : null}
                    </Cell>
                    <Cell>
                      {canManage && f.status === 'pending' ? (
                        <button
                          type="button"
                          className="text-12 text-neutral-700 underline hover:text-neutral-900"
                          onClick={(e) => { e.stopPropagation(); complete.mutate(f.id); }}
                        >
                          Complete
                        </button>
                      ) : null}
                    </Cell>
                  </Row>
                );
              })}
            </Table>
          )}
        </QueryState>
      </Card>

      <NewFollowUpModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}

function NewFollowUpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const employees = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees });
  const clients = useQuery({ queryKey: ['workstation', 'clients', 'picker'], queryFn: () => workstationApi.listClients() });
  const leads = useQuery({ queryKey: ['workstation', 'leads', 'picker'], queryFn: () => workstationApi.listLeads() });

  const [subjectKind, setSubjectKind] = useState<'client' | 'lead'>('client');
  const [form, setForm] = useState({
    subject_id: '', title: '', type: 'call', scheduled_at: '',
    assigned_employee_id: '', notes: '',
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

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
        Reminders appear in Audit OS notifications only. No SMS, WhatsApp or email is sent.
      </SimulatedNotice>
    </Modal>
  );
}
