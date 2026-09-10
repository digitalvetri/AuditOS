import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { incorporationApi } from '@/modules/incorporation/api';
import { workstationApi } from '@/modules/workstation/api';
import {
  Card, Cell, Detail, Field, Modal, PageHeader, QueryState, Table,
  fieldErrors, inputClass, textareaClass,
} from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import {
  DemoNote, IncStatus, ManualEntryNote, ProgressBar, RecordedBy,
  incStatusBorder, titleCase,
} from '@/modules/incorporation/components';
import { fmtDate, inr } from '@/lib/format';
import type { CaseDetailResponse, Provenance } from '@/modules/incorporation/types';

/**
 * CASE DETAIL — the workspace an employee actually lives in.
 *
 * The tab is a URL parameter so every tab is deep-linkable and Pending Items
 * can land on the exact one that needs work.
 *
 * The stage control offers ONLY `allowed_next` from the server. It does not
 * compute what is legal; it renders what the server said it would accept, so
 * a button can never promise a move that will be refused.
 */
const TABS = [
  'overview', 'parties', 'checklist', 'documents', 'dsc', 'names',
  'filing', 'queries', 'tasks', 'fees', 'timeline', 'deliverables',
] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview', parties: 'Parties', checklist: 'Checklist', documents: 'Documents',
  dsc: 'DSC', names: 'Names', filing: 'Filing', queries: 'Government Queries',
  tasks: 'Tasks', fees: 'Fees', timeline: 'Timeline', deliverables: 'Deliverables',
};

export function IncorporationCaseDetailPage() {
  const { caseId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'overview') as Tab;
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
  };

  const detail = useQuery({
    queryKey: ['incorporation', 'case', caseId],
    queryFn: () => incorporationApi.getCase(caseId),
    enabled: !!caseId,
  });

  return (
    <div>
      <QueryState query={detail}>
        {(data) => (
          <>
            <CaseHeader data={data} onBack={() => navigate('..')} />
            {data.case.is_demo ? <div className="mb-3"><DemoNote /></div> : null}

            <nav className="flex gap-1 border-b border-neutral-200 mb-4 overflow-x-auto">
              {TABS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={
                    'px-3 h-9 flex items-center text-13 whitespace-nowrap border-b-2 -mb-px ' +
                    (tab === t
                      ? 'border-gold text-neutral-900 font-medium'
                      : 'border-transparent text-neutral-500 hover:text-neutral-900')
                  }
                >
                  {TAB_LABELS[t]}
                </button>
              ))}
            </nav>

            {tab === 'overview' ? <OverviewTab data={data} /> : null}
            {tab === 'parties' ? <PartiesTab caseId={caseId} /> : null}
            {tab === 'checklist' ? <ChecklistTab caseId={caseId} /> : null}
            {tab === 'documents' ? <DocumentsTab caseId={caseId} clientId={data.case.client_id} /> : null}
            {tab === 'dsc' ? <DscTab caseId={caseId} /> : null}
            {tab === 'names' ? <NamesTab caseId={caseId} /> : null}
            {tab === 'filing' ? <FilingTab caseId={caseId} /> : null}
            {tab === 'queries' ? <QueriesTab caseId={caseId} /> : null}
            {tab === 'tasks' ? <TasksTab caseId={caseId} clientId={data.case.client_id} /> : null}
            {tab === 'fees' ? <FeesTab caseId={caseId} /> : null}
            {tab === 'timeline' ? <TimelineTab caseId={caseId} /> : null}
            {tab === 'deliverables' ? <DeliverablesTab caseId={caseId} /> : null}
          </>
        )}
      </QueryState>
    </div>
  );
}

// ── Header + stage control ────────────────────────────────────────────────
function CaseHeader({ data, onBack }: { data: CaseDetailResponse; onBack: () => void }) {
  const c = data.case;
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState('');
  const [reason, setReason] = useState('');

  // A firm-level caller may also REVERSE a stage. That is not on
  // `allowed_next` — it is an exceptional act, not ordinary progress — so the
  // control is offered separately and only to the role the server will accept
  // it from. The server refuses it regardless of what renders here.
  const settings = useQuery({ queryKey: ['incorporation', 'settings'], queryFn: incorporationApi.settings });
  const canReverse = settings.data?.can_manage_settings ?? false;
  const forwardStages = new Set(c.allowed_next.map((s) => s.stage));
  const earlier = (settings.data?.vocabularies.stages ?? [])
    .filter((s) => !forwardStages.has(s.stage) && s.stage !== c.stage
      && s.stage !== 'on_hold' && s.stage !== 'cancelled');

  const move = useMutation({
    mutationFn: () => incorporationApi.changeStage(c.id, { stage, reason: reason || undefined }),
    onSuccess: (row) => {
      void qc.invalidateQueries({ queryKey: ['incorporation'] });
      toast.push('success', `Stage moved to ${row.stage_label}.`);
      setOpen(false); setReason(''); setStage('');
    },
  });
  const errs = fieldErrors(move.error);
  const target = data.case.allowed_next.find((s) => s.stage === stage);
  const isReversal = !!stage && !forwardStages.has(stage);
  const needsReason = stage === 'cancelled' || stage === 'on_hold' || isReversal;

  return (
    <>
      <PageHeader
        title={`${c.case_code} · ${c.proposed_name}`}
        subtitle={
          <span>
            <Link to={`/workstation/clients/${c.client_id}`} className="underline hover:text-neutral-900">
              {c.client_name}
            </Link>
            {' · '}{c.entity_type_name}
            {' · '}Assigned to {c.assigned_employee?.full_name ?? 'nobody'}
            {' · '}{titleCase(c.priority)} priority
            {c.target_date ? ` · Target ${fmtDate(c.target_date)}` : ''}
          </span>
        }
        action={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onBack}>All cases</Button>
            {c.allowed_next.length > 0 ? (
              <Button onClick={() => setOpen(true)}>Advance stage</Button>
            ) : null}
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <IncStatus value={c.stage} />
        <IncStatus value={c.status} />
        {c.progress ? (
          <span className="text-12 text-neutral-500 tabular-nums">
            Checklist {c.progress.completed}/{c.progress.total} ({c.progress.percent}%)
          </span>
        ) : null}
        {c.open_queries ? (
          <span className="text-12 text-red">{c.open_queries} open government quer{c.open_queries === 1 ? 'y' : 'ies'}</span>
        ) : null}
        {c.pending_documents ? (
          <span className="text-12 text-amber">{c.pending_documents} document{c.pending_documents === 1 ? '' : 's'} outstanding</span>
        ) : null}
        {c.progress ? <div className="w-[160px]"><ProgressBar percent={c.progress.percent} /></div> : null}
      </div>

      <Modal
        open={open}
        title="Advance stage"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => move.mutate()} disabled={!stage || move.isPending}>
              {move.isPending ? 'Moving…' : 'Move stage'}
            </Button>
          </>
        }
      >
        <p className="text-13 text-neutral-500 mb-3">
          Currently <strong className="text-neutral-900 font-medium">{c.stage_label}</strong>.
          Only the moves the server will accept are listed — skipping ahead is not one of them.
        </p>
        <Field label="Move to" error={errs.stage}>
          <select className={inputClass} value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">Choose…</option>
            <optgroup label="Next">
              {c.allowed_next.map((s) => <option key={s.stage} value={s.stage}>{s.label}</option>)}
            </optgroup>
            {canReverse && earlier.length > 0 ? (
              <optgroup label="Send back (firm-level, reason required)">
                {earlier.map((s) => <option key={s.stage} value={s.stage}>{s.label}</option>)}
              </optgroup>
            ) : null}
          </select>
        </Field>
        {isReversal ? (
          <p className="text-12 text-neutral-600 -mt-2 mb-3">
            This sends the case backwards. It is recorded separately from ordinary progress,
            with your reason, on the timeline.
          </p>
        ) : null}
        <Field
          label={needsReason ? 'Reason (required)' : 'Reason'}
          error={errs.reason}
          hint={stage === 'cancelled' ? 'Cancelling a case is recorded with its reason.' : undefined}
        >
          <textarea className={textareaClass} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {target && stage === 'completed' ? (
          <p className="text-12 text-neutral-500">
            This closes the case. It can still be read, and its timeline is kept.
          </p>
        ) : null}
        {move.isError && Object.keys(errs).length === 0 ? (
          <p className="text-13 text-red mt-2">{(move.error as Error).message}</p>
        ) : null}
      </Modal>
    </>
  );
}

