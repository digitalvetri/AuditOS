import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { workstationApi } from '@/modules/workstation/api';
import {
  Field, Modal, QueryState, fieldErrors, inputClass,
} from '@/modules/workstation/components';
import {
  FilterSelect, ListAction, ListCard, ListEmpty, ListHeader, ListRow, ListTable, ListToolbar, StatusChip,
  StatusPills, TD, fmtDay,
} from '@/modules/workstation/listUi';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';
import type { ClientDocument, ListResponse } from '@/modules/workstation/types';
import { StatusSelect, useSetDocumentStatus } from '@/modules/workstation/documents/StatusSelect';
import {
  RequestButtons, SendRequestDialog, needsRequest, type RequestChannel, type RequestTarget,
} from '@/modules/workstation/documents/SendRequestDialog';

/**
 * §7.6 — the document list, grouped BY CLIENT.
 *
 * The grouping is the point: there is one document store per client, holding
 * GST, IT filing, company and other documents together. There is no
 * per-service document database anywhere in this module.
 */
export function DocumentsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const clientId = params.get('client_id') ?? '';
  const categoryId = params.get('category_id') ?? '';
  const status = params.get('status') ?? '';
  const fy = params.get('financial_year') ?? '';

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const docs = useQuery({
    queryKey: ['workstation', 'documents', { clientId, categoryId, status, fy }],
    queryFn: () => workstationApi.listDocuments({
      client_id: clientId, category_id: categoryId, status, financial_year: fy,
    }),
  });
  const categories = useQuery({ queryKey: ['workstation', 'doc-categories'], queryFn: workstationApi.documentCategories });
  const clients = useQuery({ queryKey: ['workstation', 'clients', 'picker'], queryFn: () => workstationApi.listClients() });
  const { session } = useAuth();
  const canAdd = can(session?.role.code, 'workstation.document.manage', 'self');
  const canVerify = can(session?.role.code, 'workstation.document.verify', 'self');
  const setStatus = useSetDocumentStatus();
  const [request, setRequest] = useState<{ target: RequestTarget; channel: RequestChannel } | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="max-w-[1400px]">
      <ListHeader
        title="Documents"
        meta={docs.data
          ? <>{docs.data.count} document{docs.data.count === 1 ? '' : 's'} · {docs.data.scope === 'organisation' ? 'all firm documents' : 'documents on clients assigned to you'}</>
          : 'One document store per client, organised by category.'}
        action={canAdd ? (
          <ListAction onClick={() => setAddOpen(true)} icon={<Plus size={15} />}>Add</ListAction>
        ) : undefined}
      />
      <AddDocumentModal
        open={addOpen} onClose={() => setAddOpen(false)}
        defaultClientId={clientId}
        clients={(clients.data?.items ?? []).map((c) => ({ id: c.id, label: `${c.client_id} · ${c.company_name}` }))}
        categories={categories.data?.items ?? []}
      />
      <SendRequestDialog
        target={request?.target ?? null}
        channel={request?.channel ?? 'whatsapp'}
        onClose={() => setRequest(null)}
      />

      <ListToolbar>
        <FilterSelect
          label="Client" value={clientId} onChange={(v) => setParam('client_id', v)}
          options={(clients.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.client_id} · ${c.company_name}` }))}
        />
        <FilterSelect
          label="Category" value={categoryId} onChange={(v) => setParam('category_id', v)}
          options={(categories.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))}
        />
        <FilterSelect
          label="Financial year" value={fy} onChange={(v) => setParam('financial_year', v)}
          options={[{ value: '2026-27', label: '2026-27' }, { value: '2025-26', label: '2025-26' }]}
        />
      </ListToolbar>
      <div className="mb-4">
        <StatusPills value={status} onChange={(v) => setParam('status', v)}
          options={[{ value: '', label: 'All' }, ...['requested', 'pending', 'uploaded', 'under_review', 'verified', 'rejected', 'expired']
            .map((v) => ({ value: v, label: v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) }))]} />
      </div>

      <QueryState query={docs} empty={<ListCard><ListEmpty>No documents match these filters.</ListEmpty></ListCard>}>
        {(data: ListResponse<ClientDocument>) => {
          // Client → Category → Document (§10.2).
          const byClient = new Map<string, ClientDocument[]>();
          for (const d of data.items) {
            const key = `${d.client_code} · ${d.client_name}`;
            byClient.set(key, [...(byClient.get(key) ?? []), d]);
          }
          if (!byClient.size) return <ListCard><ListEmpty>No documents match these filters.</ListEmpty></ListCard>;
          return (
            <div className="space-y-4">
              {Array.from(byClient.entries()).map(([clientLabel, items]) => (
                <ListCard key={clientLabel} title={<>{clientLabel} <span className="font-normal text-neutral-500">· {items.length}</span></>}>
                  <ListTable plainHead cols={['Document', 'Category', 'FY', 'Version', 'Uploaded by', 'Upload date', 'Status', ...(canAdd ? ['Request'] : [])]}>
                    {items.map((d) => {
                      const latest = d.versions[d.versions.length - 1];
                      return (
                        <ListRow key={d.id} onOpen={() => navigate(`/workstation/clients/${d.client_id}/documents`)}>
                          <TD first strong>{d.name}</TD>
                          <TD muted>{d.category_name}</TD>
                          <TD muted nowrap>{d.financial_year ?? '—'}</TD>
                          <TD muted>{d.version > 0 ? `v${d.version}` : '—'}</TD>
                          <TD muted>
                            {!latest ? '—' : latest.uploaded_via_portal ? 'Client Portal' : latest.uploaded_by_employee?.full_name ?? '—'}
                          </TD>
                          <TD muted nowrap>{latest ? fmtDay(latest.uploaded_at) : '—'}</TD>
                          <TD last={!canAdd}>
                            {canAdd ? (
                              <span onClick={(e) => e.stopPropagation()}>
                                <StatusSelect
                                  value={d.status}
                                  canVerify={canVerify}
                                  onChange={(next) => setStatus.mutate({ id: d.id, status: next })}
                                />
                              </span>
                            ) : <StatusChip value={d.status} />}
                          </TD>
                          {canAdd ? (
                            <TD last>
                              {needsRequest(d.status, d.version === 0) ? (
                                <span onClick={(e) => e.stopPropagation()}>
                                  <RequestButtons
                                    onPick={(channel) => setRequest({
                                      channel,
                                      target: { documentId: d.id, documentName: d.name, financialYear: d.financial_year, clientId: d.client_id },
                                    })}
                                  />
                                </span>
                              ) : <span className="text-12 text-neutral-400">—</span>}
                            </TD>
                          ) : null}
                                                  </ListRow>
                      );
                    })}
                  </ListTable>
                </ListCard>
              ))}
            </div>
          );
        }}
      </QueryState>
    </div>
  );
}

/**
 * Add a document to a client's store: either RECEIVED (recorded as version 1,
 * status "uploaded") or REQUESTED from the client. The same two endpoints the
 * client workspace and the registration panel use; this page only adds the
 * entry point, with the client picked here instead of implied by the page.
 */
function AddDocumentModal({ open, onClose, defaultClientId, clients, categories }: {
  open: boolean;
  onClose: () => void;
  defaultClientId: string;
  clients: { id: string; label: string }[];
  categories: { id: string; name: string }[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { session } = useAuth();
  const employees = useQuery({ queryKey: ['workstation', 'assignable-employees'], queryFn: workstationApi.assignableEmployees, enabled: open });
  const today = new Date().toISOString().slice(0, 10);
  const blank = {
    client: defaultClientId, category_id: '', name: '', financial_year: '2026-27', received: true, notes: '',
    version: '1', uploaded_by: session?.employee?.id ?? '', uploaded_at: today,
  };
  const [form, setForm] = useState(blank);
  const [clientError, setClientError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const add = useMutation({
    mutationFn: async () => {
      const doc = await workstationApi.requestDocument(form.client, {
        name: form.name.trim(), category_id: form.category_id,
        financial_year: form.financial_year.trim() || undefined,
        status: form.received ? 'pending' : 'requested',
      });
      // Received now: record version 1, which marks it uploaded.
      return form.received
        ? workstationApi.addDocumentVersion(doc.id, {
          notes: form.notes.trim() || undefined,
          version: Number(form.version) || 1,
          uploaded_by_employee_id: form.uploaded_by || undefined,
          uploaded_at: form.uploaded_at || undefined,
        })
        : doc;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', form.received ? 'Document added.' : 'Document request recorded.');
      setForm({ ...blank, client: form.client });
      onClose();
    },
  });
  const e = fieldErrors(add.error);

  const submit = () => {
    if (!form.client) { setClientError('Select a client.'); return; }
    setClientError(null);
    add.mutate();
  };

  return (
    <Modal
      open={open} title="Add document" onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={add.isPending} onClick={submit}>
            {add.isPending ? 'Adding…' : form.received ? 'Add document' : 'Record request'}
          </Button>
        </>
      }
    >
      <Field label="Client" error={clientError ?? undefined}>
        <select className={inputClass} value={form.client} onChange={(ev) => set('client', ev.target.value)}>
          <option value="">Select a client…</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </Field>
      <Field label="Category" error={e.category_id}>
        <select className={inputClass} value={form.category_id} onChange={(ev) => set('category_id', ev.target.value)}>
          <option value="">Select a category…</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Document" error={e.name}>
        <input className={inputClass} value={form.name} onChange={(ev) => set('name', ev.target.value)} placeholder="e.g. Bank Statement — August 2026" />
      </Field>
      <Field label="Financial year" error={e.financial_year}>
        <input className={inputClass} value={form.financial_year} onChange={(ev) => set('financial_year', ev.target.value)} />
      </Field>
      <Field label="Status">
        <div className="flex flex-wrap gap-4 text-13 text-neutral-800 py-1">
          <label className="inline-flex items-center gap-2">
            <input type="radio" checked={form.received} onChange={() => set('received', true)} /> Received — add it now
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="radio" checked={!form.received} onChange={() => set('received', false)} /> Request from client
          </label>
        </div>
      </Field>
      {form.received ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Version" error={e.version}>
            <input className={inputClass} inputMode="numeric" value={form.version}
              onChange={(ev) => set('version', ev.target.value.replace(/[^0-9]/g, ''))} />
          </Field>
          <Field label="Uploaded By" error={e.uploaded_by_employee_id}>
            <select className={inputClass} value={form.uploaded_by} onChange={(ev) => set('uploaded_by', ev.target.value)}>
              <option value="">Me</option>
              {(employees.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
            </select>
          </Field>
          <Field label="Upload Date" error={e.uploaded_at}>
            <input type="date" className={inputClass} value={form.uploaded_at} max={today}
              onChange={(ev) => set('uploaded_at', ev.target.value)} />
          </Field>
        </div>
      ) : null}
      {form.received ? (
        <Field label="Notes" error={e.notes}>
          <input className={inputClass} value={form.notes} onChange={(ev) => set('notes', ev.target.value)} placeholder="Optional" />
        </Field>
      ) : null}
      {add.error && !Object.keys(e).length ? (
        <div className="border-l-2 border-red pl-3 text-13 text-red">{(add.error as Error).message}</div>
      ) : null}
    </Modal>
  );
}
