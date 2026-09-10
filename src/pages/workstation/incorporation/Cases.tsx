import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { incorporationApi } from '@/modules/incorporation/api';
import { workstationApi } from '@/modules/workstation/api';
import {
  Card, Cell, FilterBar, PageHeader, QueryState, SearchInput, Select,
} from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { IncStatus, ProgressBar, incStatusBorder, titleCase } from '@/modules/incorporation/components';
import { fmtDate } from '@/lib/format';

/**
 * CASES — the case list.
 *
 * Filter state lives in the URL, so a filtered view is a link an employee can
 * send to a colleague, the back button works, and an Overview tile can open
 * this page already narrowed. Pagination and sorting are SERVER-side: the
 * browser never receives rows it is not showing.
 */
const COLUMNS: { key: string; label: string; sortable?: boolean }[] = [
  { key: 'case_code', label: 'Case ID', sortable: true },
  { key: 'client', label: 'Client' },
  { key: 'entity_type', label: 'Entity Type' },
  { key: 'proposed_name', label: 'Proposed Name', sortable: true },
  { key: 'stage', label: 'Stage', sortable: true },
  { key: 'status', label: 'Status' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'priority', label: 'Priority', sortable: true },
  { key: 'target_date', label: 'Target Date', sortable: true },
  { key: 'updated_at', label: 'Last Updated', sortable: true },
];

