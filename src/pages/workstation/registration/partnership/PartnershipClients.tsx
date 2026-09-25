import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { type CaseFilters, type EntityType } from '@/modules/partnership/api';
import { workstationApi } from '@/modules/workstation/api';
import {
  Card, Cell, Field, FilterBar, Modal, PageHeader, QueryState, Row, SearchInput, Select, Status, Table,
  fieldErrors, inputClass,
} from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import type { ApiError } from '@/services/api';
import { CASE_STATUS_OPTIONS, DueChip, EmployeeSelect, ENTITY_TYPE_OPTIONS, ProgressBar, useEmployees, useSvc } from './shared';
import { recentPeriods, periodLabel } from '@/modules/workstation/gst/api';

/**
 * Only clients ENROLLED in Partnership Firm Registration — one row per case.
 * Every filter and the search go to the server; nothing is filtered here.
 */
export function PartnershipClients() {
  const { api: regApi, keys: regKeys, stageOptions, stageLabel, label, caseUrl, isReturnKind } = useSvc();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'workstation.service.manage', 'self');
  const employees = useEmployees();

  const [q, setQ] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 300); return () => clearTimeout(t); }, [q]);

  const get = (k: string) => params.get(k) ?? '';
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };
  // Return kinds need a period selector; registrations don't. The default
  // is the current calendar month, unless the URL already carries one.
  const defaultPeriod = new Date().toISOString().slice(0, 7);
  const currentPeriod = isReturnKind ? (get('period') || defaultPeriod) : '';
  const progress = get('progress');
  const [pmin, pmax] = progress ? progress.split('-') : ['', ''];
  const filters: CaseFilters = {
    q: debounced || undefined,
    status: get('status') || undefined,
    stage: get('stage') || undefined,
    assignee: get('assignee') || undefined,
    reviewer: get('reviewer') || undefined,
    due: get('due') || undefined,
    doc_status: get('doc_status') || undefined,
    progress_min: pmin || undefined,
    progress_max: pmax || undefined,
    sort: get('sort') || 'recent',
    dir: get('dir') || 'asc',
    period: isReturnKind ? currentPeriod : undefined,
  };
  const list = useQuery({ queryKey: regKeys.cases(filters), queryFn: () => regApi.listCases(filters) });

  const periodOptions = isReturnKind ? recentPeriods(12) : [];
  const bumpPeriod = (dir: -1 | 1) => {
    const idx = periodOptions.findIndex((p) => p.value === currentPeriod);
    const next = periodOptions[idx + (dir === 1 ? -1 : 1)];
    if (next) set('period', next.value);
  };

  return (
    <>
      <PageHeader
        title={isReturnKind ? `${label} Clients — ${periodLabel(currentPeriod)}` : `${label} Clients`}
        subtitle={isReturnKind
          ? 'Open a client to work its checklist and documents.'
          : `Clients enrolled for ${label}. Open one to work its checklist and documents.`}
        action={canManage && !isReturnKind ? <Button variant="primary" onClick={() => set('add', '1')}>+ Add Client</Button> : undefined}
      />
      {isReturnKind ? (
        <div className="flex items-center gap-2 mb-3">
          <Button size="sm" onClick={() => bumpPeriod(-1)} aria-label="Previous period">◂</Button>
          <select className={inputClass + ' h-9 max-w-[220px]'} value={currentPeriod} onChange={(e) => set('period', e.target.value)}>
            {periodOptions.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <Button size="sm" onClick={() => bumpPeriod(1)} aria-label="Next period">▸</Button>
        </div>
      ) : null}
      <FilterBar>
        <SearchInput value={q} onChange={setQ} placeholder="Client, case ID, employee, document" />
        <Select label="Status" value={get('status')} onChange={(v) => set('status', v)} options={CASE_STATUS_OPTIONS} />
        <Select label="Stage" value={get('stage')} onChange={(v) => set('stage', v)} options={stageOptions} />
        <Select label="Assigned" value={get('assignee')} onChange={(v) => set('assignee', v)} options={[{ value: 'unassigned', label: 'Unassigned' }, ...employees]} />
        <Select label="Reviewer" value={get('reviewer')} onChange={(v) => set('reviewer', v)} options={employees} />
        <Select label="Due" value={get('due')} onChange={(v) => set('due', v)} options={[
          { value: 'overdue', label: 'Overdue' }, { value: 'today', label: 'Due today' },
          { value: 'soon', label: 'Due in 3 days' }, { value: 'none', label: 'No due date' },
        ]} />
        <Select label="Progress" value={progress} onChange={(v) => set('progress', v)} options={[
          { value: '0-0', label: '0%' }, { value: '1-49', label: '1–49%' },
          { value: '50-99', label: '50–99%' }, { value: '100-100', label: '100%' },
        ]} />
        <Select label="Documents" value={get('doc_status')} onChange={(v) => set('doc_status', v)} options={[
          { value: 'pending', label: 'Uploads pending' },
          { value: 'awaiting_verification', label: 'Awaiting verification' },
          { value: 'verified', label: 'All verified' },
        ]} />
        <Select label="Sort" value={get('sort')} allLabel="Recently added" onChange={(v) => set('sort', v)} options={[
          { value: 'client', label: 'Client name' }, { value: 'due', label: 'Due date' },
          { value: 'progress', label: 'Progress' }, { value: 'status', label: 'Status' },
        ]} />
        {get('sort') && get('sort') !== 'recent' ? (
          <Button size="sm" onClick={() => set('dir', get('dir') === 'desc' ? 'asc' : 'desc')}>
            {get('dir') === 'desc' ? '↓ Desc' : '↑ Asc'}
          </Button>
        ) : null}
      </FilterBar>

      <Card>
        <QueryState
          query={list}
          empty={
            params.toString() && params.toString() !== 'add=1'
              ? 'No cases match these filters.'
              : <span>No {label} clients yet.{canManage ? <> <button className="underline" onClick={() => set('add', '1')}>+ Add Client</button></> : null}</span>
          }
        >
          {(d) => (
            <>
              <Table head={['Client', 'Status', 'Stage', 'Progress', 'Documents', 'Assigned', 'Next Due', '']}>
                {d.items.map((c) => (
                  <Row key={c.id} status={c.status.toLowerCase()} onClick={() => navigate(caseUrl(c.id))}>
                    <Cell>
                      <div className="font-medium">{c.client.name}</div>
                      <div className="text-12 text-neutral-500">{c.case_code}</div>
                    </Cell>
                    <Cell><Status value={c.status.toLowerCase()} /></Cell>
                    <Cell muted>{stageLabel(c.stage)}</Cell>
                    <Cell><ProgressBar pct={c.progress.pct} /></Cell>
                    <Cell className="tabular-nums">{c.progress.docs_uploaded} / {c.progress.docs_required}</Cell>
                    <Cell muted>{c.assigned?.full_name ?? '—'}</Cell>
                    <Cell><DueChip date={c.due_date} state={c.due_state} /></Cell>
                    <Cell><span className="text-13 underline">Open</span></Cell>
                  </Row>
                ))}
              </Table>
              <div className="px-3 py-2 text-12 text-neutral-500">{d.count} case{d.count === 1 ? '' : 's'}</div>
            </>
          )}
        </QueryState>
      </Card>

      <AddClientModal open={params.get('add') === '1'} onClose={() => set('add', '')} />
    </>
  );
}

