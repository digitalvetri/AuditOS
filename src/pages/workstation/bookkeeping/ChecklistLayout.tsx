import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { bookkeepingApi } from '@/modules/bookkeeping/api';
import { human } from '@/modules/bookkeeping/format';
import type { WorkflowStage } from '@/modules/bookkeeping/types';
import { Field, Modal, inputClass } from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';

/**
 * Monthly Work → Layout. The checklist every month is opened with: add a
 * step, remove one, rename it, or change its order.
 *
 * Adding can also add the step to every month still open; removing takes
 * the step out of the layout and, optionally, removes it from open months
 * where nobody has started it. Completed work is never removed.
 */
/** The layout editor as a pop-up (Monthly Work list). */
export function ChecklistLayoutModal({ open, onClose, canManage }: { open: boolean; onClose: () => void; canManage: boolean }) {
  return (
    <Modal open={open} title="Checklist layout" onClose={onClose} width="w-[680px]" footer={
      <div className="flex justify-end"><Button size="sm" onClick={onClose}>Done</Button></div>
    }>
      <div className="p-4">{open ? <ChecklistLayoutPanel canManage={canManage} /> : null}</div>
    </Modal>
  );
}

/** The layout editor itself — inline on a client's month (Layout tab), or inside the pop-up. */
export function ChecklistLayoutPanel({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const layout = useQuery({ queryKey: ['bookkeeping', 'layout'], queryFn: bookkeepingApi.layout });
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState({ name: '', category: 'other', offset: '0', applyToOpen: true });
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<WorkflowStage | null>(null);
  const [removeFromOpen, setRemoveFromOpen] = useState(true);

  // The layout drives every period's checklist, so any change refreshes them.
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['bookkeeping'] });
  };
  const fail = (e: Error) => setError(e.message);

  const add = useMutation({
    mutationFn: () => bookkeepingApi.addStep({
      name: adding.name.trim(), default_category: adding.category,
      default_offset_days: Number(adding.offset) || 0, apply_to_open: adding.applyToOpen,
    }),
    onSuccess: (r) => {
      setError(null);
      setAdding({ name: '', category: adding.category, offset: '0', applyToOpen: adding.applyToOpen });
      toast.push('success', `"${r.stage.name}" added${r.added_to_open_months ? ` to the layout and ${r.added_to_open_months} open month${r.added_to_open_months === 1 ? '' : 's'}` : ' to the layout'}.`);
      refresh();
    },
    onError: fail,
  });
  const rename = useMutation({
    mutationFn: (e: { id: string; name: string }) => bookkeepingApi.updateStep(e.id, { name: e.name.trim() }),
    onSuccess: () => { setError(null); setEditing(null); refresh(); },
    onError: fail,
  });
  const move = useMutation({
    mutationFn: ({ id, dir }: { id: string; dir: 'up' | 'down' }) => bookkeepingApi.moveStep(id, dir),
    onSuccess: () => { setError(null); refresh(); },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (s: WorkflowStage) => bookkeepingApi.removeStep(s.id, removeFromOpen),
    onSuccess: (r, s) => {
      setError(null); setRemoving(null);
      toast.push('success', `"${s.name}" removed from the layout${r.removed_pending_tasks ? ` and from ${r.removed_pending_tasks} open month${r.removed_pending_tasks === 1 ? '' : 's'}` : ''}.`);
      refresh();
    },
    onError: (e: Error) => { setRemoving(null); fail(e); },
  });

  const stages = layout.data?.stages ?? [];
  const busy = add.isPending || rename.isPending || move.isPending || remove.isPending;
  const submitAdd = () => {
    if (!adding.name.trim()) { setError('Enter a name for the step.'); return; }
    add.mutate();
  };

  return (
    <>
        <div className="space-y-4">
          <p className="text-13 text-neutral-600">
            The steps every month&apos;s checklist is opened with, in order.
            {layout.data ? ` ${layout.data.open_periods} month${layout.data.open_periods === 1 ? ' is' : 's are'} open right now.` : ''}
          </p>
          {!canManage ? <div className="border-l-2 border-neutral-400 pl-3 text-13 text-neutral-600">You can view the layout. Changing it needs firm-wide Services manage access (a manager or MD).</div> : null}
          {error ? <div className="border-l-2 border-red pl-3 text-13 text-red">{error}</div> : null}

          {layout.isLoading ? <p className="text-13 text-neutral-500">Loading…</p> : null}
          {layout.isError ? <p className="text-13 text-red">{(layout.error as Error).message}</p> : null}

          <ol className="border border-neutral-200 rounded divide-y divide-neutral-200">
            {stages.map((s, i) => (
              <li key={s.id} className="flex items-center gap-2 px-3 py-2 min-h-11">
                <span className="w-6 text-12 text-neutral-400 tabular-nums">{i + 1}.</span>
                {editing?.id === s.id ? (
                  <form className="flex-1 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (editing.name.trim()) rename.mutate(editing); }}>
                    <input className={inputClass} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus aria-label="Step name" />
                    <button type="submit" className="p-1 text-neutral-600 hover:text-neutral-900" aria-label="Save name" disabled={busy}><Check size={16} /></button>
                    <button type="button" className="p-1 text-neutral-400 hover:text-neutral-900" aria-label="Cancel rename" onClick={() => setEditing(null)}><X size={16} /></button>
                  </form>
                ) : (
                  <div className="flex-1 min-w-0">
                    <div className="text-13 text-neutral-900 truncate">{s.name}</div>
                    <div className="text-11 text-neutral-500">
                      {human(s.default_category)}{s.default_offset_days ? ` · due ${s.default_offset_days} day${Math.abs(s.default_offset_days) === 1 ? '' : 's'} after month end` : ' · due at month end'}
                      {s.gate_rule_slug ? ' · checked automatically' : ''}
                    </div>
                  </div>
                )}
                {canManage && editing?.id !== s.id ? (
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button type="button" className="p-1.5 text-neutral-500 hover:text-neutral-900 disabled:opacity-30" aria-label={`Move ${s.name} up`} disabled={busy || i === 0} onClick={() => move.mutate({ id: s.id, dir: 'up' })}><ArrowUp size={15} /></button>
                    <button type="button" className="p-1.5 text-neutral-500 hover:text-neutral-900 disabled:opacity-30" aria-label={`Move ${s.name} down`} disabled={busy || i === stages.length - 1} onClick={() => move.mutate({ id: s.id, dir: 'down' })}><ArrowDown size={15} /></button>
                    <button type="button" className="p-1.5 text-neutral-500 hover:text-neutral-900" aria-label={`Rename ${s.name}`} disabled={busy} onClick={() => setEditing({ id: s.id, name: s.name })}><Pencil size={14} /></button>
                    <button type="button" className="p-1.5 text-neutral-500 hover:text-red disabled:opacity-30" aria-label={`Delete ${s.name}`} disabled={busy || stages.length <= 1} title={stages.length <= 1 ? 'The checklist needs at least one step.' : undefined} onClick={() => { setRemoveFromOpen(true); setRemoving(s); }}><Trash2 size={14} /></button>
                  </div>
                ) : null}
              </li>
            ))}
            {layout.data && stages.length === 0 ? <li className="px-3 py-3 text-13 text-neutral-500">No steps yet — add the first one below.</li> : null}
          </ol>

          {canManage ? (
            <form className="border border-neutral-200 rounded p-3 space-y-3" onSubmit={(e) => { e.preventDefault(); submitAdd(); }}>
              <div className="text-13 font-medium text-neutral-900">Add a step</div>
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_170px_110px] gap-3">
                <Field label="Name">
                  <input className={inputClass} value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="e.g. Verify GST input credit" />
                </Field>
                <Field label="Category">
                  <select className={inputClass} value={adding.category} onChange={(e) => setAdding({ ...adding, category: e.target.value })}>
                    {(layout.data?.task_categories ?? ['other']).map((c) => <option key={c} value={c}>{human(c)}</option>)}
                  </select>
                </Field>
                <Field label="Due (days)" hint="after month end">
                  <input className={inputClass} inputMode="numeric" value={adding.offset} onChange={(e) => setAdding({ ...adding, offset: e.target.value.replace(/[^\d-]/g, '') })} />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-13 text-neutral-700">
                <input type="checkbox" checked={adding.applyToOpen} onChange={(e) => setAdding({ ...adding, applyToOpen: e.target.checked })} />
                Also add it to the {layout.data?.open_periods ?? ''} month{layout.data?.open_periods === 1 ? '' : 's'} already open
              </label>
              <div className="flex justify-end">
                <Button size="sm" variant="primary" type="submit" disabled={busy}><Plus size={14} className="mr-1" />{add.isPending ? 'Adding…' : 'Add step'}</Button>
              </div>
            </form>
          ) : null}
        </div>

      <Modal open={Boolean(removing)} title="Delete checklist step" onClose={() => setRemoving(null)} footer={
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={() => setRemoving(null)}>Cancel</Button>
          <Button size="sm" variant="danger" disabled={remove.isPending} onClick={() => removing && remove.mutate(removing)}>{remove.isPending ? 'Deleting…' : 'Delete step'}</Button>
        </div>
      }>
        <div className="p-4 space-y-3 text-13 text-neutral-700">
          <p>Remove <b>{removing?.name}</b> from the checklist? New months will no longer include it.</p>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={removeFromOpen} onChange={(e) => setRemoveFromOpen(e.target.checked)} />
            <span>Also remove it from open months where it hasn&apos;t been started. Started or completed steps are kept with their history.</span>
          </label>
        </div>
      </Modal>
    </>
  );
}
