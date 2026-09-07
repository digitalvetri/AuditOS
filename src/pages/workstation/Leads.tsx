import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { workstationApi } from '@/modules/workstation/api';
import {
  Cell, Card, Field, FilterBar, Modal, PageHeader, QueryState, Row,
  SearchInput, Select, Status, Table, fieldErrors, inputClass, textareaClass,
} from '@/modules/workstation/components';
import type { ListResponse, Lead } from '@/modules/workstation/types';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { fmtDate, fmtTime, inr } from '@/lib/format';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';

/** §7.2 — the lead list, its filters and the Add Lead form. */
export function LeadsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const [addOpen, setAddOpen] = useState(false);

  const status = params.get('status') ?? '';
  const serviceId = params.get('service_id') ?? '';
  const employeeId = params.get('employee_id') ?? '';
  const q = params.get('q') ?? '';

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const leads = useQuery({
    queryKey: ['workstation', 'leads', { status, serviceId, employeeId, q }],
    queryFn: () => workstationApi.listLeads({ status, service_id: serviceId, employee_id: employeeId, q }),
  });
  const catalog = useQuery({ queryKey: ['workstation', 'catalog'], queryFn: workstationApi.serviceCatalog });
  const employees = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees });

  const canManage = can(session?.role.code, 'workstation.lead.manage', 'self');

  return (
    <div className="">
      <PageHeader
        title="Leads"
        subtitle="Potential customers, before they become clients."
        action={canManage ? (
          <Button variant="primary" onClick={() => setAddOpen(true)}>Add Lead</Button>
        ) : undefined}
      />

      <FilterBar>
        <SearchInput value={q} onChange={(v) => setParam('q', v)} placeholder="Name, lead ID or number" />
        <Select
          label="Status" value={status} onChange={(v) => setParam('status', v)}
          options={[
            { value: 'new', label: 'New' },
            { value: 'contacted', label: 'Contacted' },
            { value: 'requirement_identified', label: 'Requirement Identified' },
            { value: 'quote_sent', label: 'Quote Sent' },
            { value: 'negotiation', label: 'Negotiation' },
            { value: 'won', label: 'Won' },
            { value: 'lost', label: 'Lost' },
          ]}
        />
        <Select
          label="Service" value={serviceId} onChange={(v) => setParam('service_id', v)}
          options={(catalog.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
        />
        <Select
          label="Assigned to" value={employeeId} onChange={(v) => setParam('employee_id', v)}
          options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: e.full_name }))}
        />
      </FilterBar>

      <Card>
        <QueryState query={leads} empty="No leads match these filters.">
          {(data: ListResponse<Lead>) => (
            <Table head={['Lead ID', 'Name', 'Contact', 'Service', 'Price Quoted', 'Date / Time', 'Status', 'Assigned To']}>
              {data.items.map((l) => (
                <Row key={l.id} status={l.status} onClick={() => navigate(`/workstation/leads/${l.id}`)}>
                  <Cell muted>{l.lead_id}</Cell>
                  <Cell className="font-medium">{l.name}</Cell>
                  <Cell muted>{l.contact_number}</Cell>
                  <Cell muted>{l.service_name ?? '—'}</Cell>
                  {/* Quoted, not received — Finance owns payment (§55). */}
                  <Cell>{inr(l.price_quoted_paise)}</Cell>
                  <Cell muted>{fmtDate(l.created_at)} {fmtTime(l.created_at)}</Cell>
                  <Cell><Status value={l.status} /></Cell>
                  <Cell muted>{l.assigned_employee?.full_name ?? '—'}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>

      {leads.data ? (
        <p className="text-12 text-neutral-500 mt-3">
          {leads.data.count} lead{leads.data.count === 1 ? '' : 's'} ·{' '}
          {leads.data.scope === 'organisation' ? 'all firm leads' : 'leads assigned to you'}
        </p>
      ) : null}

      <AddLeadModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}

function AddLeadModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const catalog = useQuery({ queryKey: ['workstation', 'catalog'], queryFn: workstationApi.serviceCatalog });
  const employees = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees });

  const [form, setForm] = useState({
    name: '', contact_number: '', service_id: '', price_quoted: '',
    assigned_employee_id: '', email: '', notes: '',
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: () => workstationApi.createLead({
      name: form.name,
      contact_number: form.contact_number,
      service_id: form.service_id,
      price_quoted: Number(form.price_quoted || 0),
      assigned_employee_id: form.assigned_employee_id,
      email: form.email || undefined,
      notes: form.notes || undefined,
    }),
    onSuccess: (lead) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', `Lead ${lead.lead_id} created.`);
      onClose();
      navigate(`/workstation/leads/${lead.id}`);
    },
  });

  // Client-side validation mirrors the server's, so the obvious mistakes are
  // caught without a round trip — but the server validates again regardless.
  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = 'This field is required.';
    if (!/^[6-9]\d{9}$/.test(form.contact_number.replace(/[\s\-()]/g, '').replace(/^\+91/, ''))) {
      e.contact_number = 'Enter a valid 10-digit Indian mobile number.';
    }
    if (!form.service_id) e.service_id = 'Select a service.';
    if (!form.assigned_employee_id) e.assigned_employee_id = 'Select an employee.';
    if (form.price_quoted && Number(form.price_quoted) < 0) e.price_quoted = 'Enter a valid amount.';
    setClientErrors(e);
    return Object.keys(e).length === 0;
  }

  const serverErrors = fieldErrors(create.error);
  const err = (f: string) => clientErrors[f] ?? serverErrors[f];

  return (
    <Modal
      open={open}
      title="Add Lead"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={create.isPending}
            onClick={() => { if (validate()) create.mutate(); }}
          >
            {create.isPending ? 'Saving…' : 'Create Lead'}
          </Button>
        </>
      }
    >
      <Field label="Name" error={err('name')}>
        <input className={inputClass} value={form.name} onChange={(e) => set('name', e.target.value)} />
      </Field>
      <Field label="Contact Number" error={err('contact_number')}>
        <input className={inputClass} value={form.contact_number} onChange={(e) => set('contact_number', e.target.value)} placeholder="9876543210" />
      </Field>
      <Field label="Email" error={err('email')}>
        <input className={inputClass} value={form.email} onChange={(e) => set('email', e.target.value)} />
      </Field>
      <Field label="Service Required" error={err('service_id')}>
        <select className={inputClass} value={form.service_id} onChange={(e) => set('service_id', e.target.value)}>
          <option value="">Select a service…</option>
          {(catalog.data?.items ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <Field
        label="Price Quoted (₹)"
        error={err('price_quoted')}
        hint="A quote, not a payment. Invoicing and receipts are handled in Accounts."
      >
        <input className={inputClass} type="number" min="0" value={form.price_quoted} onChange={(e) => set('price_quoted', e.target.value)} />
      </Field>
      <Field label="Assigned To" error={err('assigned_employee_id')}>
        <select className={inputClass} value={form.assigned_employee_id} onChange={(e) => set('assigned_employee_id', e.target.value)}>
          <option value="">Select an employee…</option>
          {(employees.data?.items ?? []).map((e) => (
            <option key={e.id} value={e.id}>{e.full_name} · {e.designation}</option>
          ))}
        </select>
      </Field>
      <Field label="Notes" error={err('notes')}>
        <textarea className={textareaClass} rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
      </Field>
      {/* Created date/time are system-generated (§5.2) — shown, never edited. */}
      <div className="text-12 text-neutral-500 border-t border-neutral-200 pt-3">
        Created: {fmtDate(new Date())} {fmtTime(new Date())} · set automatically, not editable.
      </div>
    </Modal>
  );
}
