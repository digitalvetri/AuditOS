import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { workstationApi } from '@/modules/workstation/api';
import { Plus } from 'lucide-react';
import {
  Field, Modal, QueryState, fieldErrors, inputClass, textareaClass,
} from '@/modules/workstation/components';
import {
  FilterSelect, ListAction, ListCard, ListEmpty, ListHeader, ListRow, ListTable, ListToolbar, Money, SearchBox,
  StatusChip, StatusPills, TD, TwoLine, fmtDay,
} from '@/modules/workstation/listUi';
import type { ListResponse, Lead } from '@/modules/workstation/types';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { fmtDate, fmtTime, inr } from '@/lib/format';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';
import { OrganizationBadge } from '@/modules/workstation/organization/badges';

/** §7.2 — the lead list, its filters and the Add Lead form. */
export function LeadsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  // `?add=1` (the top bar's Create menu) opens the add form on arrival.
  const [addOpen, setAddOpen] = useState(() => params.get('add') === '1');

  const status = params.get('status') ?? '';
  const serviceId = params.get('service_id') ?? '';
  const employeeId = params.get('employee_id') ?? '';
  const leadType = (params.get('lead_type') ?? '') as '' | 'individual' | 'organization';
  const q = params.get('q') ?? '';

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const leads = useQuery({
    queryKey: ['workstation', 'leads', { status, serviceId, employeeId, leadType, q }],
    queryFn: () => workstationApi.listLeads({ status, service_id: serviceId, employee_id: employeeId, lead_type: leadType || undefined, q }),
  });
  const catalog = useQuery({ queryKey: ['workstation', 'catalog'], queryFn: workstationApi.serviceCatalog });
  const employees = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees });

  const canManage = can(session?.role.code, 'workstation.lead.manage', 'self');

  return (
    <div className="max-w-[1400px]">
      <ListHeader
        title="Leads"
        meta={leads.data
          ? <>{leads.data.count} lead{leads.data.count === 1 ? '' : 's'} · {leads.data.scope === 'organisation' ? 'all firm leads' : 'leads assigned to you'}</>
          : 'Potential customers, before they become clients.'}
        action={canManage ? (
          <ListAction onClick={() => setAddOpen(true)} icon={<Plus size={15} />}>Add Lead</ListAction>
        ) : undefined}
      />

      <ListToolbar>
        <SearchBox value={q} onChange={(v) => setParam('q', v)} placeholder="Name, lead ID or number" />
        <FilterSelect
          label="Service" value={serviceId} onChange={(v) => setParam('service_id', v)}
          options={(catalog.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
        />
        <FilterSelect
          label="Assigned to" value={employeeId} onChange={(v) => setParam('employee_id', v)}
          options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: e.full_name }))}
        />
        <FilterSelect
          label="Lead type" value={leadType} onChange={(v) => setParam('lead_type', v)}
          options={[{ value: 'individual', label: 'Individual' }, { value: 'organization', label: 'Organization' }]}
        />
      </ListToolbar>
      <div className="mb-4">
        <StatusPills value={status} onChange={(v) => setParam('status', v)} options={[
          { value: '', label: 'All' },
          { value: 'new', label: 'New' },
          { value: 'contacted', label: 'Contacted' },
          { value: 'requirement_identified', label: 'Requirement Identified' },
          { value: 'quote_sent', label: 'Quote Sent' },
          { value: 'negotiation', label: 'Negotiation' },
          { value: 'won', label: 'Won' },
          { value: 'lost', label: 'Lost' },
        ]} />
      </div>

      <ListCard>
        <QueryState query={leads} empty={<ListEmpty>No leads match these filters.</ListEmpty>}>
          {(data: ListResponse<Lead>) => data.items.length === 0 ? <ListEmpty>No leads match these filters.</ListEmpty> : (
            <ListTable cols={['Lead', 'Contact', 'Service', { label: 'Price quoted', align: 'right' }, 'Created', 'Status', 'Assigned to']}>
              {data.items.map((l) => (
                <ListRow key={l.id} onOpen={() => navigate(`/workstation/leads/${l.id}`)}>
                  <TD first>
                    <TwoLine
                      top={l.lead_type === 'organization'
                        ? <span className="inline-flex items-center gap-2">{l.name} <OrganizationBadge /></span>
                        : l.name}
                      sub={l.lead_type === 'organization' && l.contact_person ? `${l.lead_id} · Contact: ${l.contact_person}` : l.lead_id}
                      avatar={l.name}
                    />
                  </TD>
                  <TD muted nowrap>{l.contact_number}</TD>
                  <TD muted>{l.service_name ?? '—'}</TD>
                  {/* Quoted, not received — Finance owns payment (§55). */}
                  <TD right strong nowrap className="tabular-nums"><Money value={inr(l.price_quoted_paise)} /></TD>
                  <TD muted nowrap>{fmtDay(l.created_at)} <span className="text-neutral-400">{fmtTime(l.created_at)}</span></TD>
                  <TD><StatusChip value={l.status} /></TD>
                  <TD last muted>{l.assigned_employee?.full_name ?? '—'}</TD>
                </ListRow>
              ))}
            </ListTable>
          )}
        </QueryState>
      </ListCard>

      <AddLeadModal open={addOpen && canManage} onClose={() => setAddOpen(false)} />
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
    lead_type: 'individual' as 'individual' | 'organization',
    name: '', contact_person: '', contact_number: '', service_id: '', price_quoted: '',
    assigned_employee_id: '', email: '', notes: '',
  });
  const isOrg = form.lead_type === 'organization';
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: () => workstationApi.createLead({
      lead_type: form.lead_type,
      name: form.name,
      contact_person: isOrg ? form.contact_person || undefined : undefined,
      contact_number: form.contact_number,
      service_id: form.service_id,
      price_quoted: Number(form.price_quoted || 0),
      assigned_employee_id: form.assigned_employee_id,
      email: form.email || undefined,
      notes: form.notes || undefined,
    }),
    onSuccess: (lead) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', `${lead.lead_type === 'organization' ? 'Organization lead' : 'Lead'} ${lead.lead_id} created.`);
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
      <Field
        label="Lead Type"
        error={err('lead_type')}
        hint={isOrg
          ? 'Converts into an Organization Client — a client that holds other clients.'
          : 'Converts into a normal client.'}
      >
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Lead type">
          {([
            ['individual', 'Individual / Lead', 'A person or a single business'],
            ['organization', 'Organization', 'A group with several clients under it'],
          ] as const).map(([value, label, sub]) => (
            <label
              key={value}
              className={'flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer ' +
                (form.lead_type === value ? 'border-primary bg-primary/5' : 'border-neutral-200 hover:border-neutral-300')}
            >
              <input
                type="radio" name="lead_type" value={value} className="mt-[3px]"
                checked={form.lead_type === value}
                onChange={() => set('lead_type', value)}
              />
              <span>
                <span className="block text-13 font-medium text-neutral-900">{label}</span>
                <span className="block text-11 text-neutral-500">{sub}</span>
              </span>
            </label>
          ))}
        </div>
      </Field>
      <Field label={isOrg ? 'Organization Name' : 'Name'} error={err('name')}>
        <input
          className={inputClass} value={form.name} onChange={(e) => set('name', e.target.value)}
          placeholder={isOrg ? 'e.g. ABC Business Solutions' : undefined}
        />
      </Field>
      {isOrg ? (
        <Field label="Contact Person" error={err('contact_person')} hint="Who you deal with at the organization.">
          <input className={inputClass} value={form.contact_person} onChange={(e) => set('contact_person', e.target.value)} />
        </Field>
      ) : null}
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
