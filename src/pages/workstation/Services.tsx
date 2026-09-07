import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { workstationApi } from '@/modules/workstation/api';
import {
  Card, Cell, FilterBar, PageHeader, QueryState, Row, Select, Status, Table,
} from '@/modules/workstation/components';
import type { ClientService, ListResponse } from '@/modules/workstation/types';
import { fmtDate } from '@/lib/format';

/** §7.4 — every service the caller may see, across all their clients. */
export function ServicesPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const status = params.get('status') ?? '';
  const serviceId = params.get('service_id') ?? '';
  const employeeId = params.get('employee_id') ?? '';
  const due = params.get('due') ?? '';

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const services = useQuery({
    queryKey: ['workstation', 'services', { status, serviceId, employeeId, due }],
    queryFn: () => workstationApi.listServices({
      status, service_id: serviceId, employee_id: employeeId,
      due: (due || undefined) as 'overdue' | 'soon' | undefined,
    }),
  });
  const catalog = useQuery({ queryKey: ['workstation', 'catalog'], queryFn: workstationApi.serviceCatalog });
  const employees = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees });

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="">
      <PageHeader
        title="Services"
        subtitle="The work Audit OS is doing for its clients."
      />

      <FilterBar>
        <Select
          label="Service type" value={serviceId} onChange={(v) => setParam('service_id', v)}
          options={(catalog.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
        />
        <Select
          label="Status" value={status} onChange={(v) => setParam('status', v)}
          options={[
            'not_started', 'documents_pending', 'in_progress', 'under_review',
            'ready', 'submitted', 'completed', 'failed', 'on_hold',
          ].map((v) => ({ value: v, label: v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) }))}
        />
        <Select
          label="Employee" value={employeeId} onChange={(v) => setParam('employee_id', v)}
          options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: e.full_name }))}
        />
        <Select
          label="Due date" value={due} onChange={(v) => setParam('due', v)}
          options={[
            { value: 'overdue', label: 'Overdue' },
            { value: 'soon', label: 'Due in 7 days' },
          ]}
          allLabel="Any"
        />
      </FilterBar>

      <Card>
        <QueryState query={services} empty="No services match these filters.">
          {(data: ListResponse<ClientService>) => (
            <Table head={['Service', 'Client', 'Assigned To', 'Status', 'Due Date', 'Last Updated']}>
              {data.items.map((s) => (
                <Row key={s.id} status={s.status} onClick={() => navigate(`/workstation/clients/${s.client_id}/services`)}>
                  <Cell className="font-medium">{s.service_name}</Cell>
                  <Cell muted>{s.client_name}</Cell>
                  <Cell muted>{s.assigned_employee?.full_name ?? '—'}</Cell>
                  <Cell><Status value={s.status} /></Cell>
                  <Cell>
                    {s.due_date ? (
                      <span className={s.due_date < today && s.status !== 'completed' ? 'text-neutral-900 font-medium' : 'text-neutral-500'}>
                        {fmtDate(s.due_date)}
                      </span>
                    ) : <span className="text-neutral-500">—</span>}
                  </Cell>
                  <Cell muted>{fmtDate(s.updated_at)}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>

      {services.data ? (
        <p className="text-12 text-neutral-500 mt-3">
          {services.data.count} service{services.data.count === 1 ? '' : 's'} ·{' '}
          {services.data.scope === 'organisation' ? 'all firm services' : 'services on clients assigned to you'}
        </p>
      ) : null}
    </div>
  );
}
