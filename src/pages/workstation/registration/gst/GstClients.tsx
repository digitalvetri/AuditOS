/**
 * GST → Clients (§28).
 *
 * These are the firm's EXISTING clients with a GST profile attached — this
 * screen creates no second client record, which is why every row carries the
 * client's own name and code from Workstation.
 *
 * Editing is limited to the GST-specific facts: GSTIN, PAN, state,
 * registration type and status, filing frequency, who works the account and
 * who reviews it. The client's own name, phone and address belong to
 * Workstation → Clients and are deliberately not editable here — two screens
 * owning one fact is how they drift apart.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Card, PageHeader, QueryState, Table, Row, Cell, Status,
  Modal, Field, inputClass,
} from '@/modules/workstation/components';
import { workstationApi } from '@/modules/workstation/api';
import {
  gstApi, errorMessage, FILING_FREQUENCIES, REGISTRATION_STATUSES, REGISTRATION_TYPES,
  type GstClient,
} from '@/modules/workstation/gst/api';

const labelOf = (list: { value: string; label: string }[], v: string) =>
  list.find((o) => o.value === v)?.label ?? v;

export function GstClients() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<GstClient | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const clients = useQuery({ queryKey: ['gst', 'clients'], queryFn: () => gstApi.clients() });
  const employees = useQuery({
    queryKey: ['workstation', 'assignable-employees'],
    queryFn: () => workstationApi.assignableEmployees(),
    enabled: !!editing,
  });

  const close = () => { setEditing(null); setForm({}); setErrMsg(null); };
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => gstApi.updateClient(editing!.id, body),
    onSuccess: () => { close(); void qc.invalidateQueries({ queryKey: ['gst'] }); },
    onError: (e) => setErrMsg(errorMessage(e)),
  });

  const open = (c: GstClient) => {
    setErrMsg(null);
    setEditing(c);
    setForm({
      gstin: c.gstin ?? '',
      pan: c.pan ?? '',
      legal_name: c.legal_name ?? '',
      state: c.state ?? '',
      registration_type: c.registration_type,
      registration_status: c.registration_status,
      filing_frequency: c.filing_frequency,
      assigned_employee_id: c.assigned_employee_id ?? '',
      reviewer_employee_id: c.reviewer_employee_id ?? '',
      active: c.active ? 'yes' : 'no',
    });
  };
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="GST clients"
        subtitle="Clients registered for GST, their GSTIN and who files for them."
      />
      <Card title="Registered clients">
        <QueryState query={clients}>
          {(d) =>
            d.items.length === 0 ? (
              <div className="px-4 py-6 text-13 text-neutral-500">
                No client has a GST profile yet.
              </div>
            ) : (
              <Table head={['Client', 'GSTIN', 'PAN', 'State', 'Type', 'Frequency', 'Assigned', 'Reviewer', 'Periods', 'Status', '']}>
                {d.items.map((c) => (
                  <Row key={c.id} status={c.registration_status}>
                    <Cell>{c.client_name ?? c.legal_name ?? '—'}</Cell>
                    <Cell muted><span className="font-mono text-12">{c.gstin}</span></Cell>
                    <Cell muted><span className="font-mono text-12">{c.pan ?? '—'}</span></Cell>
                    <Cell muted>{c.state ?? '—'}</Cell>
                    <Cell muted>{labelOf(REGISTRATION_TYPES, c.registration_type)}</Cell>
                    <Cell muted>{labelOf(FILING_FREQUENCIES, c.filing_frequency)}</Cell>
                    <Cell muted>{c.assigned_employee_name ?? '—'}</Cell>
                    <Cell muted>{c.reviewer_employee_name ?? '—'}</Cell>
                    <Cell muted>{c.period_count}</Cell>
                    <Cell><Status value={c.registration_status} /></Cell>
                    <Cell>
                      <button
                        type="button"
                        onClick={() => open(c)}
                        className="text-13 text-primary hover:underline min-h-[44px] md:min-h-0"
                      >
                        Edit
                      </button>
                    </Cell>
                  </Row>
                ))}
              </Table>
            )
          }
        </QueryState>
      </Card>

      <Modal
        open={editing !== null}
        title={editing ? `Edit ${editing.client_name ?? editing.gstin}` : ''}
        onClose={close}
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} className="h-9 px-3 text-13 border border-neutral-300 rounded">
              Cancel
            </button>
            <button
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate({
                gstin: form.gstin,
                pan: form.pan || null,
                legal_name: form.legal_name || null,
                state: form.state || null,
                registration_type: form.registration_type,
                registration_status: form.registration_status,
                filing_frequency: form.filing_frequency,
                assigned_employee_id: form.assigned_employee_id || null,
                reviewer_employee_id: form.reviewer_employee_id || null,
                active: form.active === 'yes',
              })}
              className="h-9 px-3 text-13 bg-neutral-900 text-white rounded disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        }
      >
        {errMsg ? (
          <div className="mb-3 text-13 text-red border-l-2 border-red pl-3 py-1">{errMsg}</div>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-3">
          <Field label="GSTIN" hint="15 characters — the PAN inside it must match the PAN below.">
            <input
              className={`${inputClass} font-mono uppercase`}
              value={form.gstin ?? ''}
              onChange={(e) => set('gstin', e.target.value.toUpperCase())}
              maxLength={15}
              placeholder="33ABCDE1234F1Z5"
            />
          </Field>
          <Field label="PAN">
            <input
              className={`${inputClass} font-mono uppercase`}
              value={form.pan ?? ''}
              onChange={(e) => set('pan', e.target.value.toUpperCase())}
              maxLength={10}
              placeholder="ABCDE1234F"
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-3">
          <Field label="Legal name" hint="Only if it differs from the client's trading name.">
            <input className={inputClass} value={form.legal_name ?? ''} onChange={(e) => set('legal_name', e.target.value)} />
          </Field>
          <Field label="State">
            <input className={inputClass} value={form.state ?? ''} onChange={(e) => set('state', e.target.value)} placeholder="Tamil Nadu" />
          </Field>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-x-3">
          <Field label="Registration type">
            <select className={inputClass} value={form.registration_type ?? ''} onChange={(e) => set('registration_type', e.target.value)}>
              {REGISTRATION_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label="Registration status">
            <select className={inputClass} value={form.registration_status ?? ''} onChange={(e) => set('registration_status', e.target.value)}>
              {REGISTRATION_STATUSES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label="Filing frequency" hint="Drives the due dates.">
            <select className={inputClass} value={form.filing_frequency ?? ''} onChange={(e) => set('filing_frequency', e.target.value)}>
              {FILING_FREQUENCIES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-x-3">
          <Field label="Assigned employee">
            <select className={inputClass} value={form.assigned_employee_id ?? ''} onChange={(e) => set('assigned_employee_id', e.target.value)}>
              <option value="">Choose…</option>
              {(employees.data?.items ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name ?? e.id}</option>)}
            </select>
          </Field>
          <Field label="Reviewer">
            <select className={inputClass} value={form.reviewer_employee_id ?? ''} onChange={(e) => set('reviewer_employee_id', e.target.value)}>
              <option value="">None</option>
              {(employees.data?.items ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name ?? e.id}</option>)}
            </select>
          </Field>
          <Field label="In the GST roster" hint="Inactive clients drop out of the work queues.">
            <select className={inputClass} value={form.active ?? 'yes'} onChange={(e) => set('active', e.target.value)}>
              <option value="yes">Active</option>
              <option value="no">Inactive</option>
            </select>
          </Field>
        </div>
      </Modal>
    </div>
  );
}
