import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, ChevronRight, FolderPlus, Trash2 } from 'lucide-react';
import {
  Card, Field, Modal, QueryState, Status, inputClass, textareaClass,
} from '@/modules/workstation/components';
import { workstationApi } from '@/modules/workstation/api';
import { Button } from '@/components/Button';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';
import {
  checklistApi, FREQUENCIES, FREQUENCY_LABEL, STORED_STATUSES,
  type ChecklistItem, type Frequency, type ItemPatch, type MasterService, type StoredStatus,
} from './api';

/**
 * THE CLIENT GST CHECKLIST — Workstation → Clients → [Client] → GST.
 *
 * What this screen is for, in order: what GST work does this client require,
 * what is its status, who is handling it, when is it due. Everything on it is
 * one client's own rows; the master catalogue is only ever READ here, through
 * the pickers, and the one place it is written is the explicit
 * "also add to GST Master Services" tick in the custom-item form.
 *
 * `kind` is fixed to 'gst' — the API and tables are already general, so a TDS
 * checklist later is this component with a different kind.
 */
export function GstChecklist({ clientId, clientName }: { clientId: string; clientName: string }) {
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'workstation.gst.manage', 'self');
  const qc = useQueryClient();

  const listQ = useQuery({
    queryKey: ['checklist', 'gst', clientId],
    queryFn: () => checklistApi.list(clientId),
  });
  const catalogQ = useQuery({ queryKey: ['checklist', 'gst', 'catalog'], queryFn: () => checklistApi.catalog() });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['checklist', 'gst', clientId] });
    qc.invalidateQueries({ queryKey: ['checklist', 'gst', 'catalog'] });
  };

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [category, setCategory] = useState('all');
  const [assignee, setAssignee] = useState('all');

  const [initializing, setInitializing] = useState(false);
  const [addingService, setAddingService] = useState(false);
  const [addingCustom, setAddingCustom] = useState(false);
  const [addingCategory, setAddingCategory] = useState(false);
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onError = (e: unknown) => setError((e as { message?: string })?.message ?? 'That could not be saved.');

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: ItemPatch }) => checklistApi.update(clientId, id, body),
    onSuccess: () => { setError(null); refresh(); },
    onError,
  });

  return (
    <QueryState query={listQ}>
      {(data) => {
        const items = data.items;
        const assignees = dedupe(items.map((i) => i.assigned_to).filter(Boolean) as { id: string; full_name: string }[]);
        const categories = dedupe(
          items.filter((i) => i.category_name).map((i) => ({ id: i.category_id ?? '', full_name: i.category_name ?? '' })),
        );

        const filtered = items.filter((i) => {
          const q = query.trim().toLowerCase();
          if (q && !`${i.name} ${i.code ?? ''} ${i.category_name ?? ''}`.toLowerCase().includes(q)) return false;
          if (status !== 'all' && i.status !== status) return false;
          if (category !== 'all' && i.category_id !== category) return false;
          if (assignee !== 'all' && (i.assigned_to?.id ?? 'none') !== assignee) return false;
          return true;
        });

        if (items.length === 0) {
          return (
            <>
              <Card title="GST checklist">
                <div className="px-4 py-8 text-center">
                  <p className="text-13 text-neutral-500">
                    {clientName} does not have a GST checklist configured yet.
                  </p>
                  {canManage ? (
                    <div className="mt-4">
                      <Button onClick={() => setInitializing(true)}>Initialize GST checklist</Button>
                    </div>
                  ) : null}
                </div>
              </Card>
              <InitializeModal
                open={initializing}
                onClose={() => setInitializing(false)}
                clientId={clientId}
                services={catalogQ.data?.services ?? []}
                onDone={refresh}
              />
            </>
          );
        }

        return (
          <div className="space-y-4">
            <Dashboard summary={data.summary} />

            {error ? <div className="border-l-2 border-red pl-3 text-13 text-neutral-900">{error}</div> : null}

            {/* Toolbar — search, three filters, the three add actions. */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search this checklist…"
                  className="w-full h-8 pl-9 pr-3 text-13 bg-white border border-neutral-300 rounded focus:outline-none focus:border-gold"
                />
              </div>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded">
                <option value="all">All statuses</option>
                {['not_started', 'in_progress', 'pending', 'completed', 'overdue', 'not_required'].map((s) => (
                  <option key={s} value={s}>{label(s)}</option>
                ))}
              </select>
              <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded">
                <option value="all">All categories</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
              </select>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded">
                <option value="all">All employees</option>
                <option value="none">Unassigned</option>
                {assignees.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
              </select>
              {canManage ? (
                <>
                  <button type="button" onClick={() => setAddingService(true)} className={toolbarBtn}>
                    <Plus size={14} /> Add service
                  </button>
                  <button type="button" onClick={() => setAddingCustom(true)} className={toolbarBtn}>
                    <Plus size={14} /> Custom item
                  </button>
                  <button type="button" onClick={() => setAddingCategory(true)} className={toolbarBtn}>
                    <FolderPlus size={14} /> Category
                  </button>
                </>
              ) : null}
            </div>

            <Card>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] border-collapse">
                  <thead>
                    <tr className="border-b border-neutral-200">
                      {['', 'Service', 'Category', 'Frequency', 'Assigned to', 'Due date', 'Status', ''].map((h, i) => (
                        <th key={i} className="h-9 px-3 text-11 uppercase tracking-[0.06em] font-medium text-neutral-500 text-left whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr><td colSpan={8} className="px-3 py-8 text-center text-13 text-neutral-500">Nothing matches those filters.</td></tr>
                    ) : filtered.map((i) => (
                      <tr key={i.id} className="border-b border-neutral-200 hover:bg-neutral-50">
                        <td className="px-3 py-2 w-8">
                          {/* §10 — ticking it completes the item and stamps the
                              server clock; unticking returns it to in progress
                              so a status can then be chosen. */}
                          <input
                            type="checkbox"
                            checked={i.stored_status === 'completed'}
                            disabled={!canManage || patch.isPending}
                            onChange={(e) => patch.mutate({
                              id: i.id,
                              body: { status: e.target.checked ? 'completed' : 'in_progress' },
                            })}
                            className="h-4 w-4 align-middle"
                          />
                        </td>
                        <td className="px-3 py-2 text-13 text-neutral-900">
                          <button type="button" onClick={() => setOpenItem(i.id)} className="text-left hover:text-gold">
                            {i.name}
                          </button>
                          {i.code ? <span className="text-neutral-500"> · {i.code}</span> : null}
                          {i.is_custom ? <span className="ml-2 text-11 text-neutral-500">custom</span> : null}
                        </td>
                        <td className="px-3 py-2 text-13 text-neutral-500">{i.category_name ?? '—'}</td>
                        <td className="px-3 py-2 text-13 text-neutral-500">{FREQUENCY_LABEL[i.frequency] ?? i.frequency}</td>
                        <td className="px-3 py-2 text-13 text-neutral-500">{i.assigned_to?.full_name ?? '—'}</td>
                        <td className="px-3 py-2 text-13 text-neutral-500 whitespace-nowrap">{i.due_date ? fmtDate(i.due_date) : '—'}</td>
                        <td className="px-3 py-2"><Status value={i.status} /></td>
                        <td className="px-3 py-2 text-right">
                          <button type="button" onClick={() => setOpenItem(i.id)} className="text-neutral-400 hover:text-neutral-900">
                            <ChevronRight size={16} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <p className="text-11 text-neutral-500">
              This checklist belongs to {clientName} alone. The master catalogue it draws on lives at
              Workstation → Services → GST and is never changed by anything on this screen.
            </p>

            <InitializeModal
              open={initializing}
              onClose={() => setInitializing(false)}
              clientId={clientId}
              services={catalogQ.data?.services ?? []}
              onDone={refresh}
            />
            <AddServiceModal
              open={addingService}
              onClose={() => setAddingService(false)}
              clientId={clientId}
              services={catalogQ.data?.services ?? []}
              already={new Set(items.map((i) => i.service_id).filter(Boolean) as string[])}
              onDone={refresh}
            />
            <CustomItemModal
              open={addingCustom}
              onClose={() => setAddingCustom(false)}
              clientId={clientId}
              categories={catalogQ.data?.categories ?? []}
              onDone={refresh}
            />
            <AddCategoryModal open={addingCategory} onClose={() => setAddingCategory(false)} onDone={refresh} />
            {openItem ? (
              <ItemDetailModal
                clientId={clientId}
                clientName={clientName}
                itemId={openItem}
                canManage={canManage}
                categories={catalogQ.data?.categories ?? []}
                onClose={() => setOpenItem(null)}
                onDone={refresh}
              />
            ) : null}
          </div>
        );
      }}
    </QueryState>
  );
}

const toolbarBtn =
  'h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50';

function label(s: string) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function dedupe<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Map<string, T>();
  rows.forEach((r) => { if (r.id && !seen.has(r.id)) seen.set(r.id, r); });
  return [...seen.values()];
}

// ── Dashboard (§14) ───────────────────────────────────────────────────────

function Dashboard({ summary }: { summary: import('./api').ChecklistSummary }) {
  const cells: [string, number][] = [
    ['Total', summary.total],
    ['Completed', summary.completed],
    ['In progress', summary.in_progress],
    ['Pending', summary.pending],
    ['Overdue', summary.overdue],
    ['Not started', summary.not_started],
  ];
  return (
    <Card title="GST compliance">
      <div className="p-4">
        <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
          {cells.map(([k, v]) => (
            <div key={k}>
              <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{k}</div>
              <div className="text-20 font-semibold text-neutral-900 tabular-nums">{v}</div>
            </div>
          ))}
        </div>
        <div className="mt-4">
          <div className="flex items-baseline justify-between text-13">
            <span className="text-neutral-500">
              Progress · {summary.completed} of {summary.applicable} applicable
              {summary.not_required > 0 ? ` (${summary.not_required} not required)` : ''}
            </span>
            <span className="font-medium text-neutral-900 tabular-nums">{summary.progress_percent}%</span>
          </div>
          <div className="mt-1 h-2 rounded bg-neutral-200 overflow-hidden">
            <div className="h-full bg-gold" style={{ width: `${summary.progress_percent}%` }} />
          </div>
        </div>
      </div>
    </Card>
  );
}

// ── §4 Initialize ─────────────────────────────────────────────────────────

/** Services a new client usually needs — a starting point, not a rule. */
const COMMON = new Set(['registration', 'return-filing', 'annual-return', 'amendment', 'lut-filing']);

function InitializeModal({ open, onClose, clientId, services, onDone }: {
  open: boolean; onClose: () => void; clientId: string; services: MasterService[]; onDone: () => void;
}) {
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const chosen = picked ?? new Set(services.filter((s) => s.slug && COMMON.has(s.slug)).map((s) => s.id));
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () => checklistApi.initialize(clientId, [...chosen]),
    onSuccess: () => { setPicked(null); onClose(); onDone(); },
    onError: (e: unknown) => setError((e as { message?: string })?.message ?? 'That could not be saved.'),
  });

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  };

  return (
    <Modal
      open={open}
      title="Initialize GST checklist"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={toolbarBtn}>Cancel</button>
          <Button onClick={() => run.mutate()} disabled={chosen.size === 0 || run.isPending}>
            Add selected services
          </Button>
        </>
      }
    >
      <p className="text-13 text-neutral-500 mb-3">
        Tick the GST services this client actually needs. Only what you tick is added —
        nothing is forced onto a client, and you can add more at any time.
      </p>
      {error ? <div className="border-l-2 border-red pl-3 text-13 mb-3">{error}</div> : null}
      <ul className="max-h-[320px] overflow-y-auto">
        {services.map((s) => (
          <li key={s.id} className="py-1.5 border-b border-neutral-200 last:border-0">
            <label className="flex items-start gap-2 text-13 cursor-pointer">
              <input type="checkbox" checked={chosen.has(s.id)} onChange={() => toggle(s.id)} className="mt-0.5 h-4 w-4" />
              <span>
                <span className="text-neutral-900">{s.name}</span>
                {s.code ? <span className="text-neutral-500"> · {s.code}</span> : null}
                <span className="block text-11 text-neutral-500">{FREQUENCY_LABEL[s.default_frequency] ?? s.default_frequency}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

// ── §5 Add a master service ───────────────────────────────────────────────

function AddServiceModal({ open, onClose, clientId, services, already, onDone }: {
  open: boolean; onClose: () => void; clientId: string; services: MasterService[];
  already: Set<string>; onDone: () => void;
}) {
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: (service_id: string) => checklistApi.addItem(clientId, { service_id }),
    onSuccess: () => { onClose(); onDone(); },
    onError: (e: unknown) => setError((e as { message?: string })?.message ?? 'That could not be added.'),
  });

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return services.filter((s) => !needle || `${s.name} ${s.code ?? ''}`.toLowerCase().includes(needle));
  }, [services, q]);

  return (
    <Modal open={open} title="Add GST service" onClose={onClose}
      footer={<button type="button" onClick={onClose} className={toolbarBtn}>Close</button>}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search GST services…"
        className={inputClass}
      />
      {error ? <div className="border-l-2 border-red pl-3 text-13 mt-3">{error}</div> : null}
      <ul className="mt-3 max-h-[320px] overflow-y-auto">
        {shown.map((s) => {
          const have = already.has(s.id);
          return (
            <li key={s.id} className="flex items-center gap-3 py-2 border-b border-neutral-200 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="text-13 text-neutral-900">
                  {s.name}{s.code ? <span className="text-neutral-500"> · {s.code}</span> : null}
                </div>
                <div className="text-11 text-neutral-500">{FREQUENCY_LABEL[s.default_frequency] ?? s.default_frequency}</div>
              </div>
              <button
                type="button"
                disabled={have || add.isPending}
                onClick={() => add.mutate(s.id)}
                className={`${toolbarBtn} disabled:opacity-40`}
              >
                {have ? 'On checklist' : 'Add'}
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

// ── §6 Custom item ────────────────────────────────────────────────────────

function CustomItemModal({ open, onClose, clientId, categories, onDone }: {
  open: boolean; onClose: () => void; clientId: string;
  categories: { id: string; name: string }[]; onDone: () => void;
}) {
  const [form, setForm] = useState({
    name: '', category_id: '', description: '', frequency: 'one-time' as Frequency,
    due_date: '', assigned_to_id: '', notes: '', add_to_master: false,
  });
  const [error, setError] = useState<string | null>(null);
  const employeesQ = useQuery({
    queryKey: ['checklist', 'assignable'],
    queryFn: () => workstationApi.assignableEmployees(),
    enabled: open,
  });

  const save = useMutation({
    mutationFn: () => checklistApi.addItem(clientId, {
      name: form.name,
      category_id: form.category_id || null,
      description: form.description || null,
      frequency: form.frequency,
      due_date: form.due_date || null,
      assigned_to_id: form.assigned_to_id || null,
      notes: form.notes || null,
      add_to_master: form.add_to_master,
    }),
    onSuccess: () => {
      setForm({ name: '', category_id: '', description: '', frequency: 'one-time', due_date: '', assigned_to_id: '', notes: '', add_to_master: false });
      onClose(); onDone();
    },
    onError: (e: unknown) => setError((e as { message?: string })?.message ?? 'That could not be saved.'),
  });

  return (
    <Modal open={open} title="Add custom checklist item" onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={toolbarBtn}>Cancel</button>
          <Button onClick={() => save.mutate()} disabled={!form.name.trim() || save.isPending}>Save</Button>
        </>
      }>
      {error ? <div className="border-l-2 border-red pl-3 text-13 mb-3">{error}</div> : null}
      <Field label="Service name">
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Category">
        <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })} className={inputClass}>
          <option value="">Select a category…</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Description">
        <textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={textareaClass} />
      </Field>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
        <Field label="Frequency">
          <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as Frequency })} className={inputClass}>
            {FREQUENCIES.map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
          </select>
        </Field>
        <Field label="Due date">
          <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} className={inputClass} />
        </Field>
      </div>
      <Field label="Assigned to">
        <select value={form.assigned_to_id} onChange={(e) => setForm({ ...form, assigned_to_id: e.target.value })} className={inputClass}>
          <option value="">Unassigned</option>
          {(employeesQ.data?.items ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
        </select>
      </Field>
      <Field label="Notes">
        <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={textareaClass} />
      </Field>
      <label className="flex items-start gap-2 text-13 mt-2 cursor-pointer">
        <input
          type="checkbox"
          checked={form.add_to_master}
          onChange={(e) => setForm({ ...form, add_to_master: e.target.checked })}
          className="mt-0.5 h-4 w-4"
        />
        <span>
          Also add this service to GST master services
          <span className="block text-11 text-neutral-500">
            Leave this unticked and the item exists for this client only — the global catalogue is untouched.
          </span>
        </span>
      </label>
    </Modal>
  );
}

// ── §8 Add a category ─────────────────────────────────────────────────────

function AddCategoryModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => checklistApi.addCategory(name.trim(), description.trim() || null),
    onSuccess: () => { setName(''); setDescription(''); onClose(); onDone(); },
    onError: (e: unknown) => setError((e as { message?: string })?.message ?? 'That could not be saved.'),
  });
  return (
    <Modal open={open} title="Add GST category" onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={toolbarBtn}>Cancel</button>
          <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending}>Save</Button>
        </>
      }>
      {error ? <div className="border-l-2 border-red pl-3 text-13 mb-3">{error}</div> : null}
      <p className="text-13 text-neutral-500 mb-3">
        Categories are shared across clients — this one becomes available to every GST checklist item from now on.
      </p>
      <Field label="Category name">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      </Field>
      <Field label="Description">
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={textareaClass} />
      </Field>
    </Modal>
  );
}