/**
 * Enrol an EXISTING Workstation client. No client is created here — the
 * picker reads the Clients module; a new client is added there first.
 */
function AddClientModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { api: regApi, keys: regKeys, caseUrl, label, kind } = useSvc();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [clientId, setClientId] = useState('');
  const [assigned, setAssigned] = useState('');
  const [reviewer, setReviewer] = useState('');
  const [approver, setApprover] = useState('');
  const [due, setDue] = useState('');
  const [entityType, setEntityType] = useState<EntityType | ''>('');
  const needsEntityType = kind === 'GST';
  const clients = useQuery({
    queryKey: ['workstation', 'clients', { for: 'registration', search }],
    queryFn: () => workstationApi.listClients({ q: search || undefined }),
    enabled: open,
  });
  const create = useMutation({
    mutationFn: () => regApi.createCase({
      client_id: clientId,
      assigned_employee_id: assigned || undefined,
      reviewer_employee_id: reviewer || undefined,
      approver_employee_id: approver || undefined,
      due_date: due || undefined,
      entity_type: needsEntityType && entityType ? entityType : undefined,
    }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: regKeys.all });
      toast.push('success', `Case ${r.case_code} opened`);
      navigate(caseUrl(r.id));
    },
    onError: (e: ApiError) => {
      const existing = (e.details as { case_id?: string } | undefined)?.case_id;
      if (e.code === 'case_exists' && existing) {
        toast.push('info', e.message);
        navigate(caseUrl(existing));
      } else toast.push('error', e.message);
    },
  });
  const errs = fieldErrors(create.error);
  const filtered = clients.data?.items ?? [];

  return (
    <Modal
      open={open}
      title={`Add Client to ${label}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!clientId || (needsEntityType && !entityType) || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Opening…' : 'Create registration case'}
          </Button>
        </>
      }
    >
      <Field label="Existing client" error={errs.client_id} hint="Clients come from Workstation → Clients. Add a new client there first.">
        <input className={inputClass + ' mb-2'} placeholder="Search clients…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className={inputClass} size={6} style={{ height: 'auto' }} value={clientId} onChange={(e) => setClientId(e.target.value)}>
          {filtered.map((c) => <option key={c.id} value={c.id}>{c.company_name} · {c.client_id}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        {needsEntityType ? (
          <Field label="Entity type" error={errs.entity_type} hint="Decides which of the six §7.1 categories apply.">
            <select className={inputClass} value={entityType} onChange={(e) => setEntityType(e.target.value as EntityType | '')}>
              <option value="">Select…</option>
              {ENTITY_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
        ) : null}
        <Field label="Assigned employee" error={errs.assigned_employee_id}><EmployeeSelect value={assigned} onChange={setAssigned} className="w-full" /></Field>
        <Field label="Reviewer" error={errs.reviewer_employee_id}><EmployeeSelect value={reviewer} onChange={setReviewer} placeholder="None" className="w-full" /></Field>
        <Field label="Manager / Approver (optional)" error={errs.approver_employee_id}><EmployeeSelect value={approver} onChange={setApprover} placeholder="None" className="w-full" /></Field>
        <Field label="Case due date" error={errs.due_date}><input type="date" className={inputClass} value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      </div>
      <p className="text-12 text-neutral-500">
        The case starts <strong>Not Started</strong> with its own copy of the master checklist. Later edits to the master do not change it.
      </p>
    </Modal>
  );
}
