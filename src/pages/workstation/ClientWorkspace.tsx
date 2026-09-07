import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { workstationApi } from '@/modules/workstation/api';
import {
  Card, Cell, Detail, Field, Modal, QueryState, Row, SimulatedNotice, Status,
  Table, fieldErrors, inputClass, textareaClass,
} from '@/modules/workstation/components';
import type {
  Activity, ClientDetail, ClientDocument, ClientService, EwayResponse,
  GstProfile, FollowUp, ListResponse, Task,
} from '@/modules/workstation/types';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { fmtDate, fmtDateTime, fmtTime, inr } from '@/lib/format';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';

/**
 * THE CLIENT WORKSPACE (§7.3).
 *
 * Nine tabs, each a nested route segment rather than local state, so a tab is
 * deep-linkable and the breadcrumb reads correctly. A tab the caller cannot
 * read is not rendered — and its endpoint answers 403 regardless, because
 * hiding a tab is not an access control.
 */
const TABS = [
  { key: '', label: 'Overview', perm: 'workstation.client.read' },
  { key: 'details', label: 'Company Details', perm: 'workstation.client.read' },
  { key: 'services', label: 'Services', perm: 'workstation.service.read' },
  { key: 'gst', label: 'GST', perm: 'workstation.gst.read' },
  { key: 'eway', label: 'E-way Bills', perm: 'workstation.eway.read' },
  { key: 'documents', label: 'Documents', perm: 'workstation.document.read' },
  { key: 'follow-ups', label: 'Follow-ups', perm: 'workstation.followup.read' },
  { key: 'tasks', label: 'Tasks', perm: 'workstation.service.read' },
  { key: 'activity', label: 'Activity', perm: 'workstation.client.read' },
] as const;

export function ClientWorkspacePage() {
  const { id = '', tab = '' } = useParams();
  const { session } = useAuth();
  const role = session?.role.code;

  const query = useQuery({
    queryKey: ['workstation', 'client', id],
    queryFn: () => workstationApi.getClient(id),
  });

  const visibleTabs = TABS.filter((t) =>
    can(role, t.perm as Parameters<typeof can>[1], 'self'));

  return (
    <div className="max-w-[1200px] mx-auto">
      <QueryState query={query}>
        {(client: ClientDetail) => (
          <>
            {/* Header (§7.3) */}
            <header className="mb-4">
              <h1 className="text-20 font-semibold text-neutral-900">{client.company_name}</h1>
              <div className="text-13 text-neutral-500 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{client.client_id}</span>
                {client.gstin ? <span>GSTIN {client.gstin}</span> : null}
                {client.pan ? <span>PAN {client.pan}</span> : null}
                <span>{client.contact_person}</span>
                <span>{client.contact_number}</span>
                {client.email ? <span>{client.email}</span> : null}
                <span>AM: {client.account_manager?.full_name ?? '—'}</span>
                <Status value={client.status} />
              </div>
            </header>

            {/* Tabs — 2px gold underline on the active one, matching the
                sidebar's active treatment. */}
            <nav className="flex flex-wrap gap-x-4 border-b border-neutral-200 mb-4 overflow-x-auto">
              {visibleTabs.map((t) => (
                <NavLink
                  key={t.key}
                  end={t.key === ''}
                  to={`/workstation/clients/${client.id}${t.key ? `/${t.key}` : ''}`}
                  className={({ isActive }) =>
                    'h-8 flex items-center text-13 whitespace-nowrap border-b-2 -mb-px transition-colors ' +
                    (isActive
                      ? 'border-gold text-neutral-900 font-medium'
                      : 'border-transparent text-neutral-500 hover:text-neutral-900')
                  }
                >
                  {t.label}
                </NavLink>
              ))}
            </nav>

            {tab === '' ? <OverviewTab client={client} /> : null}
            {tab === 'details' ? <DetailsTab client={client} /> : null}
            {tab === 'services' ? <ServicesTab client={client} /> : null}
            {tab === 'gst' ? <GstTab client={client} /> : null}
            {tab === 'eway' ? <EwayTab client={client} /> : null}
            {tab === 'documents' ? <DocumentsTab client={client} /> : null}
            {tab === 'follow-ups' ? <FollowUpsTab client={client} /> : null}
            {tab === 'tasks' ? <TasksTab client={client} /> : null}
            {tab === 'activity' ? <ActivityTab client={client} /> : null}
          </>
        )}
      </QueryState>
    </div>
  );
}

