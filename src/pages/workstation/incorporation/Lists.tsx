import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { incorporationApi } from '@/modules/incorporation/api';
import { workstationApi } from '@/modules/workstation/api';
import {
  Card, Cell, FilterBar, PageHeader, QueryState, Select, Table, inputClass,
} from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { IncStatus, RecordedBy, incStatusBorder, titleCase } from '@/modules/incorporation/components';
import { fmtDate } from '@/lib/format';

/**
 * The cross-case screens: Tasks, Pending Items, Deliverables and Settings.
 * None of them holds state of its own — each is a view over the same rows the
 * case tabs write, so a number here can never disagree with a case.
 */

// ── Tasks ─────────────────────────────────────────────────────────────────
export function IncorporationTasksPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [overdue, setOverdue] = useState(false);

  const employees = useQuery({ queryKey: ['workstation', 'assignable-employees'], queryFn: workstationApi.assignableEmployees });
  const q = useQuery({
    queryKey: ['incorporation', 'all-tasks', status, employeeId, overdue],
    queryFn: () => incorporationApi.allTasks({ status, employee_id: employeeId, overdue }),
  });

  return (
    <div>
      <PageHeader
        title="Tasks"
        subtitle="Incorporation tasks across every case — rows in the platform's own task system"
      />
      <FilterBar>
        <Select
          label="Status" value={status} onChange={setStatus}
          options={['open', 'in_progress', 'blocked', 'done'].map((s) => ({ value: s, label: titleCase(s) }))}
        />
        <Select
          label="Assigned" value={employeeId} onChange={setEmployeeId}
          options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: e.full_name }))}
        />
        <label className="flex items-center gap-2 h-8 text-13 text-neutral-700">
          <input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} />
          Overdue only
        </label>
      </FilterBar>
      <Card>
        <QueryState query={q} empty="No incorporation tasks match these filters.">
          {(data) => (
            <Table head={['Task', 'Case', 'Client', 'Status', 'Assigned', 'Due']}>
              {data.items.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => t.incorporation_case_id && navigate(`../cases/${t.incorporation_case_id}?tab=tasks`)}
                  className={`h-10 border-b border-neutral-200 cursor-pointer hover:bg-neutral-50 ${incStatusBorder(t.status)}`}
                >
                  <Cell>{t.title}</Cell>
                  <Cell muted className="font-mono text-12">{t.case_code ?? '—'}</Cell>
                  <Cell muted>{t.client_name ?? '—'}</Cell>
                  <Cell><IncStatus value={t.status} /></Cell>
                  <Cell muted>{t.assigned_employee?.full_name ?? '—'}</Cell>
                  <Cell muted className={t.is_overdue ? 'text-red' : ''}>
                    {t.due_date ? fmtDate(t.due_date) : '—'}
                  </Cell>
                </tr>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>
    </div>
  );
}

// ── Pending Items ─────────────────────────────────────────────────────────
/**
 * One queue over the five things a case actually waits on. Every row
 * deep-links to the case tab that resolves it, so this is navigation rather
 * than a report you then have to go and act on somewhere else.
 */
const KIND_LABELS: Record<string, string> = {
  document: 'Documents', dsc: 'DSC', name: 'Names', query: 'Government queries', task: 'Overdue tasks',
};

