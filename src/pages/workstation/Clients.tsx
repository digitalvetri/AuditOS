import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { workstationApi } from '@/modules/workstation/api';
import {
  Card, Cell, Field, FilterBar, Modal, PageHeader, QueryState, Row, SearchInput,
  Select, Status, Table, fieldErrors, inputClass, textareaClass,
} from '@/modules/workstation/components';
import type { ClientListItem, ListResponse } from '@/modules/workstation/types';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';

/** §7.3 — the client list. Search covers company · Client ID · GSTIN · contact. */
export function ClientsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const [addOpen, setAddOpen] = useState(false);

  const q = params.get('q') ?? '';
  const status = params.get('status') ?? '';
  const managerId = params.get('account_manager_id') ?? '';
  const serviceId = params.get('service_id') ?? '';
  const pendingDocs = params.get('pending_documents') === 'true';

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const clients = useQuery({
    queryKey: ['workstation', 'clients', { q, status, managerId, serviceId, pendingDocs }],
    queryFn: () => workstationApi.listClients({
      q, status, account_manager_id: managerId, service_id: serviceId,
      pending_documents: pendingDocs || undefined,
    }),
  });
  const catalog = useQuery({ queryKey: ['workstation', 'catalog'], queryFn: workstationApi.serviceCatalog });
  const employees = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees });

  const canManage = can(session?.role.code, 'workstation.client.manage', 'self');

  return (
    <div className="">
      <PageHeader
        title="Clients"
        subtitle="One record per company. Everything else references it."
        action={canManage ? (
          <Button variant="primary" onClick={() => setAddOpen(true)}>Add Client</Button>
        ) : undefined}
      />

      <FilterBar>
        <SearchInput value={q} onChange={(v) => setParam('q', v)} placeholder="Company, Client ID, GSTIN, contact" />
        <Select
          label="Status" value={status} onChange={(v) => setParam('status', v)}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'onboarding', label: 'Onboarding' },
            { value: 'pending_documents', label: 'Pending Documents' },
            { value: 'service_due', label: 'Service Due' },
            { value: 'inactive', label: 'Inactive' },
          ]}
        />
        <Select
          label="Service" value={serviceId} onChange={(v) => setParam('service_id', v)}
          options={(catalog.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
        />
        <Select
          label="Account manager" value={managerId} onChange={(v) => setParam('account_manager_id', v)}
          options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: e.full_name }))}
        />
        <label className="flex items-center gap-2 h-8 text-13 text-neutral-700">
          <input
            type="checkbox"
            checked={pendingDocs}
            onChange={(e) => setParam('pending_documents', e.target.checked ? 'true' : '')}
          />
          Pending documents
        </label>
      </FilterBar>

      <Card>
        <QueryState query={clients} empty="No clients match these filters.">
          {(data: ListResponse<ClientListItem>) => (
            <Table head={['Client ID', 'Company', 'GSTIN', 'Services', 'Account Manager', 'Status', 'Documents']}>
              {data.items.map((c) => (
                <Row key={c.id} status={c.status} onClick={() => navigate(`/workstation/clients/${c.id}`)}>
                  <Cell muted>{c.client_id}</Cell>
                  <Cell className="font-medium">{c.company_name}</Cell>
                  <Cell muted>{c.gstin ?? '—'}</Cell>
                  <Cell muted>{c.service_names.length ? c.service_names.join(' + ') : '—'}</Cell>
                  <Cell muted>{c.account_manager?.full_name ?? '—'}</Cell>
                  <Cell><Status value={c.status} /></Cell>
                  <Cell muted>{c.document_count} Document{c.document_count === 1 ? '' : 's'}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>

      {clients.data ? (
        <p className="text-12 text-neutral-500 mt-3">
          {clients.data.count} client{clients.data.count === 1 ? '' : 's'} ·{' '}
          {clients.data.scope === 'organisation' ? 'all firm clients' : 'clients assigned to you'}
        </p>
      ) : null}

      <AddClientModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}

/**
 * Add Client (§7.3).
 *
 * A client created here starts in `onboarding`, and its Client ID is issued by
 * the server — neither is an input, because both are the record's identity
 * rather than someone's choice. A lead that converts takes the same path via
 * Leads → Convert, so there is exactly one way a Client row comes to exist.
 */
function AddClientModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const employees = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees });

  const [form, setForm] = useState({
    company_name: '', business_type: '', contact_person: '', contact_number: '',
    email: '', gstin: '', pan: '', address: '', account_manager_id: '',
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: () => workstationApi.createClient({
      company_name: form.company_name,
      contact_person: form.contact_person,
      contact_number: form.contact_number,
      account_manager_id: form.account_manager_id,
      business_type: form.business_type || undefined,
      email: form.email || undefined,
      // GSTIN and PAN are stored upper-case; normalise here so the value the
      // user sees submitted is the value that gets stored.
      gstin: form.gstin ? form.gstin.toUpperCase() : undefined,
      pan: form.pan ? form.pan.toUpperCase() : undefined,
      address: form.address || undefined,
    }),
    onSuccess: (client) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', `Client ${client.client_id} created.`);
      onClose();
      navigate(`/workstation/clients/${client.id}`);
    },
  });

  // Client-side validation mirrors the server's, so the obvious mistakes are
  // caught without a round trip — but the server validates again regardless.
  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!form.company_name.trim()) e.company_name = 'This field is required.';
    if (!form.contact_person.trim()) e.contact_person = 'This field is required.';
    if (!/^[6-9]\d{9}$/.test(form.contact_number.replace(/[\s\-()]/g, '').replace(/^\+91/, ''))) {
      e.contact_number = 'Enter a valid 10-digit Indian mobile number.';
    }
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      e.email = 'Enter a valid email address.';
    }
    if (form.gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z]\d$/.test(form.gstin.toUpperCase())) {
      e.gstin = 'Enter a valid 15-character GSTIN.';
    }
    if (form.pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(form.pan.toUpperCase())) {
      e.pan = 'Enter a valid 10-character PAN.';
    }
    if (!form.account_manager_id) e.account_manager_id = 'Select an employee.';
    setClientErrors(e);
    return Object.keys(e).length === 0;
  }

  const serverErrors = fieldErrors(create.error);
  const err = (f: string) => clientErrors[f] ?? serverErrors[f];

  return (
    <Modal
      open={open}
      title="Add Client"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={create.isPending}
            onClick={() => { if (validate()) create.mutate(); }}
          >
            {create.isPending ? 'Saving…' : 'Create Client'}
          </Button>
        </>
      }
    >
      <Field label="Company Name" error={err('company_name')}>
        <input className={inputClass} value={form.company_name} onChange={(e) => set('company_name', e.target.value)} />
      </Field>
      <Field label="Business Type" error={err('business_type')} hint="Private Limited, LLP, Proprietorship…">
        <input className={inputClass} value={form.business_type} onChange={(e) => set('business_type', e.target.value)} />
      </Field>
      <Field label="Contact Person" error={err('contact_person')}>
        <input className={inputClass} value={form.contact_person} onChange={(e) => set('contact_person', e.target.value)} />
      </Field>
      <Field label="Contact Number" error={err('contact_number')}>
        <input className={inputClass} value={form.contact_number} onChange={(e) => set('contact_number', e.target.value)} placeholder="9876543210" />
      </Field>
      <Field label="Email" error={err('email')}>
        <input className={inputClass} value={form.email} onChange={(e) => set('email', e.target.value)} />
      </Field>
      <Field label="GSTIN" error={err('gstin')} hint="Optional — leave empty if the client is unregistered.">
        <input
          className={inputClass} value={form.gstin}
          onChange={(e) => set('gstin', e.target.value.toUpperCase())}
          placeholder="33AABCU9603R1ZM" maxLength={15}
        />
      </Field>
      <Field label="PAN" error={err('pan')}>
        <input
          className={inputClass} value={form.pan}
          onChange={(e) => set('pan', e.target.value.toUpperCase())}
          placeholder="AABCU9603R" maxLength={10}
        />
      </Field>
      <Field label="Address" error={err('address')}>
        <textarea className={textareaClass} rows={3} value={form.address} onChange={(e) => set('address', e.target.value)} />
      </Field>
      <Field label="Account Manager" error={err('account_manager_id')}>
        <select className={inputClass} value={form.account_manager_id} onChange={(e) => set('account_manager_id', e.target.value)}>
          <option value="">Select an employee…</option>
          {(employees.data?.items ?? []).map((e) => (
            <option key={e.id} value={e.id}>{e.full_name} · {e.designation}</option>
          ))}
        </select>
      </Field>
      {/* Client ID and status are system-assigned (§5.2) — stated, never edited. */}
      <div className="text-12 text-neutral-500 border-t border-neutral-200 pt-3">
        Client ID is issued on save · status starts as Onboarding.
      </div>
    </Modal>
  );
}
