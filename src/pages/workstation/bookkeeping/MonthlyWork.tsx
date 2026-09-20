import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { bookkeepingApi } from '@/modules/bookkeeping/api';
import { human, opts } from '@/modules/bookkeeping/format';
import type {
  Deliverable, DocumentRequest, Import, ImportKind, PendingItem, ReportKind,
  ReportView as ReportViewT, Task, WorkflowStage,
} from '@/modules/bookkeeping/types';
import {
  Card, Cell, FilterBar, PageHeader, QueryState, Row, Select, Status, Table,
} from '@/modules/workstation/components';
import { fmtDate } from '@/lib/format';

type PeriodSection = 'checklist' | 'data' | 'reports' | 'deliverables';

/** Every monthly period the caller can see (§11). */
export function BookkeepingMonthlyWorkPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const status = params.get('status') ?? '';

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };

  const periods = useQuery({
    queryKey: ['bookkeeping', 'periods', { status }],
    queryFn: () => bookkeepingApi.listPeriods({ status }),
  });
  const settings = useQuery({ queryKey: ['bookkeeping', 'settings'], queryFn: bookkeepingApi.settings });

  return (
    <div>
      <PageHeader title="Monthly Work" subtitle="One row per client, per month." />
      <FilterBar>
        <Select
          label="Status" value={status} onChange={(v) => setParam('status', v)}
          options={opts(settings.data?.period_statuses)}
        />
      </FilterBar>
      <Card>
        <QueryState query={periods}>
          {(data) => data.items.length === 0 ? (
            <div className="px-4 py-6 text-13 text-neutral-500">No periods match these filters.</div>
          ) : (
            <Table head={['Client', 'Period', 'Status', 'Progress', 'Due', 'Assigned to']}>
              {data.items.map((p) => (
                <Row key={p.id} status={p.status} onClick={() => navigate(p.id)}>
                  <Cell>{p.client_name ?? '—'}</Cell>
                  <Cell>{p.label}</Cell>
                  <Cell><Status value={p.status} /></Cell>
                  <Cell muted>
                    {p.progress ? `${p.progress.completed}/${p.progress.total} · ${p.progress.percent}%` : '—'}
                  </Cell>
                  <Cell muted>{p.due_date ? fmtDate(p.due_date) : '—'}</Cell>
                  <Cell muted>{p.assigned_employee?.full_name ?? '—'}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>
    </div>
  );
}

/**
 * One month of work. Tasks are grouped by workflow stage — the same rows
 * that used to be a separate checklist, a separate workflow panel and a
 * separate task table are now ONE list with THREE renderings. Ticking a
 * checkbox is the same write as changing the status dropdown; both call
 * PATCH /bookkeeping/tasks/:id and land on the same record.
 */
export function BookkeepingPeriodDetailPage() {
  const { periodId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const section = ((params.get('section') as PeriodSection | null) ?? 'checklist') as PeriodSection;
  const setSection = (v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set('section', v); else next.delete('section');
    setParams(next, { replace: true });
  };

  const detail = useQuery({
    queryKey: ['bookkeeping', 'period', periodId],
    queryFn: () => bookkeepingApi.period(periodId),
  });
  const settings = useQuery({ queryKey: ['bookkeeping', 'settings'], queryFn: bookkeepingApi.settings });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['bookkeeping', 'period', periodId] });
    void qc.invalidateQueries({ queryKey: ['bookkeeping', 'overview'] });
  };

  const setPeriodStatus = useMutation({
    mutationFn: (status: string) => bookkeepingApi.updatePeriod(periodId, { status }),
    onSuccess: invalidate,
  });
  const setTaskStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      bookkeepingApi.updateTask(id, { status }),
    onSuccess: invalidate,
  });

  return (
    <QueryState query={detail}>
      {(data) => {
        const stageTasks = data.tasks.filter((t) => t.stage);
        const adhocTasks = data.tasks.filter((t) => !t.stage);
        const stages: WorkflowStage[] = data.workflow_stages ?? [];
        return (
          <div className="space-y-4">
            <PageHeader
              title={`${data.period.client_name ?? 'Client'} · ${data.period.label}`}
              subtitle={
                <span>
                  {data.period.period_start && data.period.period_end
                    ? `${fmtDate(data.period.period_start)} – ${fmtDate(data.period.period_end)} · `
                    : ''}
                  {data.period.progress
                    ? `${data.period.progress.completed} of ${data.period.progress.total} tasks done · ${data.period.progress.percent}%`
                    : 'No tasks yet'}
                  {data.period.due_date ? ` · due ${fmtDate(data.period.due_date)}` : ''}
                </span>
              }
              action={
                <div className="flex items-center gap-2">
                  <Select
                    label="" value={data.period.status}
                    onChange={(v) => v && setPeriodStatus.mutate(v)}
                    options={opts(settings.data?.period_statuses)}
                    allLabel="Set status…"
                  />
                  {data.period.client_id ? (
                    <button
                      onClick={() => navigate(`../clients/${data.period.client_id}`)}
                      className="h-8 px-3 text-13 border border-neutral-300 rounded hover:bg-neutral-50"
                    >
                      Client
                    </button>
                  ) : null}
                </div>
              }
            />

            {data.period.progress ? (
              <div className="h-1.5 bg-neutral-200 rounded overflow-hidden">
                <div className="h-full bg-gold" style={{ width: `${data.period.progress.percent}%` }} />
              </div>
            ) : null}

            {/* Sub-tabs: Checklist | Data | Deliverables. `?section=` in the
                URL rather than `?tab=` because the periods LIST view already
                uses `?status=` — namespacing keeps a bookmarked link
                unambiguous. */}
            <nav className="flex gap-1 border-b border-neutral-200 -mt-2">
              {(['checklist', 'data', 'reports', 'deliverables'] as const).map((s) => (
                <button
                  key={s} onClick={() => setSection(s === 'checklist' ? '' : s)}
                  className={
                    'px-3 h-9 text-13 whitespace-nowrap border-b-2 -mb-px ' +
                    (section === s
                      ? 'border-gold text-neutral-900 font-medium'
                      : 'border-transparent text-neutral-500 hover:text-neutral-900')
                  }
                >
                  {human(s)}
                </button>
              ))}
            </nav>

            {section === 'checklist' ? (
              <ChecklistSection
                stages={stages}
                stageTasks={stageTasks}
                adhocTasks={adhocTasks}
                taskStatuses={settings.data?.task_statuses ?? []}
                onTaskStatus={(id, next) => setTaskStatus.mutate({ id, status: next })}
                onOpenSection={setSection}
              />
            ) : null}

            {section === 'data' ? (
              <DataSection
                periodId={data.period.id}
                clientName={data.period.client_name ?? ''}
                periodStart={data.period.period_start}
                periodEnd={data.period.period_end}
                periodLabel={data.period.label}
                imports={data.imports}
                pending={data.pending_items}
                documents={data.document_requests}
                onImported={invalidate}
              />
            ) : null}

            {section === 'reports' ? (
              <ReportsSection periodId={data.period.id} onOpenData={() => setSection('data')} />
            ) : null}

            {section === 'deliverables' ? (
              <DeliverablesSection deliverables={data.deliverables} />
            ) : null}
          </div>
        );
      }}
    </QueryState>
  );
}