// ── §11 Item detail ───────────────────────────────────────────────────────

function ItemDetailModal({ clientId, clientName, itemId, canManage, categories, onClose, onDone }: {
  clientId: string; clientName: string; itemId: string; canManage: boolean;
  categories: { id: string; name: string }[]; onClose: () => void; onDone: () => void;
}) {
  const q = useQuery({
    queryKey: ['checklist', 'gst', clientId, itemId],
    queryFn: () => checklistApi.get(clientId, itemId),
  });
  const employeesQ = useQuery({ queryKey: ['checklist', 'assignable'], queryFn: () => workstationApi.assignableEmployees() });
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ItemPatch | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => checklistApi.update(clientId, itemId, draft ?? {}),
    onSuccess: () => {
      setDraft(null);
      qc.invalidateQueries({ queryKey: ['checklist', 'gst', clientId, itemId] });
      onDone();
      onClose();
    },
    onError: (e: unknown) => setError((e as { message?: string })?.message ?? 'That could not be saved.'),
  });

  const remove = useMutation({
    mutationFn: () => checklistApi.remove(clientId, itemId),
    onSuccess: () => { onDone(); onClose(); },
    onError: (e: unknown) => setError((e as { message?: string })?.message ?? 'That could not be removed.'),
  });

  const field = <K extends keyof ItemPatch>(item: ChecklistItem, key: K): ItemPatch[K] => {
    if (draft && key in draft) return draft[key];
    const fallback: Record<string, unknown> = {
      status: item.stored_status,
      assigned_to_id: item.assigned_to?.id ?? '',
      due_date: item.due_date ?? '',
      frequency: item.frequency,
      notes: item.notes ?? '',
      description: item.description ?? '',
      category_id: item.category_id ?? '',
    };
    return fallback[key as string] as ItemPatch[K];
  };
  const set = (p: ItemPatch) => setDraft({ ...(draft ?? {}), ...p });

  return (
    <Modal
      open
      title={q.data?.name ?? 'Checklist item'}
      onClose={onClose}
      footer={
        <>
          {canManage ? (
            <button type="button" onClick={() => remove.mutate()} disabled={remove.isPending}
              className={`${toolbarBtn} text-red`}>
              <Trash2 size={14} /> Remove
            </button>
          ) : null}
          <div className="flex-1" />
          <button type="button" onClick={onClose} className={toolbarBtn}>Close</button>
          {canManage ? (
            <Button onClick={() => save.mutate()} disabled={!draft || save.isPending}>Save</Button>
          ) : null}
        </>
      }
    >
      <QueryState query={q}>
        {(item) => (
          <div>
            {error ? <div className="border-l-2 border-red pl-3 text-13 mb-3">{error}</div> : null}
            <div className="text-13 text-neutral-500 mb-3">
              {clientName}
              {item.code ? ` · ${item.code}` : ''}
              {item.is_custom ? ' · custom item' : ''}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
              <Field label="Status">
                <select
                  disabled={!canManage}
                  value={String(field(item, 'status') ?? item.stored_status)}
                  onChange={(e) => set({ status: e.target.value as StoredStatus })}
                  className={inputClass}
                >
                  {STORED_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
                </select>
              </Field>
              <Field label="Assigned to">
                <select
                  disabled={!canManage}
                  value={String(field(item, 'assigned_to_id') ?? '')}
                  onChange={(e) => set({ assigned_to_id: e.target.value || null })}
                  className={inputClass}
                >
                  <option value="">Unassigned</option>
                  {(employeesQ.data?.items ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
                </select>
              </Field>
              <Field label="Due date">
                <input
                  type="date"
                  disabled={!canManage}
                  value={String(field(item, 'due_date') ?? '')}
                  onChange={(e) => set({ due_date: e.target.value || null })}
                  className={inputClass}
                />
              </Field>
              <Field label="Frequency">
                <select
                  disabled={!canManage}
                  value={String(field(item, 'frequency') ?? item.frequency)}
                  onChange={(e) => set({ frequency: e.target.value as Frequency })}
                  className={inputClass}
                >
                  {FREQUENCIES.map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
                </select>
              </Field>
              <Field label="Category">
                <select
                  disabled={!canManage}
                  value={String(field(item, 'category_id') ?? '')}
                  onChange={(e) => set({ category_id: e.target.value || null })}
                  className={inputClass}
                >
                  <option value="">No category</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <Field label="Completed">
                <div className="text-13 text-neutral-500 h-9 flex items-center">
                  {item.completed_at ? fmtDateTime(item.completed_at) : '—'}
                </div>
              </Field>
            </div>

            <Field label="Notes">
              <textarea
                rows={3}
                disabled={!canManage}
                value={String(field(item, 'notes') ?? '')}
                onChange={(e) => set({ notes: e.target.value })}
                className={textareaClass}
              />
            </Field>

            <div className="mt-4 pt-3 border-t border-neutral-200">
              <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">Activity</div>
              <ul className="space-y-1">
                {item.activity.length === 0 ? (
                  <li className="text-13 text-neutral-500">Nothing yet.</li>
                ) : item.activity.map((a) => (
                  <li key={a.id} className="text-13 text-neutral-500">
                    <span className="text-neutral-900">{label(a.action)}</span>
                    {a.detail ? ` — ${a.detail}` : ''}
                    {a.actor_name ? ` · ${a.actor_name}` : ''} · {fmtDateTime(a.at)}
                  </li>
                ))}
              </ul>
            </div>

            <p className="text-11 text-neutral-500 mt-4">
              Documents for this work live on the client's Documents tab — this item records the obligation,
              not the file store.
            </p>
          </div>
        )}
      </QueryState>
    </Modal>
  );
}
