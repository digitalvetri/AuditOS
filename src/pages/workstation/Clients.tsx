import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { workstationApi } from '@/modules/workstation/api';
import {
  Card, Cell, FilterBar, PageHeader, QueryState, Row, SearchInput, Select, Status, Table,
} from '@/modules/workstation/components';
import type { ClientListItem, ListResponse } from '@/modules/workstation/types';

/** §7.3 — the client list. Search covers company · Client ID · GSTIN · contact. */
export function ClientsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

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

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Clients"
        subtitle="One record per company. Everything else references it."
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
    </div>
  );
}
