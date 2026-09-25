import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type TemplateCategory, type TemplateItem } from '@/modules/partnership/api';
import { Card, Field, Modal, PageHeader, QueryState, fieldErrors, inputClass, textareaClass } from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import type { ApiError } from '@/services/api';
import { RequirementTag, useSvc } from './shared';

/**
 * The MASTER checklist. A case copies it when it opens; editing here changes
 * only cases opened afterwards. Seeded from the firm's PDF.
 */
export function PartnershipTemplate() {
  const { api: regApi, keys: regKeys, stageLabel, label } = useSvc();
  const q = useQuery({ queryKey: regKeys.template, queryFn: regApi.template });
  const [editCat, setEditCat] = useState<TemplateCategory | 'new' | null>(null);
  const [editItem, setEditItem] = useState<{ categoryId: string; item: TemplateItem | null } | null>(null);
  const del = useTemplateMutation((v: { kind: 'cat' | 'item'; id: string }) =>
    v.kind === 'cat' ? regApi.deleteTemplateCategory(v.id) : regApi.deleteTemplateItem(v.id), 'Removed from the master checklist');

  return (
    <>
      <PageHeader
        title="Checklist Template"
        subtitle={`The master checklist new ${label} cases start from. Existing cases keep their own copy.`}
        action={q.data?.can_manage ? <Button variant="primary" onClick={() => setEditCat('new')}>+ Add Category</Button> : undefined}
      />
      <QueryState query={q}>
        {(d) => (
          <div className="space-y-3">
            {/* §9-8 template version pinning — cases snapshot the template
                at creation, so an edit here does not touch cases already
                open. Make that explicit in the UI. */}
            {d.open_case_count > 0 ? (
              <div className="text-12 text-neutral-500 border-l-2 border-neutral-300 pl-3 py-1">
                Changes apply to cases created from now on.
                {' '}
                <strong>{d.open_case_count}</strong> open {d.open_case_count === 1 ? 'case keeps' : 'cases keep'}{' '}
                the wording {d.open_case_count === 1 ? 'it was' : 'they were'} opened with.
              </div>
            ) : null}
            {d.categories.map((cat) => (
              <Card
                key={cat.id}
                title={`${cat.name}${cat.description ? ` — ${cat.description}` : ''} · ${stageLabel(cat.stage)}${cat.per_partner ? ' · repeated per partner' : ''}`}
                right={d.can_manage ? (
                  <span className="flex gap-3 text-12">
                    <button className="underline" onClick={() => setEditItem({ categoryId: cat.id, item: null })}>+ Item</button>
                    <button className="underline" onClick={() => setEditCat(cat)}>Edit</button>
                    <button className="underline text-red" onClick={() => { if (window.confirm(`Remove "${cat.name}" and its items from the master? Existing cases are not affected.`)) del.mutate({ kind: 'cat', id: cat.id }); }}>Remove</button>
                  </span>
                ) : undefined}
              >
                {cat.items.length === 0 ? <div className="px-4 py-3 text-13 text-neutral-500">No items.</div> : cat.items.map((i) => (
                  <div key={i.id} className="px-4 py-2 border-b border-neutral-100 last:border-b-0 flex items-start gap-3 text-13">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{i.name}</span>
                        <RequirementTag value={i.requirement} condition={i.condition} />
                        <span className="text-11 text-neutral-500">{i.kind === 'DOCUMENT' ? 'Document' : i.kind === 'INFO' ? 'Information' : 'Action'}</span>
                        {i.per_partner ? <span className="text-11 text-neutral-500">Per partner</span> : null}
                        {i.doc_key ? <span className="text-11 text-neutral-400">key {i.doc_key}</span> : null}
                        {i.doc_type_options ? <span className="text-11 text-neutral-500">Any one: {i.doc_type_options.join(' / ')}</span> : null}
                        {i.max_age_days ? <span className="text-11 text-neutral-500">Not older than {i.max_age_days} days</span> : null}
                      </div>
                      {i.description ? <div className="text-12 text-neutral-500">{i.description}</div> : null}
                    </div>
                    <div className="text-12 text-neutral-500 text-right shrink-0">
                      {i.default_due_days != null ? <div>Due +{i.default_due_days} days</div> : null}
                      {i.default_assignee ? <div>To {i.default_assignee === 'REVIEWER' ? 'reviewer' : 'assignee'}</div> : null}
                    </div>
                    {d.can_manage ? (
                      <span className="flex gap-3 text-12 shrink-0">
                        <button className="underline" onClick={() => setEditItem({ categoryId: cat.id, item: i })}>Edit</button>
                        <button className="underline text-red" onClick={() => del.mutate({ kind: 'item', id: i.id })}>Remove</button>
                      </span>
                    ) : null}
                  </div>
                ))}
              </Card>
            ))}
          </div>
        )}
      </QueryState>
      {editCat ? <CategoryModal cat={editCat === 'new' ? null : editCat} onClose={() => setEditCat(null)} /> : null}
      {editItem ? <ItemModal categoryId={editItem.categoryId} item={editItem.item} onClose={() => setEditItem(null)} /> : null}
    </>
  );
}