export function IncorporationCasesPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const get = (k: string) => params.get(k) ?? '';
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    // Any filter change returns to page 1 — staying on page 7 of a result set
    // that now has two rows is a bug, not a feature.
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const page = Number(get('page')) || 1;
  const sort = get('sort') || 'updated_at';
  const dir = get('dir') || 'desc';

  const settings = useQuery({ queryKey: ['incorporation', 'settings'], queryFn: incorporationApi.settings });
  const employees = useQuery({
    queryKey: ['workstation', 'assignable-employees'],
    queryFn: workstationApi.assignableEmployees,
  });

  const filters = {
    q: get('q'), stage: get('stage'), status: get('status'),
    entity_type_id: get('entity_type_id'), employee_id: get('employee_id'),
    priority: get('priority'), from: get('from'), to: get('to'),
    overdue: get('overdue'), pending_documents: get('pending_documents'),
    page, page_size: 25, sort, dir,
  };

  const cases = useQuery({
    queryKey: ['incorporation', 'cases', filters],
    queryFn: () => incorporationApi.listCases(filters),
  });

  const toggleSort = (key: string) => {
    if (sort === key) set({ dir: dir === 'asc' ? 'desc' : 'asc' });
    else set({ sort: key, dir: 'asc' });
  };

  const stages = settings.data?.vocabularies.stages ?? [];
  const entityTypes = settings.data?.entity_types ?? [];

  return (
    <div>
      <PageHeader
        title="Cases"
        subtitle="Search by case ID, client, proposed name or a recorded reference number"
        action={<Button onClick={() => navigate('new')}>New Case</Button>}
      />

      <FilterBar>
        <SearchInput
          value={get('q')}
          onChange={(v) => set({ q: v })}
          placeholder="Case ID, client, name, reference"
        />
        <Select
          label="Entity Type" value={get('entity_type_id')}
          onChange={(v) => set({ entity_type_id: v })}
          options={entityTypes.map((e) => ({ value: e.id, label: e.name }))}
        />
        <Select
          label="Stage" value={get('stage')} onChange={(v) => set({ stage: v })}
          options={stages.map((s) => ({ value: s.stage, label: s.label }))}
        />
        <Select
          label="Status" value={get('status')} onChange={(v) => set({ status: v })}
          options={(settings.data?.vocabularies.case_statuses ?? []).map((s) => ({ value: s, label: titleCase(s) }))}
        />
        <Select
          label="Assigned" value={get('employee_id')} onChange={(v) => set({ employee_id: v })}
          options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: e.full_name }))}
        />
        <Select
          label="Priority" value={get('priority')} onChange={(v) => set({ priority: v })}
          options={(settings.data?.vocabularies.priorities ?? []).map((p) => ({ value: p, label: titleCase(p) }))}
        />
        <label className="block">
          <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Target from</span>
          <input
            type="date" value={get('from')} onChange={(e) => set({ from: e.target.value })}
            className="h-8 px-2 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
          />
        </label>
        <label className="block">
          <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Target to</span>
          <input
            type="date" value={get('to')} onChange={(e) => set({ to: e.target.value })}
            className="h-8 px-2 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
          />
        </label>
        <label className="flex items-center gap-2 h-8 text-13 text-neutral-700">
          <input
            type="checkbox" checked={get('overdue') === 'true'}
            onChange={(e) => set({ overdue: e.target.checked ? 'true' : '' })}
          />
          Overdue
        </label>
        <label className="flex items-center gap-2 h-8 text-13 text-neutral-700">
          <input
            type="checkbox" checked={get('pending_documents') === 'true'}
            onChange={(e) => set({ pending_documents: e.target.checked ? 'true' : '' })}
          />
          Pending documents
        </label>
      </FilterBar>

      <Card>
        <QueryState query={cases} empty="No cases match these filters.">
          {(data) => (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1080px] border-collapse">
                  <thead>
                    <tr className="border-b border-neutral-200">
                      {COLUMNS.map((c) => (
                        <th
                          key={c.key}
                          className="h-8 px-3 text-left text-11 uppercase tracking-[0.06em] font-medium text-neutral-500 whitespace-nowrap"
                        >
                          {c.sortable ? (
                            <button
                              type="button"
                              onClick={() => toggleSort(c.key)}
                              className="uppercase tracking-[0.06em] hover:text-neutral-900"
                            >
                              {c.label}{sort === c.key ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
                            </button>
                          ) : c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((c) => (
                      <tr
                        key={c.id}
                        onClick={() => navigate(c.id)}
                        className={`h-10 border-b border-neutral-200 cursor-pointer hover:bg-neutral-50 ${incStatusBorder(c.stage)}`}
                      >
                        <Cell className="font-mono text-12 whitespace-nowrap">{c.case_code}</Cell>
                        <Cell>{c.client_name ?? '—'}</Cell>
                        <Cell muted>{c.entity_type_name ?? '—'}</Cell>
                        <Cell>
                          {c.proposed_name}
                          {c.progress ? <ProgressBar percent={c.progress.percent} className="mt-1 max-w-[140px]" /> : null}
                        </Cell>
                        <Cell><IncStatus value={c.stage} /></Cell>
                        <Cell><IncStatus value={c.status} /></Cell>
                        <Cell muted>{c.assigned_employee?.full_name ?? '—'}</Cell>
                        <Cell muted>{titleCase(c.priority)}</Cell>
                        <Cell muted className="whitespace-nowrap">{c.target_date ? fmtDate(c.target_date) : '—'}</Cell>
                        <Cell muted className="whitespace-nowrap">{c.updated_at ? fmtDate(c.updated_at) : '—'}</Cell>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="h-10 px-4 flex items-center border-t border-neutral-200 gap-3">
                <span className="text-12 text-neutral-500 tabular-nums">
                  {data.total === 0
                    ? 'No cases'
                    : `${(data.page - 1) * data.page_size + 1}–${(data.page - 1) * data.page_size + data.count} of ${data.total}`}
                </span>
                <div className="flex-1" />
                <button
                  type="button"
                  disabled={data.page <= 1}
                  onClick={() => set({ page: String(data.page - 1) })}
                  className="text-13 text-neutral-700 disabled:text-neutral-300 hover:text-neutral-900"
                >
                  ← Previous
                </button>
                <button
                  type="button"
                  disabled={data.page * data.page_size >= data.total}
                  onClick={() => set({ page: String(data.page + 1) })}
                  className="text-13 text-neutral-700 disabled:text-neutral-300 hover:text-neutral-900"
                >
                  Next →
                </button>
              </div>
            </>
          )}
        </QueryState>
      </Card>
    </div>
  );
}