// ── Small shared pieces ───────────────────────────────────────────────────
function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-6 text-13 text-neutral-500">{children}</div>;
}

function TabHeader({ title, note, action }: { title: string; note?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 mb-3">
      <div className="min-w-0">
        <h2 className="text-15 font-medium text-neutral-900">{title}</h2>
        {note ? <p className="text-12 text-neutral-500 mt-1">{note}</p> : null}
      </div>
      <div className="flex-1" />
      {action}
    </div>
  );
}

/** The provenance cell — every government-sourced row gets one. */
function ProvCell({ row }: { row: Provenance }) {
  return <Cell muted><RecordedBy row={row} /></Cell>;
}

// ── Overview tab ──────────────────────────────────────────────────────────
function OverviewTab({ data }: { data: CaseDetailResponse }) {
  const c = data.case;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Case">
        <div className="px-4 py-2">
          <Detail label="Case ID" value={<span className="font-mono">{c.case_code}</span>} />
          <Detail label="Client" value={c.client_name} />
          <Detail label="Entity type" value={c.entity_type_name} />
          <Detail label="Proposed name" value={c.proposed_name} />
          <Detail label="Alternate name" value={c.alternate_name} />
          <Detail label="Business activity" value={c.business_activity} />
          <Detail label="Business category" value={c.business_category} />
          <Detail label="Location" value={[c.city, c.state].filter(Boolean).join(', ') || null} />
          <Detail label="Registered office" value={c.registered_office_info} />
          <Detail label="Objective" value={c.incorporation_objective} />
        </div>
      </Card>
      <div className="space-y-4">
        <Card title="Workflow">
          <div className="px-4 py-2">
            <Detail label="Stage" value={<IncStatus value={c.stage} />} />
            <Detail label="Status" value={<IncStatus value={c.status} />} />
            <Detail label="Assigned to" value={c.assigned_employee?.full_name} />
            <Detail label="Priority" value={titleCase(c.priority)} />
            <Detail label="Target date" value={c.target_date ? fmtDate(c.target_date) : null} />
            <Detail label="Opened" value={c.created_at ? fmtDate(c.created_at) : null} />
            <Detail label="Completed" value={c.completed_at ? fmtDate(c.completed_at) : null} />
            <Detail label="Internal notes" value={c.internal_notes} />
          </div>
        </Card>
        <Card title="Post-incorporation handover">
          <ul className="px-4 py-3 space-y-1">
            {data.handover_checklist.map((h) => (
              <li key={h} className="text-13 text-neutral-700">· {h}</li>
            ))}
          </ul>
          <div className="px-4 pb-3">
            <p className="text-12 text-neutral-500">
              Worked through on the Checklist tab. Every line is a professional judgement an
              employee records — this module never asserts that a registration is required.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── Parties tab ───────────────────────────────────────────────────────────
function PartiesTab({ caseId }: { caseId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ role: '', name: '', contact_number: '', email: '', dsc_required: true });
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  const q = useQuery({ queryKey: ['incorporation', 'parties', caseId], queryFn: () => incorporationApi.listParties(caseId) });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['incorporation'] });

  const add = useMutation({
    mutationFn: () => incorporationApi.createParty(caseId, form),
    onSuccess: () => { invalidate(); toast.push('success', 'Person added.'); setOpen(false); setForm({ role: '', name: '', contact_number: '', email: '', dsc_required: true }); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => incorporationApi.deleteParty(id),
    onSuccess: () => { invalidate(); toast.push('success', 'Person removed.'); setConfirmDelete(null); },
  });
  const errs = fieldErrors(add.error);

  return (
    <>
      <TabHeader
        title="Parties"
        note="Roles offered here are the ones this entity type uses."
        action={<Button onClick={() => { setForm((f) => ({ ...f, role: q.data?.roles[0]?.value ?? '' })); setOpen(true); }}>Add a person</Button>}
      />
      <Card>
        <QueryState query={q} empty="No people on this case yet.">
          {(data) => data.items.length === 0 ? (
            <Empty>No people on this case yet. Add the promoters, directors or partners.</Empty>
          ) : (
            <Table head={['Name', 'Role', 'Contact', 'Email', 'DSC', 'Linked contact', '']}>
              {data.items.map((p) => (
                <tr key={p.id} className="h-10 border-b border-neutral-200">
                  <Cell>{p.name}</Cell>
                  <Cell muted>{data.roles.find((r) => r.value === p.role)?.label ?? titleCase(p.role)}</Cell>
                  <Cell muted>{p.contact_number ?? '—'}</Cell>
                  <Cell muted>{p.email ?? '—'}</Cell>
                  <Cell muted>{p.dsc_required ? 'Required' : 'Not required'}</Cell>
                  <Cell muted>{p.client_contact?.name ?? '—'}</Cell>
                  <Cell>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete({ id: p.id, name: p.name })}
                      className="text-12 text-neutral-500 hover:text-red"
                    >
                      Remove
                    </button>
                  </Cell>
                </tr>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>

      <Modal
        open={open} title="Add a person" onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => add.mutate()} disabled={add.isPending}>Add</Button>
          </>
        }
      >
        <Field label="Role" error={errs.role}>
          <select className={inputClass} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="">Choose…</option>
            {(q.data?.roles ?? []).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </Field>
        <Field label="Name" error={errs.name}>
          <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Contact number" error={errs.contact_number}>
          <input className={inputClass} value={form.contact_number} onChange={(e) => setForm({ ...form, contact_number: e.target.value })} />
        </Field>
        <Field label="Email" error={errs.email}>
          <input className={inputClass} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 text-13 text-neutral-700">
          <input type="checkbox" checked={form.dsc_required} onChange={(e) => setForm({ ...form, dsc_required: e.target.checked })} />
          DSC required
        </label>
        {add.isError && Object.keys(errs).length === 0 ? (
          <p className="text-13 text-red mt-2">{(add.error as Error).message}</p>
        ) : null}
      </Modal>

      <Modal
        open={!!confirmDelete}
        title="Remove this person?"
        onClose={() => setConfirmDelete(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>Keep</Button>
            <Button onClick={() => confirmDelete && remove.mutate(confirmDelete.id)} disabled={remove.isPending}>
              Remove
            </Button>
          </>
        }
      >
        <p className="text-13 text-neutral-700">
          {confirmDelete?.name} will be removed from this case. Any DSC record already made for
          them stays in the case history.
        </p>
      </Modal>
    </>
  );
}

// ── Checklist tab ─────────────────────────────────────────────────────────
function ChecklistTab({ caseId }: { caseId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['incorporation', 'checklist', caseId], queryFn: () => incorporationApi.checklist(caseId) });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['incorporation'] });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      incorporationApi.updateChecklistItem(id, patch),
    onSuccess: invalidate,
  });
  const apply = useMutation({
    mutationFn: () => incorporationApi.applyTemplate(caseId),
    onSuccess: (r) => {
      invalidate();
      toast.push('success', r.added === 0 ? 'Checklist is already complete for this entity type.' : `${r.added} item(s) added.`);
    },
  });

  const statuses = ['pending', 'in_progress', 'completed', 'blocked', 'not_applicable'];

  return (
    <>
      <TabHeader
        title="Checklist"
        note="Instantiated from this entity type's template when the case was opened."
        action={<Button variant="secondary" onClick={() => apply.mutate()} disabled={apply.isPending}>Re-apply template</Button>}
      />
      <Card>
        <QueryState query={q}>
          {(data) => data.items.length === 0 ? (
            <Empty>This case has no checklist. Re-apply the template to lay one down.</Empty>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-neutral-200 flex items-center gap-3">
                <span className="text-12 text-neutral-500 tabular-nums">
                  {data.progress.completed}/{data.progress.total} complete
                  {data.progress.blocked > 0 ? ` · ${data.progress.blocked} blocked` : ''}
                </span>
                <div className="w-[180px]"><ProgressBar percent={data.progress.percent} /></div>
              </div>
              {Array.from(new Set(data.items.map((i) => i.category))).map((cat) => (
                <div key={cat}>
                  <div className="px-4 h-8 flex items-center bg-neutral-50 border-b border-neutral-200">
                    <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">{titleCase(cat)}</span>
                  </div>
                  {data.items.filter((i) => i.category === cat).map((i) => (
                    <div key={i.id} className={`px-4 py-2 border-b border-neutral-200 flex flex-wrap items-center gap-3 ${incStatusBorder(i.status)}`}>
                      <span className="text-13 text-neutral-900 min-w-[220px] flex-1">{i.label}</span>
                      {i.stage_label ? (
                        <span className="text-11 text-neutral-500 uppercase tracking-[0.06em]">{i.stage_label}</span>
                      ) : null}
                      {i.completed_by ? (
                        <span className="text-12 text-neutral-500">
                          {i.completed_by.full_name}{i.completed_at ? ` · ${fmtDate(i.completed_at)}` : ''}
                        </span>
                      ) : null}
                      <select
                        value={i.status}
                        onChange={(e) => update.mutate({ id: i.id, patch: { status: e.target.value } })}
                        className="h-8 px-2 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
                      >
                        {statuses.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
        </QueryState>
      </Card>
    </>
  );
}

// ── Documents tab ─────────────────────────────────────────────────────────
/**
 * Requests and their link to the file. The file itself lives in the existing
 * Documents module — there is no uploader on this tab, by design. "Link"
 * attaches a ClientDocument that is already on the client's file; the
 * dropdown only ever lists that client's own documents.
 */
function DocumentsTab({ caseId, clientId }: { caseId: string; clientId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [linking, setLinking] = useState<{ id: string; type: string } | null>(null);
  const [chosen, setChosen] = useState('');
  const [form, setForm] = useState({ category: 'identity_kyc', document_type: '', description: '', due_date: '', status: 'requested' });

  const q = useQuery({ queryKey: ['incorporation', 'documents', caseId], queryFn: () => incorporationApi.documents(caseId) });
  const settings = useQuery({ queryKey: ['incorporation', 'settings'], queryFn: incorporationApi.settings });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['incorporation'] });

  const add = useMutation({
    mutationFn: () => incorporationApi.createDocumentRequest(caseId, form),
    onSuccess: () => { invalidate(); toast.push('success', 'Document requested.'); setOpen(false); setForm({ ...form, document_type: '', description: '' }); },
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => incorporationApi.updateDocumentRequest(id, patch),
    onSuccess: invalidate,
  });
  const link = useMutation({
    mutationFn: ({ id, docId }: { id: string; docId: string | null }) => incorporationApi.linkDocument(id, docId),
    onSuccess: () => { invalidate(); toast.push('success', 'Document link updated.'); setLinking(null); setChosen(''); },
  });
  const errs = fieldErrors(add.error);

  return (
    <>
      <TabHeader
        title="Documents"
        note={<>Files live in the Documents module. This tab records what was asked for and which file answers it.{' '}
          <Link to={`/workstation/clients/${clientId}/documents`} className="underline hover:text-neutral-900">
            Open this client's documents
          </Link>.</>}
        action={<Button onClick={() => setOpen(true)}>Request a document</Button>}
      />
      <Card>
        <QueryState query={q}>
          {(data) => data.items.length === 0 ? (
            <Empty>Nothing has been requested on this case yet.</Empty>
          ) : (
            <Table head={['Document', 'Category', 'Status', 'Due', 'Linked file', 'Requested by', '']}>
              {data.items.map((d) => (
                <tr key={d.id} className={`h-10 border-b border-neutral-200 ${incStatusBorder(d.status)}`}>
                  <Cell>{d.document_type}</Cell>
                  <Cell muted>{titleCase(d.category)}</Cell>
                  <Cell>
                    <select
                      value={d.status}
                      onChange={(e) => update.mutate({ id: d.id, patch: { status: e.target.value } })}
                      className="h-7 px-1 text-12 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
                    >
                      {(settings.data?.vocabularies.document_statuses ?? []).map((s) => (
                        <option key={s} value={s}>{titleCase(s)}</option>
                      ))}
                    </select>
                  </Cell>
                  <Cell muted>{d.due_date ? fmtDate(d.due_date) : '—'}</Cell>
                  <Cell muted>{d.client_document?.name ?? '—'}</Cell>
                  <Cell muted>
                    {d.requested_by?.full_name ?? '—'}
                    {d.requested_at ? ` · ${fmtDate(d.requested_at)}` : ''}
                  </Cell>
                  <Cell>
                    {d.client_document_id ? (
                      <button type="button" onClick={() => link.mutate({ id: d.id, docId: null })}
                        className="text-12 text-neutral-500 hover:text-red">Unlink</button>
                    ) : (
                      <button type="button" onClick={() => { setLinking({ id: d.id, type: d.document_type }); setChosen(''); }}
                        className="text-12 text-neutral-700 underline hover:text-neutral-900">Link a file</button>
                    )}
                  </Cell>
                </tr>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>

      <Modal open={open} title="Request a document" onClose={() => setOpen(false)}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => add.mutate()} disabled={add.isPending}>Request</Button></>}>
        <Field label="Category" error={errs.category}>
          <select className={inputClass} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {(settings.data?.vocabularies.document_categories ?? []).map((c) => (
              <option key={c} value={c}>{titleCase(c)}</option>
            ))}
          </select>
        </Field>
        <Field label="Document" error={errs.document_type}>
          <input className={inputClass} value={form.document_type} onChange={(e) => setForm({ ...form, document_type: e.target.value })} />
        </Field>
        <Field label="Description" error={errs.description}>
          <input className={inputClass} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label="Due date" error={errs.due_date}>
          <input type="date" className={inputClass} value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
        </Field>
      </Modal>

      <Modal open={!!linking} title={`Link a file to "${linking?.type ?? ''}"`} onClose={() => setLinking(null)}
        footer={<><Button variant="secondary" onClick={() => setLinking(null)}>Cancel</Button>
          <Button onClick={() => linking && link.mutate({ id: linking.id, docId: chosen })} disabled={!chosen || link.isPending}>Link</Button></>}>
        <p className="text-13 text-neutral-500 mb-3">
          Only documents already on this client's file are listed. Upload happens in the
          Documents module, not here.
        </p>
        <Field label="Client document" error={fieldErrors(link.error).client_document_id}>
          <select className={inputClass} value={chosen} onChange={(e) => setChosen(e.target.value)}>
            <option value="">Choose…</option>
            {(q.data?.available_documents ?? []).map((d) => (
              <option key={d.id} value={d.id}>{d.name}{d.status ? ` · ${titleCase(d.status)}` : ''}</option>
            ))}
          </select>
        </Field>
      </Modal>
    </>
  );
}

// ── DSC tab ───────────────────────────────────────────────────────────────
/** Tracking only. Nothing on this tab operates a token or checks a provider. */
function DscTab({ caseId }: { caseId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ party_id: '', status: 'pending', provider: '', reference_no: '', request_date: '', received_date: '', expiry_date: '', remarks: '' });

  const q = useQuery({ queryKey: ['incorporation', 'dsc', caseId], queryFn: () => incorporationApi.dsc(caseId) });
  const settings = useQuery({ queryKey: ['incorporation', 'settings'], queryFn: incorporationApi.settings });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['incorporation'] });

  const add = useMutation({
    mutationFn: () => incorporationApi.createDsc(caseId, form),
    onSuccess: () => { invalidate(); toast.push('success', 'DSC record added.'); setOpen(false); },
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => incorporationApi.updateDsc(id, patch),
    onSuccess: () => { invalidate(); toast.push('success', 'DSC status recorded.'); },
  });
  const errs = fieldErrors(add.error);

  return (
    <>
      <TabHeader
        title="DSC"
        note="Tracking only — Audit OS performs no DSC operation of any kind."
        action={<Button onClick={() => setOpen(true)}>Add a DSC record</Button>}
      />
      <div className="mb-3"><ManualEntryNote>
        Every DSC status here was entered by an employee. <strong className="font-medium">Verified by
        employee</strong> means somebody physically checked the token — it does not mean a
        provider or portal confirmed anything.
      </ManualEntryNote></div>
      <Card>
        <QueryState query={q}>
          {(data) => data.items.length === 0 ? (
            <Empty>No DSC records yet. Add one per person who needs a certificate.</Empty>
          ) : (
            <Table head={['Person', 'Role', 'Status', 'Provider', 'Reference', 'Expiry', 'Provenance']}>
              {data.items.map((d) => (
                <tr key={d.id} className={`h-10 border-b border-neutral-200 ${incStatusBorder(d.status)}`}>
                  <Cell>{d.party_name ?? '—'}</Cell>
                  <Cell muted>{d.party_role ? titleCase(d.party_role) : '—'}</Cell>
                  <Cell>
                    <select
                      value={d.status}
                      onChange={(e) => update.mutate({ id: d.id, patch: { status: e.target.value } })}
                      className="h-7 px-1 text-12 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
                    >
                      {(settings.data?.vocabularies.dsc_statuses ?? []).map((s) => (
                        <option key={s} value={s}>{s === 'verified' ? 'Verified by employee' : titleCase(s)}</option>
                      ))}
                    </select>
                  </Cell>
                  <Cell muted>{d.provider ?? '—'}</Cell>
                  <Cell muted className="font-mono text-12">{d.reference_no ?? '—'}</Cell>
                  <Cell muted>{d.expiry_date ? fmtDate(d.expiry_date) : '—'}</Cell>
                  <ProvCell row={d} />
                </tr>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>

      <Modal open={open} title="Add a DSC record" onClose={() => setOpen(false)}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => add.mutate()} disabled={add.isPending}>Add</Button></>}>
        <Field label="Person" error={errs.party_id}>
          <select className={inputClass} value={form.party_id} onChange={(e) => setForm({ ...form, party_id: e.target.value })}>
            <option value="">Choose…</option>
            {(q.data?.parties ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name} · {titleCase(p.role)}</option>
            ))}
          </select>
        </Field>
        <Field label="Status as recorded by employee" error={errs.status}>
          <select className={inputClass} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {(settings.data?.vocabularies.dsc_statuses ?? []).map((s) => (
              <option key={s} value={s}>{s === 'verified' ? 'Verified by employee' : titleCase(s)}</option>
            ))}
          </select>
        </Field>
        <Field label="Provider" error={errs.provider} hint="As the employee recorded it.">
          <input className={inputClass} value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} />
        </Field>
        <Field label="Reference number as noted from the provider" error={errs.reference_no}>
          <input className={inputClass} value={form.reference_no} onChange={(e) => setForm({ ...form, reference_no: e.target.value })} />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
          <Field label="Requested on" error={errs.request_date}>
            <input type="date" className={inputClass} value={form.request_date} onChange={(e) => setForm({ ...form, request_date: e.target.value })} />
          </Field>
          <Field label="Expiry" error={errs.expiry_date}>
            <input type="date" className={inputClass} value={form.expiry_date} onChange={(e) => setForm({ ...form, expiry_date: e.target.value })} />
          </Field>
        </div>
        {add.isError && Object.keys(errs).length === 0 ? (
          <p className="text-13 text-red mt-2">{(add.error as Error).message}</p>
        ) : null}
      </Modal>
    </>
  );
}

// ── Names tab ─────────────────────────────────────────────────────────────
function NamesTab({ caseId }: { caseId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ proposed_name: '', priority: '', status: 'draft', submission_date: '', application_ref: '', remarks: '' });
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState({ status: '', application_ref: '', response_date: '', remarks: '' });

  const q = useQuery({ queryKey: ['incorporation', 'names', caseId], queryFn: () => incorporationApi.names(caseId) });
  const settings = useQuery({ queryKey: ['incorporation', 'settings'], queryFn: incorporationApi.settings });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['incorporation'] });

  const add = useMutation({
    mutationFn: () => incorporationApi.createName(caseId, { ...form, priority: form.priority || undefined }),
    onSuccess: () => { invalidate(); toast.push('success', 'Name option added.'); setOpen(false); setForm({ ...form, proposed_name: '', priority: '' }); },
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => incorporationApi.updateName(id, patch),
    onSuccess: () => { invalidate(); toast.push('success', 'Name status recorded.'); setEditing(null); },
  });
  const errs = fieldErrors(add.error);
  const editErrs = fieldErrors(update.error);

  return (
    <>
      <TabHeader
        title="Proposed names"
        note="Preference order is what the firm submitted. Each status is what an employee read back."
        action={<Button onClick={() => setOpen(true)}>Add a name</Button>}
      />
      <div className="mb-3"><ManualEntryNote /></div>
      <Card>
        <QueryState query={q}>
          {(data) => data.items.length === 0 ? (
            <Empty>No name options recorded yet.</Empty>
          ) : (
            <Table head={['#', 'Proposed name', 'Status', 'Submitted', 'Reference', 'Response', 'Provenance', '']}>
              {data.items.map((n) => (
                <tr key={n.id} className={`h-10 border-b border-neutral-200 ${incStatusBorder(n.status)}`}>
                  <Cell muted className="tabular-nums">{n.priority}</Cell>
                  <Cell>{n.proposed_name}</Cell>
                  <Cell><IncStatus value={n.status} /></Cell>
                  <Cell muted>{n.submission_date ? fmtDate(n.submission_date) : '—'}</Cell>
                  <Cell muted className="font-mono text-12">{n.application_ref ?? '—'}</Cell>
                  <Cell muted>{n.response_date ? fmtDate(n.response_date) : '—'}</Cell>
                  <ProvCell row={n} />
                  <Cell>
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(n.id);
                        setEdit({
                          status: n.status, application_ref: n.application_ref ?? '',
                          response_date: n.response_date ?? '', remarks: n.remarks ?? '',
                        });
                      }}
                      className="text-12 text-neutral-700 underline hover:text-neutral-900"
                    >
                      Record status
                    </button>
                  </Cell>
                </tr>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>

      <Modal open={open} title="Add a name option" onClose={() => setOpen(false)}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => add.mutate()} disabled={add.isPending}>Add</Button></>}>
        <Field label="Proposed name" error={errs.proposed_name}>
          <input className={inputClass} value={form.proposed_name} onChange={(e) => setForm({ ...form, proposed_name: e.target.value })} />
        </Field>
        <Field label="Preference" error={errs.priority} hint="Leave blank for the next free slot.">
          <input className={inputClass} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
        </Field>
        <Field label="Status as recorded by employee" error={errs.status}>
          <select className={inputClass} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {(settings.data?.vocabularies.name_statuses ?? []).map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </select>
        </Field>
        <Field label="Submitted on" error={errs.submission_date}>
          <input type="date" className={inputClass} value={form.submission_date} onChange={(e) => setForm({ ...form, submission_date: e.target.value })} />
        </Field>
        <Field label="Reference number as noted from the portal" error={errs.application_ref}>
          <input className={inputClass} value={form.application_ref} onChange={(e) => setForm({ ...form, application_ref: e.target.value })} />
        </Field>
      </Modal>

      <Modal open={!!editing} title="Record the name status" onClose={() => setEditing(null)}
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
          <Button onClick={() => editing && update.mutate({ id: editing, patch: edit })} disabled={update.isPending}>Record</Button></>}>
        <p className="text-13 text-neutral-500 mb-3">
          You are recording what you saw. Your name and today's date are stored alongside it.
        </p>
        <Field label="Status as recorded by employee" error={editErrs.status}>
          <select className={inputClass} value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
            {(settings.data?.vocabularies.name_statuses ?? []).map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </select>
        </Field>
        <Field label="Reference number as noted from the portal" error={editErrs.application_ref}>
          <input className={inputClass} value={edit.application_ref} onChange={(e) => setEdit({ ...edit, application_ref: e.target.value })} />
        </Field>
        <Field label="Response date" error={editErrs.response_date}>
          <input type="date" className={inputClass} value={edit.response_date} onChange={(e) => setEdit({ ...edit, response_date: e.target.value })} />
        </Field>
        <Field label="Remarks" error={editErrs.remarks}>
          <textarea className={textareaClass} rows={2} value={edit.remarks} onChange={(e) => setEdit({ ...edit, remarks: e.target.value })} />
        </Field>
      </Modal>
    </>
  );
}

// ── Filing tab ────────────────────────────────────────────────────────────
function FilingTab({ caseId }: { caseId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ filing_type: 'spice_plus_part_b', status: 'preparing', portal: '', application_ref: '', acknowledgement_ref: '', prepared_date: '', submitted_date: '', remarks: '' });
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState({ status: '', application_ref: '', acknowledgement_ref: '', submitted_date: '', remarks: '' });

  const q = useQuery({ queryKey: ['incorporation', 'filings', caseId], queryFn: () => incorporationApi.filings(caseId) });
  const settings = useQuery({ queryKey: ['incorporation', 'settings'], queryFn: incorporationApi.settings });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['incorporation'] });

  const add = useMutation({
    mutationFn: () => incorporationApi.createFiling(caseId, form),
    onSuccess: () => { invalidate(); toast.push('success', 'Filing recorded.'); setOpen(false); },
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => incorporationApi.updateFiling(id, patch),
    onSuccess: () => { invalidate(); toast.push('success', 'Filing updated.'); setEditing(null); },
  });
  const errs = fieldErrors(add.error);

  return (
    <>
      <TabHeader
        title="Filings"
        note="What the firm prepared and submitted, and the references an employee noted back."
        action={<Button onClick={() => setOpen(true)}>Record a filing</Button>}
      />
      <div className="mb-3"><ManualEntryNote /></div>
      <Card>
        <QueryState query={q}>
          {(data) => data.items.length === 0 ? (
            <Empty>No filings recorded on this case yet.</Empty>
          ) : (
            <Table head={['Filing', 'Status', 'Portal', 'Application ref', 'Acknowledgement', 'Submitted', 'Provenance', '']}>
              {data.items.map((fl) => (
                <tr key={fl.id} className={`h-10 border-b border-neutral-200 ${incStatusBorder(fl.status)}`}>
                  <Cell>{titleCase(fl.filing_type)}</Cell>
                  <Cell><IncStatus value={fl.status} /></Cell>
                  <Cell muted>{fl.portal ?? '—'}</Cell>
                  <Cell muted className="font-mono text-12">{fl.application_ref ?? '—'}</Cell>
                  <Cell muted className="font-mono text-12">{fl.acknowledgement_ref ?? '—'}</Cell>
                  <Cell muted>{fl.submitted_date ? fmtDate(fl.submitted_date) : '—'}</Cell>
                  <ProvCell row={fl} />
                  <Cell>
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(fl.id);
                        setEdit({
                          status: fl.status, application_ref: fl.application_ref ?? '',
                          acknowledgement_ref: fl.acknowledgement_ref ?? '',
                          submitted_date: fl.submitted_date ?? '', remarks: fl.remarks ?? '',
                        });
                      }}
                      className="text-12 text-neutral-700 underline hover:text-neutral-900"
                    >
                      Record
                    </button>
                  </Cell>
                </tr>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>

      <Modal open={open} title="Record a filing" onClose={() => setOpen(false)}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => add.mutate()} disabled={add.isPending}>Record</Button></>}>
        <Field label="Filing type" error={errs.filing_type}>
          <select className={inputClass} value={form.filing_type} onChange={(e) => setForm({ ...form, filing_type: e.target.value })}>
            {(settings.data?.vocabularies.filing_types ?? []).map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
          </select>
        </Field>
        <Field label="Status as recorded by employee" error={errs.status}>
          <select className={inputClass} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {(settings.data?.vocabularies.filing_statuses ?? []).map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </select>
        </Field>
        <Field label="Portal" error={errs.portal} hint="Named as the employee refers to it.">
          <input className={inputClass} value={form.portal} onChange={(e) => setForm({ ...form, portal: e.target.value })} />
        </Field>
        <Field label="Application reference as noted from the portal" error={errs.application_ref}>
          <input className={inputClass} value={form.application_ref} onChange={(e) => setForm({ ...form, application_ref: e.target.value })} />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
          <Field label="Prepared on" error={errs.prepared_date}>
            <input type="date" className={inputClass} value={form.prepared_date} onChange={(e) => setForm({ ...form, prepared_date: e.target.value })} />
          </Field>
          <Field label="Submitted on" error={errs.submitted_date}>
            <input type="date" className={inputClass} value={form.submitted_date} onChange={(e) => setForm({ ...form, submitted_date: e.target.value })} />
          </Field>
        </div>
      </Modal>

      <Modal open={!!editing} title="Record filing progress" onClose={() => setEditing(null)}
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
          <Button onClick={() => editing && update.mutate({ id: editing, patch: edit })} disabled={update.isPending}>Record</Button></>}>
        <Field label="Status as recorded by employee">
          <select className={inputClass} value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
            {(settings.data?.vocabularies.filing_statuses ?? []).map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </select>
        </Field>
        <Field label="Application reference as noted from the portal">
          <input className={inputClass} value={edit.application_ref} onChange={(e) => setEdit({ ...edit, application_ref: e.target.value })} />
        </Field>
        <Field label="Acknowledgement reference as noted from the portal">
          <input className={inputClass} value={edit.acknowledgement_ref} onChange={(e) => setEdit({ ...edit, acknowledgement_ref: e.target.value })} />
        </Field>
        <Field label="Submitted on">
          <input type="date" className={inputClass} value={edit.submitted_date} onChange={(e) => setEdit({ ...edit, submitted_date: e.target.value })} />
        </Field>
      </Modal>
    </>
  );
}

// ── Government queries tab ────────────────────────────────────────────────
/** Overdue rows are marked from the server's computed flag, never from a
 *  stored column that could be stale. */
function QueriesTab({ caseId }: { caseId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ query_date: '', authority: '', description: '', response_due_date: '', status: 'new', filing_id: '' });
  const [responding, setResponding] = useState<string | null>(null);
  const [resp, setResp] = useState({ status: '', response: '', response_submitted_date: '', resubmission_ref: '', resolution: '' });

  const q = useQuery({ queryKey: ['incorporation', 'queries', caseId], queryFn: () => incorporationApi.queries(caseId) });
  const settings = useQuery({ queryKey: ['incorporation', 'settings'], queryFn: incorporationApi.settings });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['incorporation'] });

  const add = useMutation({
    mutationFn: () => incorporationApi.createQuery(caseId, form),
    onSuccess: () => { invalidate(); toast.push('success', 'Query recorded.'); setOpen(false); },
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => incorporationApi.updateQuery(id, patch),
    onSuccess: () => { invalidate(); toast.push('success', 'Response recorded.'); setResponding(null); },
  });
  const errs = fieldErrors(add.error);
  const respErrs = fieldErrors(update.error);

  return (
    <>
      <TabHeader
        title="Government queries"
        note="Each query is what an employee read on the portal and typed in here."
        action={<Button onClick={() => setOpen(true)}>Record a query</Button>}
      />
      <div className="mb-3"><ManualEntryNote /></div>
      <QueryState query={q}>
        {(data) => data.items.length === 0 ? (
          <Card><Empty>No government queries on this case.</Empty></Card>
        ) : (
          <div className="space-y-3">
            {data.items.map((qr) => (
              <Card key={qr.id}>
                <div className={`px-4 py-3 ${qr.is_overdue ? 'border-l-2 border-red' : ''}`}>
                  <div className="flex flex-wrap items-center gap-3 mb-2">
                    <IncStatus value={qr.status} />
                    {qr.is_overdue ? (
                      <span className="text-12 text-red font-medium">
                        Overdue — response was due {qr.response_due_date ? fmtDate(qr.response_due_date) : ''}
                      </span>
                    ) : qr.response_due_date ? (
                      <span className="text-12 text-neutral-500">Response due {fmtDate(qr.response_due_date)}</span>
                    ) : null}
                    <span className="text-12 text-neutral-500">Query dated {fmtDate(qr.query_date)}</span>
                    {qr.authority ? <span className="text-12 text-neutral-500">· {qr.authority}</span> : null}
                    <div className="flex-1" />
                    <button
                      type="button"
                      onClick={() => {
                        setResponding(qr.id);
                        setResp({
                          status: qr.status, response: qr.response ?? '',
                          response_submitted_date: qr.response_submitted_date ?? '',
                          resubmission_ref: qr.resubmission_ref ?? '', resolution: qr.resolution ?? '',
                        });
                      }}
                      className="text-12 text-neutral-700 underline hover:text-neutral-900"
                    >
                      Record a response
                    </button>
                  </div>
                  <p className="text-13 text-neutral-900 whitespace-pre-wrap">{qr.description}</p>
                  {qr.response ? (
                    <div className="mt-3 border-l-2 border-neutral-300 pl-3">
                      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Response recorded</div>
                      <p className="text-13 text-neutral-700 whitespace-pre-wrap">{qr.response}</p>
                      {qr.resubmission_ref ? (
                        <p className="text-12 text-neutral-500 mt-1">
                          Resubmission reference <span className="font-mono">{qr.resubmission_ref}</span>
                          {qr.response_submitted_date ? ` · submitted ${fmtDate(qr.response_submitted_date)}` : ''}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {qr.resolution ? (
                    <p className="text-12 text-neutral-600 mt-2">Resolution: {qr.resolution}</p>
                  ) : null}
                  <div className="mt-2"><RecordedBy row={qr} /></div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </QueryState>

      <Modal open={open} title="Record a government query" onClose={() => setOpen(false)}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => add.mutate()} disabled={add.isPending}>Record</Button></>}>
        <Field label="Query date" error={errs.query_date}>
          <input type="date" className={inputClass} value={form.query_date} onChange={(e) => setForm({ ...form, query_date: e.target.value })} />
        </Field>
        <Field label="Authority as recorded by employee" error={errs.authority}>
          <input className={inputClass} value={form.authority} onChange={(e) => setForm({ ...form, authority: e.target.value })} />
        </Field>
        <Field label="What was asked" error={errs.description}>
          <textarea className={textareaClass} rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label="Response due" error={errs.response_due_date}>
          <input type="date" className={inputClass} value={form.response_due_date} onChange={(e) => setForm({ ...form, response_due_date: e.target.value })} />
        </Field>
        <Field label="Against which filing" error={errs.filing_id}>
          <select className={inputClass} value={form.filing_id} onChange={(e) => setForm({ ...form, filing_id: e.target.value })}>
            <option value="">Not linked</option>
            {(q.data?.filings ?? []).map((fl) => (
              <option key={fl.id} value={fl.id}>{titleCase(fl.filingType)}{fl.applicationRef ? ` · ${fl.applicationRef}` : ''}</option>
            ))}
          </select>
        </Field>
      </Modal>

      <Modal open={!!responding} title="Record a response" onClose={() => setResponding(null)}
        footer={<><Button variant="secondary" onClick={() => setResponding(null)}>Cancel</Button>
          <Button onClick={() => responding && update.mutate({ id: responding, patch: resp })} disabled={update.isPending}>Record</Button></>}>
        <Field label="Status as recorded by employee" error={respErrs.status}>
          <select className={inputClass} value={resp.status} onChange={(e) => setResp({ ...resp, status: e.target.value })}>
            {(settings.data?.vocabularies.query_statuses ?? []).map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </select>
        </Field>
        <Field label="What was sent back" error={respErrs.response}>
          <textarea className={textareaClass} rows={4} value={resp.response} onChange={(e) => setResp({ ...resp, response: e.target.value })} />
        </Field>
        <Field label="Submitted on" error={respErrs.response_submitted_date}>
          <input type="date" className={inputClass} value={resp.response_submitted_date} onChange={(e) => setResp({ ...resp, response_submitted_date: e.target.value })} />
        </Field>
        <Field label="Resubmission reference as noted from the portal" error={respErrs.resubmission_ref}>
          <input className={inputClass} value={resp.resubmission_ref} onChange={(e) => setResp({ ...resp, resubmission_ref: e.target.value })} />
        </Field>
        <Field label="Resolution" error={respErrs.resolution} hint="Required before a query can be marked resolved.">
          <textarea className={textareaClass} rows={2} value={resp.resolution} onChange={(e) => setResp({ ...resp, resolution: e.target.value })} />
        </Field>
      </Modal>
    </>
  );
}

// ── Tasks tab ─────────────────────────────────────────────────────────────
/**
 * Rows in the PLATFORM Task table. Anything created here shows up in the
 * client's Tasks tab in Workstation too — one task engine, one place a task
 * can be found.
 */
function TasksTab({ caseId, clientId }: { caseId: string; clientId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ template: '', title: '', description: '', due_date: '', assigned_employee_id: '' });

  const q = useQuery({ queryKey: ['incorporation', 'case-tasks', caseId], queryFn: () => incorporationApi.caseTasks(caseId) });
  const employees = useQuery({ queryKey: ['workstation', 'assignable-employees'], queryFn: workstationApi.assignableEmployees });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['incorporation'] });
    // The client's Tasks tab reads the same rows — keep it honest.
    void qc.invalidateQueries({ queryKey: ['workstation', 'client', clientId, 'tasks'] });
  };

  const add = useMutation({
    mutationFn: () => incorporationApi.createTask(caseId, {
      ...(form.template ? { template: form.template } : {}),
      ...(form.title ? { title: form.title } : {}),
      ...(form.description ? { description: form.description } : {}),
      ...(form.due_date ? { due_date: form.due_date } : {}),
      ...(form.assigned_employee_id ? { assigned_employee_id: form.assigned_employee_id } : {}),
    }),
    onSuccess: () => { invalidate(); toast.push('success', 'Task created.'); setOpen(false); setForm({ template: '', title: '', description: '', due_date: '', assigned_employee_id: '' }); },
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => incorporationApi.updateTask(id, patch),
    onSuccess: invalidate,
  });
  const errs = fieldErrors(add.error);

  return (
    <>
      <TabHeader
        title="Tasks"
        note={<>Created in the platform's own task system, so they also appear under{' '}
          <Link to={`/workstation/clients/${clientId}/tasks`} className="underline hover:text-neutral-900">
            this client's Tasks
          </Link>.</>}
        action={<Button onClick={() => setOpen(true)}>New task</Button>}
      />
      <Card>
        <QueryState query={q}>
          {(data) => (
            <>
              <div className="px-4 py-3 border-b border-neutral-200 flex flex-wrap gap-2">
                <span className="text-11 uppercase tracking-[0.06em] text-neutral-500 self-center mr-1">One-click</span>
                {data.templates.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => incorporationApi.createTask(caseId, { template: t.key })
                      .then(() => { invalidate(); toast.push('success', `Task created: ${t.title}`); })
                      .catch((e: Error) => toast.push('error', e.message))}
                    className="h-7 px-2 text-12 border border-neutral-300 rounded bg-white text-neutral-700 hover:border-neutral-400"
                  >
                    {t.title}
                  </button>
                ))}
              </div>
              {data.items.length === 0 ? (
                <Empty>No tasks on this case yet.</Empty>
              ) : (
                <Table head={['Task', 'Status', 'Assigned', 'Due', '']}>
                  {data.items.map((t) => (
                    <tr key={t.id} className={`h-10 border-b border-neutral-200 ${incStatusBorder(t.status)}`}>
                      <Cell>{t.title}</Cell>
                      <Cell>
                        <select
                          value={t.status}
                          onChange={(e) => update.mutate({ id: t.id, patch: { status: e.target.value } })}
                          className="h-7 px-1 text-12 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
                        >
                          {['open', 'in_progress', 'blocked', 'done'].map((s) => (
                            <option key={s} value={s}>{titleCase(s)}</option>
                          ))}
                        </select>
                      </Cell>
                      <Cell muted>{t.assigned_employee?.full_name ?? '—'}</Cell>
                      <Cell muted>{t.due_date ? fmtDate(t.due_date) : '—'}</Cell>
                      <Cell muted className="text-12">{t.description ?? ''}</Cell>
                    </tr>
                  ))}
                </Table>
              )}
            </>
          )}
        </QueryState>
      </Card>

      <Modal open={open} title="New task" onClose={() => setOpen(false)}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => add.mutate()} disabled={add.isPending}>Create</Button></>}>
        <Field label="Template" error={errs.template} hint="Optional — fills the title and a due date.">
          <select className={inputClass} value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })}>
            <option value="">No template</option>
            {(q.data?.templates ?? []).map((t) => <option key={t.key} value={t.key}>{t.title}</option>)}
          </select>
        </Field>
        <Field label="Title" error={errs.title}>
          <input className={inputClass} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <Field label="Description" error={errs.description}>
          <textarea className={textareaClass} rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label="Assigned to" error={errs.assigned_employee_id}>
          <select className={inputClass} value={form.assigned_employee_id} onChange={(e) => setForm({ ...form, assigned_employee_id: e.target.value })}>
            <option value="">Case owner</option>
            {(employees.data?.items ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
          </select>
        </Field>
        <Field label="Due date" error={errs.due_date}>
          <input type="date" className={inputClass} value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
        </Field>
      </Modal>
    </>
  );
}

// ── Fees tab ──────────────────────────────────────────────────────────────
function FeesTab({ caseId }: { caseId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ category: 'professional_fee', description: '', amount: '', status: 'pending', due_date: '', invoice_ref: '', client_service_id: '' });

  const q = useQuery({ queryKey: ['incorporation', 'fees', caseId], queryFn: () => incorporationApi.fees(caseId) });
  const settings = useQuery({ queryKey: ['incorporation', 'settings'], queryFn: incorporationApi.settings });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['incorporation'] });

  const add = useMutation({
    mutationFn: () => incorporationApi.createFee(caseId, form),
    onSuccess: () => { invalidate(); toast.push('success', 'Fee recorded.'); setOpen(false); setForm({ ...form, description: '', amount: '' }); },
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => incorporationApi.updateFee(id, patch),
    onSuccess: invalidate,
  });
  const errs = fieldErrors(add.error);

  return (
    <>
      <TabHeader
        title="Fees"
        note="What the firm charges for this case. Client accounting stays in Books — this never posts to a client ledger."
        action={<Button onClick={() => setOpen(true)}>Record a fee</Button>}
      />
      <Card>
        <QueryState query={q}>
          {(data) => (
            <>
              <div className="px-4 py-3 border-b border-neutral-200 flex flex-wrap gap-6">
                <div>
                  <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Billed</div>
                  <div className="text-15 text-neutral-900 tabular-nums">{inr(data.totals.billed_paise)}</div>
                </div>
                <div>
                  <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Received</div>
                  <div className="text-15 text-neutral-900 tabular-nums">{inr(data.totals.received_paise)}</div>
                </div>
                <div>
                  <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Outstanding</div>
                  <div className="text-15 text-neutral-900 tabular-nums">{inr(data.totals.outstanding_paise)}</div>
                </div>
              </div>
              {data.items.length === 0 ? (
                <Empty>No fees recorded on this case yet.</Empty>
              ) : (
                <Table head={['Category', 'Description', 'Amount', 'Status', 'Invoice ref', 'Due', 'Recorded by']}>
                  {data.items.map((fe) => (
                    <tr key={fe.id} className={`h-10 border-b border-neutral-200 ${incStatusBorder(fe.status)}`}>
                      <Cell>{titleCase(fe.category)}</Cell>
                      <Cell muted>{fe.description ?? '—'}</Cell>
                      <Cell className="tabular-nums">{inr(fe.amount_paise)}</Cell>
                      <Cell>
                        <select
                          value={fe.status}
                          onChange={(e) => update.mutate({ id: fe.id, patch: { status: e.target.value } })}
                          className="h-7 px-1 text-12 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
                        >
                          {(settings.data?.vocabularies.fee_statuses ?? []).map((s) => (
                            <option key={s} value={s}>{titleCase(s)}</option>
                          ))}
                        </select>
                      </Cell>
                      <Cell muted className="font-mono text-12">{fe.invoice_ref ?? '—'}</Cell>
                      <Cell muted>{fe.due_date ? fmtDate(fe.due_date) : '—'}</Cell>
                      <Cell muted>{fe.recorded_by?.full_name ?? '—'}</Cell>
                    </tr>
                  ))}
                </Table>
              )}
            </>
          )}
        </QueryState>
      </Card>

      <Modal open={open} title="Record a fee" onClose={() => setOpen(false)}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => add.mutate()} disabled={add.isPending}>Record</Button></>}>
        <Field label="Category" error={errs.category}>
          <select className={inputClass} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {(settings.data?.vocabularies.fee_categories ?? []).map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
          </select>
        </Field>
        <Field label="Description" error={errs.description}>
          <input className={inputClass} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label="Amount (₹)" error={errs.amount}>
          <input className={inputClass} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </Field>
        <Field label="Status" error={errs.status}>
          <select className={inputClass} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {(settings.data?.vocabularies.fee_statuses ?? []).map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </select>
        </Field>
        <Field label="Billed under" error={errs.client_service_id} hint="Optional — an existing service on this client.">
          <select className={inputClass} value={form.client_service_id} onChange={(e) => setForm({ ...form, client_service_id: e.target.value })}>
            <option value="">Not linked</option>
            {(q.data?.client_services ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Invoice reference" error={errs.invoice_ref}>
          <input className={inputClass} value={form.invoice_ref} onChange={(e) => setForm({ ...form, invoice_ref: e.target.value })} />
        </Field>
        <Field label="Due date" error={errs.due_date}>
          <input type="date" className={inputClass} value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
        </Field>
      </Modal>
    </>
  );
}

// ── Deliverables tab ──────────────────────────────────────────────────────
function DeliverablesTab({ caseId }: { caseId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'certificate_of_incorporation', status: 'pending', reference_no: '', client_document_id: '', prepared_date: '', notes: '' });

  const q = useQuery({ queryKey: ['incorporation', 'deliverables', caseId], queryFn: () => incorporationApi.deliverables(caseId) });
  const settings = useQuery({ queryKey: ['incorporation', 'settings'], queryFn: incorporationApi.settings });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['incorporation'] });

  const add = useMutation({
    mutationFn: () => incorporationApi.createDeliverable(caseId, form),
    onSuccess: () => { invalidate(); toast.push('success', 'Deliverable added.'); setOpen(false); setForm({ ...form, name: '', reference_no: '', client_document_id: '' }); },
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => incorporationApi.updateDeliverable(id, patch),
    onSuccess: invalidate,
  });
  const errs = fieldErrors(add.error);

  return (
    <>
      <TabHeader
        title="Deliverables"
        note="Certificates and other outputs, each linked to the file held in the Documents module."
        action={<Button onClick={() => setOpen(true)}>Add a deliverable</Button>}
      />
      <div className="mb-3"><ManualEntryNote /></div>
      <Card>
        <QueryState query={q}>
          {(data) => data.items.length === 0 ? (
            <Empty>No deliverables recorded yet.</Empty>
          ) : (
            <Table head={['Deliverable', 'Type', 'Status', 'Reference', 'Linked file', 'Delivered', 'Provenance']}>
              {data.items.map((d) => (
                <tr key={d.id} className={`h-10 border-b border-neutral-200 ${incStatusBorder(d.status)}`}>
                  <Cell>{d.name}</Cell>
                  <Cell muted>{titleCase(d.type)}</Cell>
                  <Cell>
                    <select
                      value={d.status}
                      onChange={(e) => update.mutate({ id: d.id, patch: { status: e.target.value } })}
                      className="h-7 px-1 text-12 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
                    >
                      {(settings.data?.vocabularies.deliverable_statuses ?? []).map((s) => (
                        <option key={s} value={s}>{titleCase(s)}</option>
                      ))}
                    </select>
                  </Cell>
                  <Cell muted className="font-mono text-12">{d.reference_no ?? '—'}</Cell>
                  <Cell muted>{d.client_document?.name ?? '—'}</Cell>
                  <Cell muted>{d.delivered_date ? fmtDate(d.delivered_date) : '—'}</Cell>
                  <ProvCell row={d} />
                </tr>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>

      <Modal open={open} title="Add a deliverable" onClose={() => setOpen(false)}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => add.mutate()} disabled={add.isPending}>Add</Button></>}>
        <Field label="Type" error={errs.type}>
          <select className={inputClass} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {(settings.data?.vocabularies.deliverable_types ?? []).map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
          </select>
        </Field>
        <Field label="Name" error={errs.name}>
          <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Reference number as noted from the certificate" error={errs.reference_no}>
          <input className={inputClass} value={form.reference_no} onChange={(e) => setForm({ ...form, reference_no: e.target.value })} />
        </Field>
        <Field label="Linked document" error={errs.client_document_id}
          hint="A file already on this client's record. Upload happens in the Documents module.">
          <select className={inputClass} value={form.client_document_id} onChange={(e) => setForm({ ...form, client_document_id: e.target.value })}>
            <option value="">Not linked</option>
            {(q.data?.available_documents ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Prepared on" error={errs.prepared_date}>
          <input type="date" className={inputClass} value={form.prepared_date} onChange={(e) => setForm({ ...form, prepared_date: e.target.value })} />
        </Field>
        <Field label="Notes" error={errs.notes}>
          <textarea className={textareaClass} rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
      </Modal>
    </>
  );
}

// ── Timeline tab ──────────────────────────────────────────────────────────
/** The case's own trail, newest first. AuditLog remains the compliance record. */
function TimelineTab({ caseId }: { caseId: string }) {
  const q = useQuery({ queryKey: ['incorporation', 'timeline', caseId], queryFn: () => incorporationApi.timeline(caseId) });
  return (
    <>
      <TabHeader title="Timeline" note="Everything that happened on this case, newest first." />
      <Card>
        <QueryState query={q} empty="Nothing has happened on this case yet.">
          {(data) => (
            <ol className="px-4 py-2">
              {data.items.map((e) => (
                <li key={e.id} className="py-2 border-b border-neutral-200 last:border-b-0">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-13 text-neutral-900">{e.detail ?? e.action}</span>
                    <span className="text-12 text-neutral-500">
                      {e.actor_name ?? 'System'}
                      {e.created_at ? ` · ${fmtDate(e.created_at)}` : ''}
                    </span>
                  </div>
                  <div className="text-11 text-neutral-400 font-mono mt-0.5">{e.action}</div>
                </li>
              ))}
            </ol>
          )}
        </QueryState>
      </Card>
    </>
  );
}
