/**
 * Organization Clients — every client under an organization, as cards.
 * Each is a full CRM client: "Open Workspace" goes to its own workspace,
 * where only its own services, documents and tasks live.
 *
 * Add Client either creates a new client under the organization (the normal
 * client form, pre-linked) or links an existing client that has none.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, FileText, Layers, Link2, Plus, UserPlus } from 'lucide-react';
import { workstationApi } from '../api';
import { Field, Modal, QueryState, Status, inputClass } from '../components';
import { SearchBox } from '../listUi';
import type { ClientDetail, OrganizationClientCard, OrganizationOverview } from '../types';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';
import { AddClientModal } from '@/pages/workstation/Clients';
import { clientOptionLabel } from './badges';
import { LevelBanner } from './OrganizationOverview';

type Sort = 'code' | 'name' | 'services' | 'documents';

export function OrganizationClients({ org }: { org: ClientDetail }) {
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'workstation.client.manage', 'self');
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['workstation', 'organization', org.id, 'overview'],
    queryFn: () => workstationApi.organizationOverview(org.id),
  });

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState<Sort>('code');
  const [adding, setAdding] = useState<null | 'choose' | 'new' | 'existing'>(null);

  return (
    <QueryState query={q}>
      {(d: OrganizationOverview) => {
        const term = search.trim().toLowerCase();
        const rows = d.clients
          .filter((c) => !status || c.status === status)
          .filter((c) => !term || [c.company_name, c.client_id, c.gstin ?? '', c.contact_person, ...c.service_names]
            .some((v) => v.toLowerCase().includes(term)))
          .sort((a, b) => sort === 'name' ? a.company_name.localeCompare(b.company_name)
            : sort === 'services' ? b.active_service_count - a.active_service_count
            : sort === 'documents' ? b.document_count - a.document_count
            : a.client_id.localeCompare(b.client_id));
        return (
          <div className="space-y-4">
            <LevelBanner level="organization" name={org.company_name} />

            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-15 font-semibold text-neutral-900 mr-2">Organization Clients <span className="text-neutral-500 font-normal">({d.clients.length})</span></h2>
              <div className="flex-1" />
              <SearchBox value={search} onChange={setSearch} placeholder="Client, ID, GSTIN or service" />
              <select aria-label="Status" className={inputClass + ' !w-auto'} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All statuses</option>
                {['active', 'onboarding', 'pending_documents', 'service_due', 'inactive'].map((s) => (
                  <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                ))}
              </select>
              <select aria-label="Sort" className={inputClass + ' !w-auto'} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="code">Sort: Client ID</option>
                <option value="name">Sort: Name</option>
                <option value="services">Sort: Active services</option>
                <option value="documents">Sort: Documents</option>
              </select>
              {canManage ? (
                <Button variant="primary" onClick={() => setAdding('choose')}><Plus size={14} /> Add Client</Button>
              ) : null}
            </div>

            {rows.length === 0 ? (
              <div className="bg-white border border-dashed border-neutral-300 rounded-lg p-8 text-center text-13 text-neutral-500">
                {d.clients.length === 0
                  ? <>No clients under {org.company_name} yet.{canManage ? ' Use Add Client to create one or link an existing client.' : ''}</>
                  : 'No clients match these filters.'}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {rows.map((c) => <ClientCard key={c.id} c={c} canManage={canManage} />)}
              </div>
            )}

            <Modal open={adding === 'choose'} title={`Add Client to ${org.company_name}`} onClose={() => setAdding(null)}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button type="button" onClick={() => setAdding('new')} className="text-left rounded-lg border border-neutral-200 hover:border-primary p-4">
                  <UserPlus size={18} className="text-primary" />
                  <div className="text-13 font-semibold text-neutral-900 mt-2">Create a new client</div>
                  <div className="text-12 text-neutral-500 mt-1">Suggested name: {d.next_client_name}</div>
                </button>
                <button type="button" onClick={() => setAdding('existing')} className="text-left rounded-lg border border-neutral-200 hover:border-primary p-4">
                  <Link2 size={18} className="text-primary" />
                  <div className="text-13 font-semibold text-neutral-900 mt-2">Link an existing client</div>
                  <div className="text-12 text-neutral-500 mt-1">Its records stay as they are; it gains this organization.</div>
                </button>
              </div>
            </Modal>
            {adding === 'new' ? (
              <AddClientModal
                key={d.next_client_name}
                open
                onClose={() => setAdding(null)}
                organization={{ id: org.id, name: org.company_name }}
                defaultName={d.next_client_name}
                onCreated={(id) => navigate(`/workstation/clients/${id}`)}
              />
            ) : null}
            <LinkExistingModal org={org} open={adding === 'existing'} onClose={() => setAdding(null)} />
          </div>
        );
      }}
    </QueryState>
  );
}

function ClientCard({ c, canManage }: { c: OrganizationClientCard; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => workstationApi.updateClient(c.id, { organization_id: null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', `${c.company_name} removed from the organization. It is still a client.`);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  return (
    <div className="bg-white border border-neutral-200 rounded-lg p-4 flex flex-col">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-14 font-semibold text-neutral-900 truncate">{c.company_name}</div>
          <div className="font-mono text-11 text-neutral-500">{c.client_id}{c.gstin ? ` · ${c.gstin}` : ''}</div>
        </div>
        <Status value={c.status} />
      </div>
      <div className="mt-3 flex flex-wrap gap-1 min-h-[22px]">
        {c.service_names.length
          ? c.service_names.map((n) => <span key={n} className="text-11 px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-700">{n}</span>)
          : <span className="text-11 text-neutral-400">No services yet</span>}
      </div>
      <div className="mt-3 flex items-center gap-4 text-12 text-neutral-600">
        <span className="inline-flex items-center gap-1"><Layers size={13} /> {c.active_service_count} active service{c.active_service_count === 1 ? '' : 's'}</span>
        <span className="inline-flex items-center gap-1"><FileText size={13} /> {c.document_count} document{c.document_count === 1 ? '' : 's'}</span>
      </div>
      <div className="mt-4 pt-3 border-t border-neutral-100 flex items-center gap-2">
        <Link to={`/workstation/clients/${c.id}`} className="inline-flex items-center gap-1 text-13 font-medium text-primary hover:underline">
          Open Workspace <ArrowRight size={13} />
        </Link>
        <div className="flex-1" />
        {canManage ? (
          confirm ? (
            <>
              <button type="button" className="text-12 text-neutral-500" onClick={() => setConfirm(false)}>Cancel</button>
              <button type="button" className="text-12 text-danger font-medium" disabled={remove.isPending} onClick={() => remove.mutate()}>
                Confirm remove
              </button>
            </>
          ) : (
            <button type="button" className="text-12 text-neutral-500 hover:text-danger" onClick={() => setConfirm(true)} title="Unlink from the organization — the client itself is kept">
              Remove from organization
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}

function LinkExistingModal({ org, open, onClose }: { org: ClientDetail; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  // Only clients with no organization, and not organizations themselves.
  const candidates = useQuery({
    queryKey: ['workstation', 'clients', { kind: 'standalone' }],
    queryFn: () => workstationApi.listClients({ kind: 'standalone' }),
    enabled: open,
  });
  const [picked, setPicked] = useState('');
  const options = useMemo(() => (candidates.data?.items ?? []).filter((c) => c.id !== org.id), [candidates.data, org.id]);
  const link = useMutation({
    mutationFn: () => workstationApi.updateClient(picked, { organization_id: org.id }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', `${c.company_name} linked to ${org.company_name}.`);
      setPicked('');
      onClose();
    },
  });
  const err = link.error instanceof Error ? link.error.message : null;
  return (
    <Modal
      open={open}
      title={`Link an existing client to ${org.company_name}`}
      onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!picked || link.isPending} onClick={() => link.mutate()}>
          {link.isPending ? 'Linking…' : 'Link client'}
        </Button>
      </>}
    >
      <Field label="Client" hint="Clients already in an organization, and organizations, are not listed." error={err ?? undefined}>
        <select className={inputClass} value={picked} onChange={(e) => setPicked(e.target.value)}>
          <option value="">{candidates.isLoading ? 'Loading…' : 'Select a client…'}</option>
          {options.map((c) => <option key={c.id} value={c.id}>{clientOptionLabel(c)}</option>)}
        </select>
      </Field>
      <p className="text-12 text-neutral-500">The client keeps its own workspace, services and documents.</p>
    </Modal>
  );
}