export function IncorporationPendingItemsPage() {
  const navigate = useNavigate();
  const [kind, setKind] = useState('');
  const q = useQuery({
    queryKey: ['incorporation', 'pending-items', kind],
    queryFn: () => incorporationApi.pendingItems({ kind }),
  });

  return (
    <div>
      <PageHeader
        title="Pending Items"
        subtitle="Everything the firm is waiting on, across every open case"
      />
      <FilterBar>
        <Select
          label="Kind" value={kind} onChange={setKind}
          options={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))}
        />
      </FilterBar>
      <QueryState query={q} empty="Nothing is outstanding. Every case is up to date.">
        {(data) => (
          <div className="space-y-4">
            <div className="grid gap-3 grid-cols-2 md:grid-cols-5">
              {Object.entries(KIND_LABELS).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(kind === k ? '' : k)}
                  className={
                    'text-left bg-white border rounded px-4 py-3 hover:border-neutral-400 ' +
                    (kind === k ? 'border-gold' : 'border-neutral-200')
                  }
                >
                  <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
                  <div className="text-20 font-semibold text-neutral-900 mt-1 tabular-nums">
                    {data.counts_by_kind[k] ?? 0}
                  </div>
                </button>
              ))}
            </div>
            <Card>
              {data.items.length === 0 ? (
                <div className="px-4 py-6 text-13 text-neutral-500">Nothing outstanding in this category.</div>
              ) : (
                <Table head={['Item', 'Kind', 'Case', 'Client', 'Detail', 'Due']}>
                  {data.items.map((i, n) => (
                    <tr
                      key={`${i.kind}-${n}`}
                      onClick={() => i.case_id && navigate(`../cases/${i.case_id}?tab=${i.tab}`)}
                      className={
                        'h-10 border-b border-neutral-200 cursor-pointer hover:bg-neutral-50 ' +
                        (i.overdue ? 'border-l-2 border-red' : 'border-l-2 border-neutral-400')
                      }
                    >
                      <Cell>{i.title}</Cell>
                      <Cell muted>{KIND_LABELS[i.kind] ?? titleCase(i.kind)}</Cell>
                      <Cell muted className="font-mono text-12">{i.case_code ?? '—'}</Cell>
                      <Cell muted>{i.client_name ?? '—'}</Cell>
                      <Cell muted className="max-w-[320px] truncate">{i.detail ?? '—'}</Cell>
                      <Cell muted className={i.overdue ? 'text-red' : ''}>
                        {i.due_date ? fmtDate(i.due_date) : '—'}
                      </Cell>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        )}
      </QueryState>
    </div>
  );
}

// ── Deliverables ──────────────────────────────────────────────────────────
export function IncorporationDeliverablesPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const settings = useQuery({ queryKey: ['incorporation', 'settings'], queryFn: incorporationApi.settings });
  const q = useQuery({
    queryKey: ['incorporation', 'all-deliverables', status, type],
    queryFn: () => incorporationApi.allDeliverables({ status, type }),
  });

  return (
    <div>
      <PageHeader
        title="Deliverables"
        subtitle="Certificates, PAN, TAN and other outputs across every case — each reference recorded by an employee"
      />
      <FilterBar>
        <Select
          label="Status" value={status} onChange={setStatus}
          options={(settings.data?.vocabularies.deliverable_statuses ?? []).map((s) => ({ value: s, label: titleCase(s) }))}
        />
        <Select
          label="Type" value={type} onChange={setType}
          options={(settings.data?.vocabularies.deliverable_types ?? []).map((t) => ({ value: t, label: titleCase(t) }))}
        />
      </FilterBar>
      <Card>
        <QueryState query={q} empty="No deliverables recorded yet.">
          {(data) => (
            <Table head={['Deliverable', 'Type', 'Case', 'Client', 'Status', 'Reference', 'Linked file', 'Delivered', 'Provenance']}>
              {data.items.map((d) => (
                <tr
                  key={d.id}
                  onClick={() => navigate(`../cases/${d.case_id}?tab=deliverables`)}
                  className={`h-10 border-b border-neutral-200 cursor-pointer hover:bg-neutral-50 ${incStatusBorder(d.status)}`}
                >
                  <Cell>{d.name}</Cell>
                  <Cell muted>{titleCase(d.type)}</Cell>
                  <Cell muted className="font-mono text-12">{d.case_code ?? '—'}</Cell>
                  <Cell muted>{d.client_name ?? '—'}</Cell>
                  <Cell><IncStatus value={d.status} /></Cell>
                  <Cell muted className="font-mono text-12">{d.reference_no ?? '—'}</Cell>
                  <Cell muted>{d.client_document?.name ?? '—'}</Cell>
                  <Cell muted>{d.delivered_date ? fmtDate(d.delivered_date) : '—'}</Cell>
                  <Cell muted><RecordedBy row={d} /></Cell>
                </tr>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────
/**
 * Entity types and checklist templates. Read-only unless the caller holds
 * workstation.service.manage at organisation scope — and the server refuses
 * the write regardless of what this page renders, which is where the control
 * actually lives.
 */
export function IncorporationSettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['incorporation', 'settings'], queryFn: incorporationApi.settings });
  const [entityTypeId, setEntityTypeId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newCategory, setNewCategory] = useState('client');

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['incorporation'] });

  const saveType = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      incorporationApi.updateEntityType(id, patch),
    onSuccess: () => { invalidate(); toast.push('success', 'Entity type saved.'); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const addItem = useMutation({
    mutationFn: () => incorporationApi.createTemplateItem({
      category: newCategory, label: newLabel,
      entity_type_id: entityTypeId || undefined,
    }),
    onSuccess: () => { invalidate(); toast.push('success', 'Checklist item added.'); setNewLabel(''); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const toggleItem = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      incorporationApi.updateTemplateItem(id, { is_active: isActive }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.push('error', e.message),
  });

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Entity types and the checklist templates cases are built from"
      />
      <QueryState query={q}>
        {(data) => (
          <div className="space-y-4">
            {!data.can_manage_settings ? (
              <div className="border-l-2 border-neutral-400 bg-white px-3 py-2 text-12 text-neutral-600">
                You can see this configuration but not change it. Incorporation settings are
                managed at the firm level.
              </div>
            ) : null}

            <Card title="Entity types">
              <Table head={['Name', 'Code', 'Roles', 'People', 'Target days', 'Active']}>
                {data.entity_types.map((e) => (
                  <tr key={e.id} className="h-10 border-b border-neutral-200">
                    <Cell>{e.name}</Cell>
                    <Cell muted className="font-mono text-12">{e.code}</Cell>
                    <Cell muted className="text-12">
                      {e.party_roles.map((r) => titleCase(r)).join(', ')}
                    </Cell>
                    <Cell muted className="tabular-nums">
                      {e.min_parties}{e.max_parties ? `–${e.max_parties}` : '+'}
                    </Cell>
                    <Cell muted>
                      <input
                        type="number"
                        defaultValue={e.default_target_days}
                        disabled={!data.can_manage_settings}
                        onBlur={(ev) => {
                          const v = Number(ev.target.value);
                          if (v !== e.default_target_days) saveType.mutate({ id: e.id, patch: { default_target_days: v } });
                        }}
                        className="h-7 w-16 px-1 text-12 bg-white border border-neutral-300 rounded disabled:bg-neutral-50 disabled:text-neutral-400 focus:outline-none focus:border-gold"
                      />
                    </Cell>
                    <Cell>
                      <input
                        type="checkbox"
                        checked={e.is_active}
                        disabled={!data.can_manage_settings}
                        onChange={(ev) => saveType.mutate({ id: e.id, patch: { is_active: ev.target.checked } })}
                      />
                    </Cell>
                  </tr>
                ))}
              </Table>
            </Card>

            <Card
              title="Checklist template"
              right={
                <select
                  value={entityTypeId}
                  onChange={(e) => setEntityTypeId(e.target.value)}
                  className="h-7 px-1 text-12 bg-white border border-neutral-300 rounded focus:outline-none focus:border-gold"
                >
                  <option value="">Baseline (every entity type)</option>
                  {data.entity_types.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              }
            >
              <Table head={['Category', 'Item', 'Stage', 'Active']}>
                {data.checklist_templates
                  .filter((t) => (entityTypeId ? t.entity_type_id === entityTypeId : t.entity_type_id === null))
                  .map((t) => (
                    <tr key={t.id} className="h-10 border-b border-neutral-200">
                      <Cell muted>{titleCase(t.category)}</Cell>
                      <Cell>{t.label}</Cell>
                      <Cell muted className="text-12">{t.stage ? titleCase(t.stage) : '—'}</Cell>
                      <Cell>
                        <input
                          type="checkbox"
                          checked={t.is_active}
                          disabled={!data.can_manage_settings}
                          onChange={(e) => toggleItem.mutate({ id: t.id, isActive: e.target.checked })}
                        />
                      </Cell>
                    </tr>
                  ))}
              </Table>
              {data.can_manage_settings ? (
                <div className="px-4 py-3 border-t border-neutral-200 flex flex-wrap items-end gap-2">
                  <label className="block">
                    <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Category</span>
                    <select
                      value={newCategory}
                      onChange={(e) => setNewCategory(e.target.value)}
                      className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded focus:outline-none focus:border-gold"
                    >
                      {data.vocabularies.checklist_categories.map((c) => (
                        <option key={c} value={c}>{titleCase(c)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block flex-1 min-w-[220px]">
                    <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">New checklist item</span>
                    <input className={inputClass} value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
                  </label>
                  <Button onClick={() => addItem.mutate()} disabled={!newLabel.trim() || addItem.isPending}>
                    Add
                  </Button>
                </div>
              ) : null}
              <div className="px-4 pb-3">
                <p className="text-12 text-neutral-500">
                  New items apply to cases opened from now on. An existing case picks them up
                  with "Re-apply template" on its Checklist tab, which only ever adds — it never
                  resets work already done.
                </p>
              </div>
            </Card>
          </div>
        )}
      </QueryState>
    </div>
  );
}