function ChecklistSection(props: {
  stages: WorkflowStage[];
  stageTasks: Task[];
  adhocTasks: Task[];
  taskStatuses: string[];
  onTaskStatus: (id: string, status: string) => void;
  onOpenSection: (section: string) => void;
}) {
  const { stages, stageTasks, adhocTasks, taskStatuses, onTaskStatus, onOpenSection } = props;
  return (
    <>
      <Card title="Workflow">
        {stages.length === 0 ? (
          <div className="px-4 py-6 text-13 text-neutral-500">
            No workflow stages configured for this service.
          </div>
        ) : (
          <ul className="divide-y divide-neutral-200">
            {stages.map((s) => {
              const inStage = stageTasks.filter((t) => t.stage?.id === s.id);
              const done = inStage.filter((t) => t.status === 'completed').length;
              return (
                <StageGroup
                  key={s.id}
                  stage={s}
                  tasks={inStage}
                  doneCount={done}
                  taskStatuses={taskStatuses}
                  onToggle={(task, checked) =>
                    onTaskStatus(task.id, checked ? 'completed' : 'pending')
                  }
                  onStatus={(task, next) => onTaskStatus(task.id, next)}
                  onOpenSection={onOpenSection}
                />
              );
            })}
          </ul>
        )}
      </Card>

      {adhocTasks.length > 0 ? (
        <Card title="Ad-hoc tasks">
          <Table head={['Task', 'Category', 'Priority', 'Assigned to', 'Due', 'Status']}>
            {adhocTasks.map((t) => (
              <Row key={t.id} status={t.status}>
                <Cell>{t.title}</Cell>
                <Cell muted>{human(t.category)}</Cell>
                <Cell muted>{human(t.priority)}</Cell>
                <Cell muted>{t.assigned_employee?.full_name ?? '—'}</Cell>
                <Cell muted>{t.due_date ? fmtDate(t.due_date) : '—'}</Cell>
                <Cell>
                  <select
                    value={t.status}
                    onChange={(e) => onTaskStatus(t.id, e.target.value)}
                    className="h-7 px-1 text-12 bg-white border border-neutral-300 rounded"
                  >
                    {taskStatuses.map((s) => (
                      <option key={s} value={s}>{human(s)}</option>
                    ))}
                  </select>
                </Cell>
              </Row>
            ))}
          </Table>
        </Card>
      ) : null}
    </>
  );
}

