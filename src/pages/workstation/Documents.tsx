import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { workstationApi } from '@/modules/workstation/api';
import {
  Card, Cell, FilterBar, PageHeader, QueryState, Row, Select, Status, Table,
} from '@/modules/workstation/components';
import type { ClientDocument, ListResponse } from '@/modules/workstation/types';
import { fmtDate } from '@/lib/format';

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

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Documents"
        subtitle="One document store per client, organised by category."
      />

      <FilterBar>
        <Select
          label="Client" value={clientId} onChange={(v) => setParam('client_id', v)}
          options={(clients.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.client_id} · ${c.company_name}` }))}
        />
        <Select
          label="Category" value={categoryId} onChange={(v) => setParam('category_id', v)}
          options={(categories.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))}
        />
        <Select
          label="Status" value={status} onChange={(v) => setParam('status', v)}
          options={['requested', 'pending', 'uploaded', 'under_review', 'verified', 'rejected', 'expired']
            .map((v) => ({ value: v, label: v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) }))}
        />
        <Select
          label="Financial year" value={fy} onChange={(v) => setParam('financial_year', v)}
          options={[{ value: '2026-27', label: '2026-27' }, { value: '2025-26', label: '2025-26' }]}
        />
      </FilterBar>

      <QueryState query={docs} empty="No documents match these filters.">
        {(data: ListResponse<ClientDocument>) => {
          // Client → Category → Document (§10.2).
          const byClient = new Map<string, ClientDocument[]>();
          for (const d of data.items) {
            const key = `${d.client_code} · ${d.client_name}`;
            byClient.set(key, [...(byClient.get(key) ?? []), d]);
          }
          return (
            <div className="space-y-4">
              {Array.from(byClient.entries()).map(([clientLabel, items]) => (
                <Card key={clientLabel} title={clientLabel}>
                  <Table head={['Document', 'Category', 'FY', 'Version', 'Uploaded By', 'Upload Date', 'Status']}>
                    {items.map((d) => (
                      <Row
                        key={d.id}
                        status={d.status}
                        onClick={() => navigate(`/workstation/clients/${d.client_id}/documents`)}
                      >
                        <Cell className="font-medium">{d.name}</Cell>
                        <Cell muted>{d.category_name}</Cell>
                        <Cell muted>{d.financial_year ?? '—'}</Cell>
                        <Cell muted>{d.version > 0 ? `v${d.version}` : '—'}</Cell>
                        <Cell muted>
                          {d.versions.length === 0
                            ? '—'
                            : d.versions[d.versions.length - 1].uploaded_via_portal
                              ? 'Client Portal'
                              : d.versions[d.versions.length - 1].uploaded_by_employee?.full_name ?? '—'}
                        </Cell>
                        <Cell muted>
                          {d.versions.length === 0 ? '—' : fmtDate(d.versions[d.versions.length - 1].uploaded_at)}
                        </Cell>
                        <Cell><Status value={d.status} /></Cell>
                      </Row>
                    ))}
                  </Table>
                </Card>
              ))}
            </div>
          );
        }}
      </QueryState>

      {docs.data ? (
        <p className="text-12 text-neutral-500 mt-3">
          {docs.data.count} document{docs.data.count === 1 ? '' : 's'} ·{' '}
          {docs.data.scope === 'organisation' ? 'all firm documents' : 'documents on clients assigned to you'}
        </p>
      ) : null}
    </div>
  );
}