function useTemplateMutation<T>(fn: (v: T) => Promise<unknown>, success: string) {
  const { keys: regKeys } = useSvc();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: regKeys.template }); toast.push('success', success); },
    onError: (e: ApiError) => toast.push('error', e.message),
  });
}

function CategoryModal({ cat, onClose }: { cat: TemplateCategory | null; onClose: () => void }) {
  const { api: regApi, stageOptions } = useSvc();
  const [f, setF] = useState({ name: cat?.name ?? '', description: cat?.description ?? '', stage: cat?.stage ?? stageOptions[0].value, per_partner: cat?.per_partner ?? false });
  const m = useTemplateMutation(() => (cat ? regApi.updateTemplateCategory(cat.id, f) : regApi.addTemplateCategory(f)), 'Master checklist updated');
  const errs = fieldErrors(m.error);
  return (
    <Modal open title={cat ? 'Edit Category' : 'Add Category'} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={m.isPending} onClick={() => m.mutate(undefined, { onSuccess: onClose })}>Save</Button></>}>
      <Field label="Name" error={errs.name}><input className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Description"><input className={inputClass} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <Field label="Stage">
        <select className={inputClass} value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value as TemplateCategory['stage'] })}>
          {stageOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      {!cat ? (
        <label className="flex items-center gap-2 text-13">
          <input type="checkbox" checked={f.per_partner} onChange={(e) => setF({ ...f, per_partner: e.target.checked })} />
          Repeat for every partner (each partner gets their own copy of the items)
        </label>
      ) : null}
    </Modal>
  );
}

function ItemModal({ categoryId, item, onClose }: { categoryId: string; item: TemplateItem | null; onClose: () => void }) {
  const { api: regApi } = useSvc();
  const [f, setF] = useState({
    name: item?.name ?? '', description: item?.description ?? '', requirement: item?.requirement ?? 'REQUIRED',
    kind: item?.kind ?? 'ACTION', per_partner: item?.per_partner ?? false, doc_key: item?.doc_key ?? '',
    condition: item?.condition ?? '', default_due_days: item?.default_due_days?.toString() ?? '', default_assignee: item?.default_assignee ?? '',
    doc_type_options: item?.doc_type_options?.join(', ') ?? '', max_age_days: item?.max_age_days?.toString() ?? '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const m = useTemplateMutation(() => (item ? regApi.updateTemplateItem(item.id, f) : regApi.addTemplateItem({ ...f, category_id: categoryId })), 'Master checklist updated');
  const errs = fieldErrors(m.error);
  return (
    <Modal open title={item ? 'Edit Item' : 'Add Item'} onClose={onClose} width="w-[640px]"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={m.isPending} onClick={() => m.mutate(undefined, { onSuccess: onClose })}>Save</Button></>}>
      <Field label="Item name" error={errs.name}><input className={inputClass} value={f.name} onChange={set('name')} /></Field>
      <Field label="Description"><textarea className={textareaClass} rows={2} value={f.description} onChange={set('description')} /></Field>
      <div className="grid grid-cols-2 gap-x-3">
        <Field label="Required / Optional / Conditional">
          <select className={inputClass} value={f.requirement} onChange={set('requirement')}><option value="REQUIRED">Required</option><option value="OPTIONAL">Optional</option><option value="CONDITIONAL">Conditional</option></select>
        </Field>
        <Field label="Premises condition" hint="Only for rented/owned office proof">
          <select className={inputClass} value={f.condition} onChange={set('condition')}><option value="">None</option><option value="RENTED">If Rented / Leased</option><option value="OWNED">If Owned</option></select>
        </Field>
        <Field label="Type" hint="Document creates a document requirement">
          <select className={inputClass} value={f.kind} onChange={set('kind')}><option value="INFO">Information</option><option value="DOCUMENT">Document</option><option value="ACTION">Action</option></select>
        </Field>
        <Field label="Per partner">
          <select className={inputClass} value={f.per_partner ? '1' : ''} onChange={(e) => setF((s) => ({ ...s, per_partner: e.target.value === '1' }))}><option value="">No — once per firm</option><option value="1">Yes — one per partner</option></select>
        </Field>
        <Field label="Document key" hint="Items sharing a key collect one file" error={errs.doc_key}><input className={inputClass} value={f.doc_key} onChange={set('doc_key')} /></Field>
        <Field label="Default due (days after opening)" error={errs.default_due_days}><input className={inputClass} value={f.default_due_days} onChange={set('default_due_days')} /></Field>
        <Field label="Any one of (comma-separated)" hint="e.g. Passport, Voter ID, Driving License" error={errs.doc_type_options}><input className={inputClass} value={f.doc_type_options} onChange={set('doc_type_options')} /></Field>
        <Field label="Not older than (days)" hint="Checked against the date on the document" error={errs.max_age_days}><input className={inputClass} value={f.max_age_days} onChange={set('max_age_days')} /></Field>
        <Field label="Default assignment">
          <select className={inputClass} value={f.default_assignee} onChange={set('default_assignee')}><option value="">None</option><option value="ASSIGNEE">Case assignee</option><option value="REVIEWER">Case reviewer</option></select>
        </Field>
      </div>
    </Modal>
  );
}
