/**
 * /workstation/engagement/service-master — the firm's standard services and,
 * for each, its scope of work as individual activities (scope, deliverables,
 * client responsibilities, exclusions, notes). Engagement letters start from
 * these (Engagement letter → Add services).
 *
 * Everyone who can read engagement letters can read it; a partner edits it.
 * A change applies to letters written afterwards — a letter keeps its words.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { useToast } from '@/components/Toast';
import { confirmAction } from '@/components/ConfirmDialog';
import { inputClass, QueryState } from '@/modules/workstation/components';
import { ListHeader } from '@/modules/workstation/listUi';
import { workstationApi } from '@/modules/workstation/api';
import {
  FREQUENCIES, KINDS, KIND_LABEL, serviceMasterApi, type ItemKind, type MasterInput, type MasterService,
} from '@/modules/workstation/serviceMaster/api';

const btn = 'h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded-lg border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 disabled:opacity-50';
const btnPrimary = 'h-8 px-4 inline-flex items-center gap-1.5 text-13 font-medium rounded-lg bg-primary text-white hover:bg-primaryHover disabled:opacity-50';
const iconBtn = 'h-7 w-7 inline-flex items-center justify-center rounded border border-neutral-200 bg-white hover:bg-neutral-50 text-neutral-500 disabled:opacity-40';

const blank = (): MasterInput => ({ category: '', name: '', billing_frequency: 'Monthly', service_code: null, is_active: true, sort_order: 0, items: [] });
const toInput = (s: MasterService): MasterInput => ({
  category: s.category, name: s.name, billing_frequency: s.billing_frequency, service_code: s.service_code,
  is_active: s.is_active, sort_order: s.sort_order,
  items: s.items.map((i) => ({ kind: i.kind, content: i.content, default_selected: i.default_selected })),
});

export default function ServiceMasterPage() {
  const { session } = useAuth();
  const canEdit = can(session?.role.code, 'workstation.engagement.manage', 'organisation');
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['service-master', true], queryFn: () => serviceMasterApi.list(true) });
  const [selected, setSelected] = useState<string | 'new' | null>(null);

  const services = q.data ?? [];
  useEffect(() => { if (!selected && services.length) setSelected(services[0].id); }, [selected, services]);
  const groups = useMemo(() => {
    const m = new Map<string, MasterService[]>();
    for (const s of services) m.set(s.category, [...(m.get(s.category) ?? []), s]);
    return [...m.entries()];
  }, [services]);
  const current = selected === 'new' ? null : services.find((s) => s.id === selected) ?? null;

  const done = (msg: string, id?: string | null) => {
    void qc.invalidateQueries({ queryKey: ['service-master'] });
    toast.push('success', msg);
    if (id !== undefined) setSelected(id);
  };
  const fail = (e: unknown) => toast.push('error', (e as { message?: string })?.message ?? 'That could not be saved.');
  const save = useMutation({
    mutationFn: (b: MasterInput) => (current ? serviceMasterApi.update(current.id, b) : serviceMasterApi.create(b)),
    onSuccess: (s) => done('Saved', s.id),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => serviceMasterApi.remove(id),
    onSuccess: () => done('Service removed', null),
    onError: fail,
  });

  return (
    <div className="max-w-[1400px]">
      <Link to="/workstation/engagement" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-800 mb-2">
        <ArrowLeft size={14} /> Engagement letters
      </Link>
      <ListHeader
        title="Service master"
        meta={<>The firm&apos;s standard services and their scope of work, one activity per line. A new engagement letter starts from these: pick the services, untick what is not in the client&apos;s package, add the fee and timelines.{canEdit ? '' : ' Only a partner can change it.'}</>}
      />
      <QueryState query={q}>
        {() => (
          <div className="grid grid-cols-1 md:grid-cols-[300px_1fr] gap-4 items-start">
            <aside className="dash-card p-3 space-y-3">
              {canEdit ? <button type="button" className={`${btn} w-full justify-center`} onClick={() => setSelected('new')}><Plus size={14} /> Add a service</button> : null}
              {groups.map(([cat, list]) => (
                <div key={cat}>
                  <div className="text-11 font-semibold uppercase tracking-wide text-neutral-500 mb-1">{cat}</div>
                  <ul>
                    {list.map((s) => (
                      <li key={s.id}>
                        <button type="button" onClick={() => setSelected(s.id)}
                          className={`w-full text-left rounded px-2 py-1.5 ${selected === s.id ? 'bg-primary/5' : 'hover:bg-neutral-50'}`}>
                          <div className={`text-13 ${s.is_active ? 'text-neutral-900' : 'text-neutral-400'}`}>{s.name}</div>
                          <div className="text-11 text-neutral-500">
                            {s.billing_frequency} · {s.items.filter((i) => i.kind === 'scope').length} activities{s.is_active ? '' : ' · switched off'}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </aside>
            <section className="dash-card p-4 min-w-0">
              {selected === 'new' || current ? (
                <ServiceEditor
                  key={current?.id ?? 'new'}
                  initial={current ? toInput(current) : blank()}
                  categories={groups.map(([c]) => c)}
                  readOnly={!canEdit}
                  saving={save.isPending}
                  onSave={(b) => save.mutate(b)}
                  onRemove={current ? async () => {
                    if (await confirmAction('Letters already written keep their text. It will no longer be offered for new letters.', { title: `Remove ${current.name}?`, action: 'Remove' })) remove.mutate(current.id);
                  } : undefined}
                />
              ) : <p className="text-13 text-neutral-500">Choose a service on the left.</p>}
            </section>
          </div>
        )}
      </QueryState>
    </div>
  );
}

function ServiceEditor({ initial, categories, readOnly, saving, onSave, onRemove }: {
  initial: MasterInput; categories: string[]; readOnly: boolean; saving: boolean;
  onSave: (b: MasterInput) => void; onRemove?: () => void;
}) {
  const [b, setB] = useState<MasterInput>(initial);
  const services = useQuery({ queryKey: ['workstation.serviceCatalog'], queryFn: () => workstationApi.serviceCatalog() });
  const set = <K extends keyof MasterInput>(k: K, v: MasterInput[K]) => setB((x) => ({ ...x, [k]: v }));
  const items = (fn: (l: MasterInput['items']) => MasterInput['items']) => setB((x) => ({ ...x, items: fn(x.items) }));
  const dirty = JSON.stringify(b) !== JSON.stringify(initial);

  return (
    <fieldset disabled={readOnly} className="space-y-4 min-w-0">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="block sm:col-span-2">
          <span className="text-11 text-neutral-500">Service</span>
          <input value={b.name} onChange={(e) => set('name', e.target.value)} className={inputClass} placeholder="e.g. GST Return Filing & Compliance" />
        </label>
        <label className="block">
          <span className="text-11 text-neutral-500">Main service</span>
          <input list="sm-cats" value={b.category} onChange={(e) => set('category', e.target.value)} className={inputClass} placeholder="e.g. GST" />
          <datalist id="sm-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </label>
        <label className="block">
          <span className="text-11 text-neutral-500">Billing frequency</span>
          <input list="sm-freqs" value={b.billing_frequency} onChange={(e) => set('billing_frequency', e.target.value)} className={inputClass} />
          <datalist id="sm-freqs">{FREQUENCIES.map((f) => <option key={f} value={f} />)}</datalist>
        </label>
        <label className="block">
          <span className="text-11 text-neutral-500">Workstation service it covers</span>
          <select value={b.service_code ?? ''} onChange={(e) => set('service_code', e.target.value || null)} className={inputClass}>
            <option value="">None</option>
            {(services.data?.items ?? []).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-13 text-neutral-700 self-end h-9">
          <input type="checkbox" className="h-4 w-4" checked={b.is_active} onChange={(e) => set('is_active', e.target.checked)} />
          Offered on new letters
        </label>
      </div>
      <p className="text-11 text-neutral-500">
        The Workstation service link lets a client&apos;s Services tab show whether an accepted engagement letter covers that service.
      </p>

      {KINDS.map((kind) => <KindList key={kind} kind={kind} all={b.items} setAll={items} readOnly={readOnly} />)}

      {!readOnly ? (
        <div className="flex items-center gap-2 border-t border-neutral-200 pt-3">
          {onRemove ? <button type="button" className={btn} onClick={onRemove}><Trash2 size={14} /> Remove service</button> : null}
          <div className="flex-1" />
          {dirty ? <button type="button" className={btn} onClick={() => setB(initial)}>Discard changes</button> : null}
          <button type="button" className={btnPrimary} disabled={saving || !dirty || !b.name.trim() || !b.category.trim()} onClick={() => onSave({
            ...b, items: b.items.map((i) => ({ ...i, content: i.content.trim() })).filter((i) => i.content),
          })}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      ) : null}
    </fieldset>
  );
}

function KindList({ kind, all, setAll, readOnly }: {
  kind: ItemKind; all: MasterInput['items'];
  setAll: (fn: (l: MasterInput['items']) => MasterInput['items']) => void; readOnly: boolean;
}) {
  const idx = all.map((it, i) => (it.kind === kind ? i : -1)).filter((i) => i >= 0);
  if (readOnly && !idx.length) return null;
  const patch = (i: number, p: Partial<MasterInput['items'][number]>) => setAll((l) => l.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (pos: number, dir: -1 | 1) => {
    const a = idx[pos], c = idx[pos + dir];
    if (c === undefined) return;
    setAll((l) => { const n = [...l]; [n[a], n[c]] = [n[c], n[a]]; return n; });
  };
  return (
    <div>
      <div className="text-13 font-semibold text-neutral-800 mb-1">{KIND_LABEL[kind]} <span className="text-11 font-normal text-neutral-500">{idx.length}</span></div>
      <ul className="space-y-1">
        {idx.map((i, pos) => (
          <li key={i} className="flex items-start gap-2">
            <input type="checkbox" className="h-4 w-4 mt-2.5 shrink-0" checked={all[i].default_selected}
              title={all[i].default_selected ? 'Ticked by default on a new letter' : 'Unticked by default on a new letter'}
              onChange={(e) => patch(i, { default_selected: e.target.checked })} />
            <textarea rows={Math.min(4, Math.max(1, Math.ceil(all[i].content.length / 110)))} value={all[i].content}
              onChange={(e) => patch(i, { content: e.target.value })}
              className="flex-1 min-w-0 px-2 py-1.5 text-13 bg-white border border-neutral-200 rounded-lg resize-y" />
            {!readOnly ? (
              <div className="flex gap-1 shrink-0 mt-1">
                <button type="button" className={iconBtn} title="Move up" disabled={pos === 0} onClick={() => move(pos, -1)}><ArrowUp size={13} /></button>
                <button type="button" className={iconBtn} title="Move down" disabled={pos === idx.length - 1} onClick={() => move(pos, 1)}><ArrowDown size={13} /></button>
                <button type="button" className={iconBtn} title="Delete" onClick={() => setAll((l) => l.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {!readOnly ? (
        <button type="button" className="text-12 text-primary hover:underline mt-1"
          onClick={() => setAll((l) => [...l, { kind, content: '', default_selected: true }])}>
          + Add {kind === 'note' ? 'a note' : 'a line'}
        </button>
      ) : null}
    </div>
  );
}