// ── Overview (§7.3) ───────────────────────────────────────────────────────
function OverviewTab({ client }: { client: ClientDetail }) {
  const services = useQuery({
    queryKey: ['workstation', 'client', client.id, 'services'],
    queryFn: () => workstationApi.clientServices(client.id),
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
      <Card title="Active services">
        <QueryState query={services} empty="No services assigned yet.">
          {(data: ListResponse<ClientService>) => (
            <Table head={['Service', 'Status', 'Assigned To', 'Next Due']}>
              {data.items.map((s) => (
                <Row key={s.id} status={s.status}>
                  <Cell className="font-medium">{s.service_name}</Cell>
                  <Cell><Status value={s.status} /></Cell>
                  <Cell muted>{s.assigned_employee?.full_name ?? '—'}</Cell>
                  <Cell muted>{s.due_date ? fmtDate(s.due_date) : '—'}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>

      <Card title="Client status">
        <div className="p-4">
          <Detail label="Status" value={<Status value={client.status} />} />
          <Detail label="Onboarded" value={fmtDate(client.onboarding_date)} />
          <Detail label="Account Manager" value={client.account_manager?.full_name ?? '—'} />
          <Detail label="Documents" value={`${client.document_count}`} />
          <Detail label="Follow-ups" value={`${client.follow_up_count}`} />
          {client.source_lead_id ? (
            <Detail
              label="Source"
              value={
                <a className="underline" href={`/workstation/leads/${client.source_lead_id}`}>
                  Converted from a lead
                </a>
              }
            />
          ) : null}
        </div>
      </Card>
    </div>
  );
}

// ── Company details (§7.3) ────────────────────────────────────────────────
function DetailsTab({ client }: { client: ClientDetail }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <Card title="Basic">
        <div className="p-4">
          <Detail label="Company Name" value={client.company_name} />
          <Detail label="Legal Name" value={client.legal_name ?? '—'} />
          <Detail label="Business Type" value={client.business_type ?? '—'} />
          <Detail label="Contact Person" value={client.contact_person} />
          <Detail label="Contact Number" value={client.contact_number} />
          <Detail label="Email" value={client.email ?? '—'} />
          <Detail label="Address" value={client.address ?? '—'} />
        </div>
      </Card>
      <Card title="Tax">
        <div className="p-4">
          <Detail label="GSTIN" value={client.gstin ?? '—'} />
          <Detail label="PAN" value={client.pan ?? '—'} />
          <Detail label="TAN" value={client.tan ?? '—'} />
        </div>
      </Card>
      <Card title="Internal">
        <div className="p-4">
          <Detail label="Client ID" value={client.client_id} />
          <Detail label="Account Manager" value={client.account_manager?.full_name ?? '—'} />
          <Detail label="Assigned Team" value={client.assigned_team ?? '—'} />
          <Detail label="Onboarding Date" value={fmtDate(client.onboarding_date)} />
          <Detail label="Client Status" value={<Status value={client.status} />} />
          <Detail
            label="Client Portal"
            value={client.portal_enabled ? 'Enabled' : 'Not enabled — portal not yet built'}
          />
        </div>
      </Card>
    </div>
  );
}

// ── Services (§7.4) ───────────────────────────────────────────────────────
const SERVICE_STATUSES = [
  'not_started', 'documents_pending', 'in_progress', 'under_review',
  'ready', 'submitted', 'completed', 'failed', 'on_hold',
];

function ServicesTab({ client }: { client: ClientDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { session } = useAuth();
  const [addOpen, setAddOpen] = useState(false);

  const services = useQuery({
    queryKey: ['workstation', 'client', client.id, 'services'],
    queryFn: () => workstationApi.clientServices(client.id),
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      workstationApi.updateService(id, { status }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', 'Service updated.');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const canManage = can(session?.role.code, 'workstation.service.manage', 'self');

  return (
    <>
      <Card
        title="Services"
        right={canManage ? <Button variant="primary" onClick={() => setAddOpen(true)}>Assign Service</Button> : undefined}
      >
        <QueryState query={services} empty="No services assigned yet.">
          {(data: ListResponse<ClientService>) => (
            <Table head={['Service', 'Assigned To', 'Manager', 'Due Date', 'Status', 'Last Updated']}>
              {data.items.map((s) => (
                <Row key={s.id} status={s.status}>
                  <Cell className="font-medium">{s.service_name}</Cell>
                  <Cell muted>{s.assigned_employee?.full_name ?? '—'}</Cell>
                  <Cell muted>{s.manager?.full_name ?? '—'}</Cell>
                  <Cell muted>{s.due_date ? fmtDate(s.due_date) : '—'}</Cell>
                  <Cell>
                    {canManage ? (
                      <select
                        value={s.status}
                        onChange={(e) => setStatus.mutate({ id: s.id, status: e.target.value })}
                        className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded focus:outline-none focus:border-gold"
                      >
                        {SERVICE_STATUSES.map((v) => (
                          <option key={v} value={v}>
                            {v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Status value={s.status} />
                    )}
                  </Cell>
                  <Cell muted>{fmtDate(s.updated_at)}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>
      <AssignServiceModal client={client} open={addOpen} onClose={() => setAddOpen(false)} />
    </>
  );
}

function AssignServiceModal({ client, open, onClose }: { client: ClientDetail; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const catalog = useQuery({ queryKey: ['workstation', 'catalog'], queryFn: workstationApi.serviceCatalog });
  const employees = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees });
  const [form, setForm] = useState({ service_id: '', assigned_employee_id: '', manager_id: '', due_date: '', notes: '' });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const create = useMutation({
    mutationFn: () => workstationApi.addClientService(client.id, {
      service_id: form.service_id,
      assigned_employee_id: form.assigned_employee_id,
      manager_id: form.manager_id || undefined,
      due_date: form.due_date || undefined,
      notes: form.notes || undefined,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', 'Service assigned.');
      onClose();
    },
  });
  const e = fieldErrors(create.error);

  return (
    <Modal
      open={open} title="Assign Service" onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>Assign</Button>
        </>
      }
    >
      <Field label="Service" error={e.service_id}>
        <select className={inputClass} value={form.service_id} onChange={(ev) => set('service_id', ev.target.value)}>
          <option value="">Select a service…</option>
          {(catalog.data?.items ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <Field label="Assigned To" error={e.assigned_employee_id}>
        <select className={inputClass} value={form.assigned_employee_id} onChange={(ev) => set('assigned_employee_id', ev.target.value)}>
          <option value="">Select an employee…</option>
          {(employees.data?.items ?? []).map((emp) => (
            <option key={emp.id} value={emp.id}>{emp.full_name} · {emp.designation}</option>
          ))}
        </select>
      </Field>
      <Field label="Manager" error={e.manager_id}>
        <select className={inputClass} value={form.manager_id} onChange={(ev) => set('manager_id', ev.target.value)}>
          <option value="">None</option>
          {(employees.data?.items ?? []).map((emp) => (
            <option key={emp.id} value={emp.id}>{emp.full_name}</option>
          ))}
        </select>
      </Field>
      <Field label="Due Date" error={e.due_date}>
        <input className={inputClass} type="date" value={form.due_date} onChange={(ev) => set('due_date', ev.target.value)} />
      </Field>
      <Field label="Notes" error={e.notes}>
        <textarea className={textareaClass} rows={3} value={form.notes} onChange={(ev) => set('notes', ev.target.value)} />
      </Field>
    </Modal>
  );
}

// ── GST (§7.3) ────────────────────────────────────────────────────────────
function GstTab({ client }: { client: ClientDetail }) {
  const gst = useQuery({
    queryKey: ['workstation', 'client', client.id, 'gst'],
    queryFn: () => workstationApi.clientGst(client.id),
  });

  return (
    <QueryState query={gst}>
      {(profile: GstProfile | null) =>
        !profile ? (
          <Card><div className="px-4 py-6 text-13 text-neutral-500">This client is not GST-registered in Audit OS.</div></Card>
        ) : (
          <div className="space-y-6">
            <Card title="GST profile">
              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-x-6">
                <div>
                  <Detail label="GSTIN" value={profile.gstin} />
                  <Detail label="Registration Status" value={<Status value={profile.registration_status} />} />
                  <Detail label="Filing Frequency" value={profile.filing_frequency} />
                </div>
                <div>
                  <Detail label="GST Service Status" value={<Status value={profile.service_status} />} />
                  <Detail label="Last Filing" value={profile.last_filed_at ? fmtDate(profile.last_filed_at) : '—'} />
                  <Detail label="Next Due Date" value={profile.next_due_date ? fmtDate(profile.next_due_date) : '—'} />
                  <Detail label="Assigned Employee" value={profile.assigned_employee?.full_name ?? '—'} />
                </div>
              </div>
            </Card>

            <Card title="Filings">
              <Table head={['Period', 'Return Type', 'Status', 'Filing Date', 'Assigned To', 'Remarks']}>
                {profile.filings.map((f) => (
                  <Row key={f.id} status={f.status}>
                    <Cell>{f.period}</Cell>
                    <Cell muted>{f.return_type}</Cell>
                    <Cell><Status value={f.status} /></Cell>
                    <Cell muted>{f.filed_at ? fmtDate(f.filed_at) : '—'}</Cell>
                    <Cell muted>{f.assigned_employee?.full_name ?? '—'}</Cell>
                    <Cell muted>{f.remarks ?? '—'}</Cell>
                  </Row>
                ))}
              </Table>
            </Card>

            <SimulatedNotice>
              Filing status is recorded manually in Audit OS. There is no GSTN connection —
              nothing here is filed with the government by this system.
            </SimulatedNotice>
          </div>
        )
      }
    </QueryState>
  );
}

// ── E-way bills (§7.3) — simulated ────────────────────────────────────────
function EwayTab({ client }: { client: ClientDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { session } = useAuth();
  const [open, setOpen] = useState(false);

  const eway = useQuery({
    queryKey: ['workstation', 'client', client.id, 'eway'],
    queryFn: () => workstationApi.clientEway(client.id),
  });

  const [form, setForm] = useState({ document_no: '', document_date: '', to_party_name: '', to_gstin: '', value: '' });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const generate = useMutation({
    mutationFn: () => workstationApi.generateEway(client.id, {
      document_no: form.document_no,
      document_date: form.document_date,
      to_party_name: form.to_party_name || undefined,
      to_gstin: form.to_gstin || undefined,
      value: Number(form.value || 0),
    }),
    onSuccess: (row) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', `${row.ewb_no} generated (simulated).`);
      setOpen(false);
    },
  });
  const e = fieldErrors(generate.error);
  const canGenerate = can(session?.role.code, 'workstation.eway.generate', 'self');

  return (
    <QueryState query={eway}>
      {(data: EwayResponse) => (
        <div className="space-y-4">
          <SimulatedNotice>
            <strong className="font-medium">E-way Bill Service · SIMULATED.</strong>{' '}
            {data.connection.notice}
          </SimulatedNotice>

          <Card
            title="E-way bills"
            right={canGenerate ? <Button variant="primary" onClick={() => setOpen(true)}>Generate</Button> : undefined}
          >
            {data.items.length === 0 ? (
              <div className="px-4 py-6 text-13 text-neutral-500">No e-way bills for this client.</div>
            ) : (
              <Table head={['EWB No', 'Document', 'Date', 'Consignee', 'Value', 'Status', 'Valid Until']}>
                {data.items.map((b) => (
                  <Row key={b.id} status={b.status}>
                    <Cell className="font-medium">{b.ewb_no}</Cell>
                    <Cell muted>{b.document_no}</Cell>
                    <Cell muted>{fmtDate(b.document_date)}</Cell>
                    <Cell muted>{b.to_party_name ?? '—'}</Cell>
                    <Cell>{inr(b.value_paise)}</Cell>
                    <Cell><Status value={b.status} /></Cell>
                    <Cell muted>{b.valid_until ? fmtDate(b.valid_until) : '—'}</Cell>
                  </Row>
                ))}
              </Table>
            )}
          </Card>

          <Modal
            open={open} title="Generate E-way Bill (simulated)" onClose={() => setOpen(false)}
            footer={
              <>
                <Button onClick={() => setOpen(false)}>Cancel</Button>
                <Button variant="primary" disabled={generate.isPending} onClick={() => generate.mutate()}>Generate</Button>
              </>
            }
          >
            <SimulatedNotice>
              This generates a local number for demonstration. No request is sent to the
              government e-way bill portal.
            </SimulatedNotice>
            <div className="h-4" />
            <Field label="Document No" error={e.document_no}>
              <input className={inputClass} value={form.document_no} onChange={(ev) => set('document_no', ev.target.value)} />
            </Field>
            <Field label="Document Date" error={e.document_date}>
              <input className={inputClass} type="date" value={form.document_date} onChange={(ev) => set('document_date', ev.target.value)} />
            </Field>
            <Field label="Consignee" error={e.to_party_name}>
              <input className={inputClass} value={form.to_party_name} onChange={(ev) => set('to_party_name', ev.target.value)} />
            </Field>
            <Field label="Consignee GSTIN" error={e.to_gstin}>
              <input className={inputClass} value={form.to_gstin} onChange={(ev) => set('to_gstin', ev.target.value.toUpperCase())} />
            </Field>
            <Field label="Value (₹)" error={e.value}>
              <input className={inputClass} type="number" min="0" value={form.value} onChange={(ev) => set('value', ev.target.value)} />
            </Field>
          </Modal>
        </div>
      )}
    </QueryState>
  );
}

// ── Documents (§7.6) ──────────────────────────────────────────────────────
function DocumentsTab({ client }: { client: ClientDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { session } = useAuth();
  const role = session?.role.code;
  const [requestOpen, setRequestOpen] = useState(false);

  const docs = useQuery({
    queryKey: ['workstation', 'client', client.id, 'documents'],
    queryFn: () => workstationApi.clientDocuments(client.id),
  });
  const categories = useQuery({ queryKey: ['workstation', 'doc-categories'], queryFn: workstationApi.documentCategories });

  const upload = useMutation({
    mutationFn: (id: string) => workstationApi.addDocumentVersion(id),
    onSuccess: (doc) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', `${doc.name} uploaded as v${doc.version}.`);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const verify = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) =>
      workstationApi.verifyDocument(id, approve, approve ? undefined : 'Rejected on review.'),
    onSuccess: (doc) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', `${doc.name} ${doc.status}.`);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const canManage = can(role, 'workstation.document.manage', 'self');
  const canVerify = can(role, 'workstation.document.verify', 'self');

  return (
    <>
      <Card
        title="Documents"
        right={canManage ? <Button variant="primary" onClick={() => setRequestOpen(true)}>Request Document</Button> : undefined}
      >
        <QueryState query={docs} empty="No documents for this client yet.">
          {(data: ListResponse<ClientDocument>) => {
            // Client → Category → Document (§10.2).
            const byCategory = new Map<string, ClientDocument[]>();
            for (const d of data.items) {
              const key = d.category_name ?? 'Other';
              byCategory.set(key, [...(byCategory.get(key) ?? []), d]);
            }
            return (
              <div>
                {Array.from(byCategory.entries()).map(([category, items]) => (
                  <div key={category}>
                    <div className="h-8 px-4 flex items-center bg-neutral-50 border-b border-neutral-200 text-11 uppercase tracking-[0.06em] text-neutral-500">
                      {category}
                    </div>
                    <Table head={['Document', 'FY', 'Version', 'Uploaded By', 'Status', 'Actions']}>
                      {items.map((d) => (
                        <Row key={d.id} status={d.status}>
                          <Cell className="font-medium">{d.name}</Cell>
                          <Cell muted>{d.financial_year ?? '—'}</Cell>
                          <Cell muted>{d.version > 0 ? `v${d.version}` : '—'}</Cell>
                          <Cell muted>
                            {d.versions.length === 0
                              ? '—'
                              : d.versions[d.versions.length - 1].uploaded_via_portal
                                ? 'Client Portal'
                                : d.versions[d.versions.length - 1].uploaded_by_employee?.full_name ?? '—'}
                          </Cell>
                          <Cell><Status value={d.status} /></Cell>
                          <Cell>
                            <div className="flex gap-2">
                              {canManage ? (
                                <button
                                  type="button"
                                  className="text-12 text-neutral-700 underline hover:text-neutral-900"
                                  onClick={() => upload.mutate(d.id)}
                                >
                                  Upload new version
                                </button>
                              ) : null}
                              {canVerify && d.version > 0 && d.status !== 'verified' ? (
                                <button
                                  type="button"
                                  className="text-12 text-neutral-700 underline hover:text-neutral-900"
                                  onClick={() => verify.mutate({ id: d.id, approve: true })}
                                >
                                  Verify
                                </button>
                              ) : null}
                            </div>
                          </Cell>
                        </Row>
                      ))}
                    </Table>
                  </div>
                ))}
              </div>
            );
          }}
        </QueryState>
      </Card>

      <RequestDocumentModal
        client={client}
        categories={categories.data?.items ?? []}
        open={requestOpen}
        onClose={() => setRequestOpen(false)}
      />
    </>
  );
}

function RequestDocumentModal({
  client, categories, open, onClose,
}: {
  client: ClientDetail;
  categories: { id: string; name: string }[];
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', category_id: '', financial_year: '2026-27' });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const create = useMutation({
    mutationFn: () => workstationApi.requestDocument(client.id, {
      name: form.name, category_id: form.category_id,
      financial_year: form.financial_year || undefined, status: 'requested',
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', 'Document request recorded.');
      onClose();
    },
  });
  const e = fieldErrors(create.error);

  return (
    <Modal
      open={open} title="Request Document" onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>Send Request</Button>
        </>
      }
    >
      <Field label="Client" error={undefined}>
        <input className={inputClass} value={`${client.client_id} · ${client.company_name}`} readOnly />
      </Field>
      <Field label="Category" error={e.category_id}>
        <select className={inputClass} value={form.category_id} onChange={(ev) => set('category_id', ev.target.value)}>
          <option value="">Select a category…</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Document Required" error={e.name}>
        <input className={inputClass} value={form.name} onChange={(ev) => set('name', ev.target.value)} placeholder="e.g. Bank Statement — August 2026" />
      </Field>
      <Field label="Financial Year" error={e.financial_year}>
        <input className={inputClass} value={form.financial_year} onChange={(ev) => set('financial_year', ev.target.value)} />
      </Field>
      {/* The Client Portal handoff is MODELLED, not built (§7.6). */}
      <SimulatedNotice>
        Client Portal is not yet available. This request is recorded in Audit OS; no
        message is sent to the client.
      </SimulatedNotice>
    </Modal>
  );
}

// ── Follow-ups · Tasks · Activity ─────────────────────────────────────────
function FollowUpsTab({ client }: { client: ClientDetail }) {
  const query = useQuery({
    queryKey: ['workstation', 'client', client.id, 'follow-ups'],
    queryFn: () => workstationApi.listFollowUps({ client_id: client.id }),
  });
  const navigate = useNavigate();
  return (
    <Card
      title="Follow-ups"
      right={
        <button type="button" className="text-12 text-neutral-500 hover:text-neutral-900"
          onClick={() => navigate('/workstation/follow-ups')}>
          All follow-ups
        </button>
      }
    >
      <QueryState query={query} empty="No follow-ups for this client.">
        {(data: ListResponse<FollowUp>) => (
          <Table head={['Follow-up', 'Type', 'Date', 'Time', 'Assigned To', 'Status']}>
            {data.items.map((f) => (
              <Row key={f.id} status={f.status}>
                <Cell className="font-medium">{f.title}</Cell>
                <Cell muted>{f.type.replace(/_/g, ' ')}</Cell>
                <Cell muted>{fmtDate(f.scheduled_at)}</Cell>
                <Cell muted>{fmtTime(f.scheduled_at)}</Cell>
                <Cell muted>{f.assigned_employee?.full_name ?? '—'}</Cell>
                <Cell><Status value={f.status} /></Cell>
              </Row>
            ))}
          </Table>
        )}
      </QueryState>
    </Card>
  );
}

function TasksTab({ client }: { client: ClientDetail }) {
  const query = useQuery({
    queryKey: ['workstation', 'client', client.id, 'tasks'],
    queryFn: () => workstationApi.clientTasks(client.id),
  });
  return (
    <Card title="Tasks">
      <QueryState query={query} empty="No tasks for this client. Tasks are created inside a service.">
        {(data: ListResponse<Task>) => (
          <Table head={['Task', 'Assigned To', 'Due Date', 'Status']}>
            {data.items.map((t) => (
              <Row key={t.id} status={t.status}>
                <Cell className="font-medium">{t.title}</Cell>
                <Cell muted>{t.assigned_employee?.full_name ?? '—'}</Cell>
                <Cell muted>{t.due_date ? fmtDate(t.due_date) : '—'}</Cell>
                <Cell><Status value={t.status} /></Cell>
              </Row>
            ))}
          </Table>
        )}
      </QueryState>
    </Card>
  );
}

function ActivityTab({ client }: { client: ClientDetail }) {
  const query = useQuery({
    queryKey: ['workstation', 'client', client.id, 'activity'],
    queryFn: () => workstationApi.clientActivity(client.id),
  });
  return (
    <Card title="Activity">
      <QueryState query={query} empty="No activity recorded yet.">
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
  );
}