/**
 * Data sub-tab (spec §6.4). Four rows — trial balance, day book,
 * outstandings, bank statement — plus the pending items and document
 * requests that used to live in their own retired tabs.
 *
 * Each row shows the LATEST import of that kind on this period. A rejected
 * import renders with the reason inline, so a reviewer sees WHY a file was
 * refused before deciding to re-upload. Every upload is append-only — a
 * new import row for the same kind never overwrites the previous one.
 */
const IMPORT_KINDS_DISPLAY: { kind: ImportKind; label: string }[] = [
  { kind: 'bank_statement', label: 'Bank statement' },
  { kind: 'day_book', label: 'Day book' },
  { kind: 'trial_balance', label: 'Trial balance' },
  { kind: 'outstandings', label: 'Outstandings' },
];

function DataSection(props: {
  periodId: string;
  clientName: string;
  periodStart: string | null;
  periodEnd: string | null;
  periodLabel: string;
  imports: Import[];
  pending: PendingItem[];
  documents: DocumentRequest[];
  onImported: () => void;
}) {
  const {
    periodId, clientName, periodStart, periodEnd, periodLabel,
    imports, pending, documents, onImported,
  } = props;
  const [uploadFor, setUploadFor] = useState<ImportKind | null>(null);
  // Pick the latest import per kind for the header row; the "history"
  // list below shows all imports (rejected included) in append order.
  const latestByKind = new Map<ImportKind, Import>();
  for (const i of imports) {
    if (!latestByKind.has(i.kind)) latestByKind.set(i.kind, i);
  }
  return (
    <div className="space-y-4">
      <Card title="Imports">
        <Table head={['Kind', 'Source', 'Period in file', 'Rows', 'Imported', '']}>
          {IMPORT_KINDS_DISPLAY.map(({ kind, label }) => {
            const latest = latestByKind.get(kind);
            const rejected = latest && latest.status !== 'imported';
            return (
              <Row key={kind} status={rejected ? 'blocked' : latest ? 'ok' : undefined}>
                <Cell>{label}</Cell>
                <Cell muted>{latest ? human(latest.source) : '—'}</Cell>
                <Cell muted>
                  {latest ? `${latest.period_from_in_file} – ${latest.period_to_in_file}` : '—'}
                </Cell>
                <Cell muted>{latest?.row_count ?? '—'}</Cell>
                <Cell muted>
                  {latest ? (
                    <span>
                      {latest.imported_at ? fmtDate(latest.imported_at) : '—'}
                      {latest.imported_by?.full_name
                        ? ` · ${latest.imported_by.full_name}`
                        : ''}
                    </span>
                  ) : (
                    <span className="text-neutral-400">not imported</span>
                  )}
                </Cell>
                <Cell>
                  <button
                    onClick={() => setUploadFor(kind)}
                    className="h-7 px-2 text-12 border border-neutral-300 rounded hover:bg-neutral-50"
                  >
                    {latest ? 'Re-import' : 'Import file'}
                  </button>
                </Cell>
              </Row>
            );
          })}
        </Table>
        {imports.some((i) => i.status !== 'imported') ? (
          <ul className="px-4 py-2 border-t border-neutral-100 space-y-1">
            {imports.filter((i) => i.status !== 'imported').map((i) => (
              <li key={i.id} className="text-12 text-red-700">
                <span className="tabular-nums">{i.imported_at ? fmtDate(i.imported_at) : ''}</span>
                {' · '}
                <span className="font-medium">{human(i.kind)}</span>
                {' — '}{i.error_detail ?? human(i.status)}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Pending items">
          {pending.length === 0 ? (
            <div className="px-4 py-6 text-13 text-neutral-500">Nothing outstanding.</div>
          ) : (
            <ul className="divide-y divide-neutral-200">
              {pending.map((p) => (
                <li key={p.id} className="px-4 py-2 flex items-center gap-2">
                  <span className="text-13 flex-1">{p.title}</span>
                  <Status value={p.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Document requests">
          {documents.length === 0 ? (
            <div className="px-4 py-6 text-13 text-neutral-500">No documents chased yet.</div>
          ) : (
            <ul className="divide-y divide-neutral-200">
              {documents.map((d) => (
                <li key={d.id} className="px-4 py-2 flex items-center gap-2">
                  <span className="text-13 flex-1">{human(d.document_type)}</span>
                  <Status value={d.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {uploadFor ? (
        <ImportUploadModal
          kind={uploadFor}
          periodId={periodId}
          clientName={clientName}
          periodStart={periodStart}
          periodEnd={periodEnd}
          periodLabel={periodLabel}
          onClose={() => setUploadFor(null)}
          onImported={() => { setUploadFor(null); onImported(); }}
        />
      ) : null}
    </div>
  );
}

function ImportUploadModal(props: {
  kind: ImportKind;
  periodId: string;
  clientName: string;
  periodStart: string | null;
  periodEnd: string | null;
  periodLabel: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const {
    kind, periodId, clientName, periodStart, periodEnd, periodLabel,
    onClose, onImported,
  } = props;
  const kindLabel = IMPORT_KINDS_DISPLAY.find((k) => k.kind === kind)?.label ?? human(kind);
  const [file, setFile] = useState<File | null>(null);
  // Pre-fill the two validation fields with what we expect the file to say
  // so a matching Tally export can be uploaded in one click; the user is
  // still required to confirm they typed what the FILE actually contains.
  const [company, setCompany] = useState(clientName);
  const [pFrom, setPFrom] = useState(periodStart ?? '');
  const [pTo, setPTo] = useState(periodEnd ?? '');

  const upload = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('Choose a file first.');
      return bookkeepingApi.createImport({
        file, period_id: periodId, kind,
        company_name_in_file: company,
        period_from_in_file: pFrom,
        period_to_in_file: pTo,
      });
    },
    onSuccess: onImported,
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-40">
      <div className="bg-white rounded shadow-xl w-full max-w-lg mx-4">
        <div className="px-4 py-3 border-b border-neutral-200 flex items-center justify-between">
          <div>
            <div className="text-13 font-medium">Import {kindLabel}</div>
            <div className="text-11 text-neutral-500">{periodLabel}</div>
          </div>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-900 text-15" aria-label="Close">×</button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <label className="block">
            <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">
              File
            </span>
            <input
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-13"
            />
          </label>
          <label className="block">
            <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">
              Company name in file
            </span>
            <input
              type="text" value={company} onChange={(e) => setCompany(e.target.value)}
              className="w-full h-8 px-2 text-13 border border-neutral-300 rounded"
            />
            <span className="block text-11 text-neutral-500 mt-1">
              Must match the client record exactly ({clientName}).
            </span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">
                Period from (in file)
              </span>
              <input
                type="date" value={pFrom} onChange={(e) => setPFrom(e.target.value)}
                className="w-full h-8 px-2 text-13 border border-neutral-300 rounded"
              />
            </label>
            <label className="block">
              <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">
                Period to (in file)
              </span>
              <input
                type="date" value={pTo} onChange={(e) => setPTo(e.target.value)}
                className="w-full h-8 px-2 text-13 border border-neutral-300 rounded"
              />
            </label>
          </div>
          {upload.error ? (
            <div className="text-12 text-red-700">
              {String((upload.error as { message?: string })?.message ?? upload.error)}
            </div>
          ) : null}
        </div>
        <div className="px-4 py-3 border-t border-neutral-200 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="h-8 px-3 text-13 border border-neutral-300 rounded hover:bg-neutral-50"
          >
            Cancel
          </button>
          <button
            onClick={() => upload.mutate()}
            disabled={upload.isPending || !file}
            className="h-8 px-3 text-13 bg-primary text-white rounded hover:bg-primaryHover disabled:opacity-50"
          >
            {upload.isPending ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Reports sub-tab (spec §6.5). All five reports are DERIVED at read time
 * from the latest imported trial balance for this period; no report is
 * stored separately. When no trial balance is imported yet every report
 * renders the verbatim empty-state message from spec §6.5.
 */
const REPORT_KINDS: { key: ReportKind; label: string }[] = [
  { key: 'trial_balance', label: 'Trial Balance' },
  { key: 'profit_and_loss', label: 'Profit & Loss' },
  { key: 'balance_sheet', label: 'Balance Sheet' },
  { key: 'debtors', label: 'Debtors' },
  { key: 'creditors', label: 'Creditors' },
];

function ReportsSection(props: { periodId: string; onOpenData: () => void }) {
  const [kind, setKind] = useState<ReportKind>('trial_balance');
  const reports = useQuery({
    queryKey: ['bookkeeping', 'reports', props.periodId],
    queryFn: () => bookkeepingApi.reports(props.periodId),
  });
  return (
    <div className="space-y-3">
      <nav className="flex gap-1 border-b border-neutral-200">
        {REPORT_KINDS.map((r) => (
          <button
            key={r.key} onClick={() => setKind(r.key)}
            className={
              'px-3 h-9 text-13 whitespace-nowrap border-b-2 -mb-px ' +
              (kind === r.key
                ? 'border-gold text-neutral-900 font-medium'
                : 'border-transparent text-neutral-500 hover:text-neutral-900')
            }
          >
            {r.label}
          </button>
        ))}
      </nav>
      <QueryState query={reports}>
        {(data) => {
          const entry = data.reports[kind];
          if (!entry.available) {
            return (
              <Card>
                <div className="px-4 py-8 text-center">
                  <div className="text-13 text-neutral-700">{entry.message}</div>
                  <button
                    onClick={props.onOpenData}
                    className="mt-2 text-12 text-gold hover:underline"
                  >
                    Open the Data tab to import →
                  </button>
                </div>
              </Card>
            );
          }
          return <ReportView entry={entry} />;
        }}
      </QueryState>
    </div>
  );
}

function ReportView({ entry }: { entry: ReportViewT }) {
  return (
    <Card>
      <div className="px-4 py-2 text-11 text-neutral-500 border-b border-neutral-100">
        As of {entry.as_of_period_end ?? '—'}
        {entry.imported_by ? ` · imported by ${entry.imported_by}` : ''}
      </div>
      {entry.sections.map((s) => (
        <div key={s.label} className="border-b border-neutral-100 last:border-b-0">
          <div className="px-4 py-2 flex items-center justify-between bg-neutral-50">
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 font-medium">
              {s.label}
            </div>
            <div className="text-12 text-neutral-700 tabular-nums">
              {formatRupees(s.total_paise)}
            </div>
          </div>
          {s.lines.length === 0 ? (
            <div className="px-4 py-3 text-12 text-neutral-400 italic">No ledgers.</div>
          ) : (
            <Table head={['Ledger', 'Group', 'Opening', 'Debit', 'Credit', 'Closing']}>
              {s.lines.map((line) => (
                <Row key={`${line.ledger_name}-${line.parent_group}`}>
                  <Cell>{line.ledger_name}</Cell>
                  <Cell muted>{line.parent_group}</Cell>
                  <Cell muted className="tabular-nums">{formatRupees(line.opening)}</Cell>
                  <Cell muted className="tabular-nums">{formatRupees(line.debit)}</Cell>
                  <Cell muted className="tabular-nums">{formatRupees(line.credit)}</Cell>
                  <Cell className="tabular-nums">{formatRupees(line.closing)}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </div>
      ))}
      {Object.keys(entry.totals).length > 0 ? (
        <div className="px-4 py-2 flex flex-wrap gap-4 text-12 border-t border-neutral-100 bg-neutral-50">
          {Object.entries(entry.totals).map(([k, v]) => (
            <span key={k}>
              <span className="text-neutral-500 uppercase tracking-[0.06em] mr-1">
                {human(k)}
              </span>
              <span className="tabular-nums text-neutral-900">{formatRupees(v)}</span>
            </span>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Display "1500.00" → "₹1,500.00" (Indian grouping). Cheap, no dep — but
 * this is the only place `Number()` is allowed on an amount, and only for
 * formatting the DISPLAY string. The wire is already paise-derived
 * decimal, so no precision moves.
 */
function formatRupees(rupeesDecimal: string): string {
  const negative = rupeesDecimal.startsWith('-');
  const abs = negative ? rupeesDecimal.slice(1) : rupeesDecimal;
  const [rupees, paise = '00'] = abs.split('.');
  const withCommas = rupees.length <= 3
    ? rupees
    : rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + rupees.slice(-3);
  const zero = rupees === '0' && paise === '00';
  if (zero) return '—';
  return `${negative ? '-' : ''}₹${withCommas}.${paise}`;
}

function DeliverablesSection(props: { deliverables: Deliverable[] }) {
  return (
    <Card title="Deliverables">
      {props.deliverables.length === 0 ? (
        <div className="px-4 py-6 text-13 text-neutral-500">None prepared yet.</div>
      ) : (
        <Table head={['Type', 'Prepared by', 'Reviewed by', 'Approved', 'Delivered', 'Status']}>
          {props.deliverables.map((d) => (
            <Row key={d.id} status={d.status}>
              <Cell>{human(d.type)}</Cell>
              <Cell muted>{d.prepared_by?.full_name ?? '—'}</Cell>
              <Cell muted>{d.reviewed_by?.full_name ?? '—'}</Cell>
              <Cell muted>{d.approved_at ? fmtDate(d.approved_at) : '—'}</Cell>
              <Cell muted>{d.delivered_at ? fmtDate(d.delivered_at) : '—'}</Cell>
              <Cell><Status value={d.status} /></Cell>
            </Row>
          ))}
        </Table>
      )}
    </Card>
  );
}

/**
 * One stage on the monthly workflow. Renders both the "checklist" (a
 * checkbox per task) and the "workflow panel" (a stage heading with per-stage
 * counts) at the same time — they are literally the same data.
 */
function StageGroup(props: {
  stage: WorkflowStage;
  tasks: Task[];
  doneCount: number;
  taskStatuses: string[];
  onToggle: (task: Task, checked: boolean) => void;
  onStatus: (task: Task, status: string) => void;
  onOpenSection: (section: string) => void;
}) {
  const { stage, tasks, doneCount, taskStatuses, onToggle, onStatus, onOpenSection } = props;
  const total = tasks.length;
  return (
    <li className="px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-11 tracking-wider uppercase text-neutral-500 font-medium">
          {stage.name}
        </div>
        <div className="text-11 text-neutral-500 tabular-nums">
          {doneCount} of {total}
        </div>
      </div>
      {total === 0 ? (
        <div className="text-13 text-neutral-400 italic">No task on this stage.</div>
      ) : (
        <ul className="space-y-1">
          {tasks.map((t) => {
            // A task is "gated" (blocked, UI-disabled) only when the rule
            // is enforced. When enforcement is off the reason still surfaces
            // — spec §7 requires the reason NEVER be hidden — but the
            // control stays live because the API will allow the write.
            const gated = t.gate && t.gate.is_enforced && !t.gate.passed && t.status !== 'completed';
            const showReason = t.gate && !t.gate.passed && t.status !== 'completed';
            return (
              <li key={t.id} className="space-y-1">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={t.status === 'completed'}
                    disabled={gated ?? false}
                    onChange={(e) => onToggle(t, e.target.checked)}
                    className="accent-neutral-900 disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label={t.title}
                    title={gated && t.gate ? t.gate.reason ?? '' : undefined}
                  />
                  <span className={
                    'text-13 flex-1 ' +
                    (t.status === 'completed'
                      ? 'text-neutral-400 line-through'
                      : gated ? 'text-neutral-500' : 'text-neutral-900')
                  }>
                    {t.title}
                  </span>
                  {t.assigned_employee?.full_name ? (
                    <span className="text-12 text-neutral-500">{t.assigned_employee.full_name}</span>
                  ) : null}
                  {t.due_date ? (
                    <span className="text-12 text-neutral-500 tabular-nums">{fmtDate(t.due_date)}</span>
                  ) : null}
                  <select
                    value={t.status}
                    disabled={gated ?? false}
                    onChange={(e) => onStatus(t, e.target.value)}
                    className="h-7 px-1 text-12 bg-white border border-neutral-300 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {taskStatuses.map((s) => (
                      <option key={s} value={s}>{human(s)}</option>
                    ))}
                  </select>
                </div>
                {showReason && t.gate ? (
                  <div className="pl-7 flex items-center gap-2 text-11">
                    <span className={gated ? 'text-red-700' : 'text-amber-700'}>
                      {gated ? '▍' : '⚠'} {t.gate.reason}
                      {!t.gate.is_enforced ? ' (enforcement off)' : ''}
                    </span>
                    {t.gate.action ? (
                      <button
                        onClick={() => t.gate?.action && onOpenSection(t.gate.action.section)}
                        className="text-gold hover:underline"
                      >
                        {t.gate.action.label} →
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
