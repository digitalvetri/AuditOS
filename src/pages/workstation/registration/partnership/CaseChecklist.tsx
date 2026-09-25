import { useState } from 'react';
import { type CaseDetail, type CaseItem, type DocRequirement } from '@/modules/partnership/api';
import { Card, Field, Modal, Status, fieldErrors, inputClass, textareaClass } from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { fmtDate } from '@/lib/format';
import { DueChip, EmployeeSelect, RequirementTag, useSvc } from './shared';
import { useCaseMutation } from './PartnershipCase';
import { UploadModal } from './CaseDocuments';

const ITEM_STATUS = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'NOT_APPLICABLE', label: 'Not Applicable' },
  { value: 'BLOCKED', label: 'Blocked' },
];

/** The case's own checklist — a snapshot of the master, plus custom rows. */
export function CaseChecklist({ c, onOpenDocuments, onOpenDetails }: { c: CaseDetail; onOpenDocuments: () => void; onOpenDetails: () => void }) {
  const { stageLabel } = useSvc();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [addCategory, setAddCategory] = useState(false);
  const [addItemTo, setAddItemTo] = useState<{ categoryId: string; partnerId?: string } | null>(null);
  const [uploadFor, setUploadFor] = useState<DocRequirement | null>(null);
  const reqById = new Map(c.requirements.map((r) => [r.id, r]));
  const p = c.progress;
  const docCounts = {
    pending: c.requirements.filter((r) => r.requirement !== 'OPTIONAL' && r.status === 'PENDING').length,
  };

  return (
    <div className="grid md:grid-cols-[1fr_260px] gap-4 items-start">
      <div>
        {c.premises_type === null && c.categories.some((cat) => cat.items.some((i) => i.condition)) ? (
          <div className="mb-3 border-l-2 border-amber pl-3 text-13 text-neutral-700">
            Office proof depends on whether the premises are rented or owned. Set it under{' '}
            <strong>Registration Details</strong> — until then those items are left out of the progress count.
          </div>
        ) : null}
        {c.kind === 'GST' && !c.entity_type ? (
          <div className="mb-3 border-l-2 border-amber pl-3 text-13 text-neutral-700">
            The documents depend on the business type. Set it under{' '}
            <button type="button" className="underline font-medium" onClick={onOpenDetails}>Registration Details</button> — until then those sections are not counted.
          </div>
        ) : null}
        <div className="flex items-center mb-2">
          <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">Checklist</span>
          <div className="flex-1" />
          {c.permissions.manage ? <Button size="sm" onClick={() => setAddCategory(true)}>+ Add Category</Button> : null}
        </div>

        {c.categories.length === 0 ? (
          <Card><div className="px-4 py-6 text-13 text-neutral-500">This checklist is empty. Add a category to start.</div></Card>
        ) : null}

        {c.categories.map((cat) => {
          const applicable = cat.items.filter((i) => i.applicable && i.status !== 'NOT_APPLICABLE');
          const done = applicable.filter((i) => i.status === 'COMPLETED').length;
          const open = !collapsed[cat.id];
          return (
            <section key={cat.id} className="bg-white border border-neutral-200 rounded mb-3">
              <button
                type="button"
                onClick={() => setCollapsed((s) => ({ ...s, [cat.id]: open }))}
                className="w-full h-10 px-4 flex items-center gap-2 text-left border-b border-neutral-200"
              >
                <span className="text-neutral-500 w-3">{open ? '▾' : '▸'}</span>
                <span className="text-13 font-medium text-neutral-900 uppercase tracking-[0.03em]">{cat.name}</span>
                {cat.description ? <span className="text-12 text-neutral-500">· {cat.description}</span> : null}
                {cat.is_custom ? <span className="text-11 text-neutral-500 border border-neutral-300 rounded px-1">This client only</span> : null}
                <div className="flex-1" />
                {cat.stage ? <span className="text-12 text-neutral-400 hidden md:inline">{stageLabel(cat.stage)}</span> : null}
                <span className="text-12 text-neutral-500 tabular-nums">{done} / {applicable.length}</span>
              </button>
              {open && cat.per_partner ? (
                <PartnerGroups c={c} cat={cat} reqById={reqById} onUpload={setUploadFor}
                  onAddItem={(partnerId) => setAddItemTo({ categoryId: cat.id, partnerId })} onOpenDetails={onOpenDetails} />
              ) : open ? (
                <div>
                  {cat.items.length === 0 ? (
                    <div className="px-4 py-3 text-13 text-neutral-500">No items in this category yet.</div>
                  ) : cat.items.map((item) => (
                    <ItemRow key={item.id} c={c} item={item} reqById={reqById} onUpload={setUploadFor} />
                  ))}
                  {c.permissions.manage ? (
                    <div className="px-4 py-2">
                      <button type="button" className="text-13 text-neutral-600 hover:text-neutral-900" onClick={() => setAddItemTo({ categoryId: cat.id })}>+ Add Checklist Item</button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>

      <div className="space-y-4">
      {c.partner_progress.length > 0 && c.categories.some((x) => x.per_partner) ? (
        <Card title="Partner KYC progress">
          <div className="px-4 py-3 text-13 space-y-2">
            {c.partner_progress.map((pp) => (
              <div key={pp.partner_id}>
                <div className="flex"><span className="flex-1 truncate">{pp.name}</span><span className="tabular-nums text-neutral-700">{pp.done} / {pp.total}</span></div>
                {pp.docs_pending > 0 ? <div className="text-12 text-amber">{pp.docs_pending} document{pp.docs_pending === 1 ? '' : 's'} not uploaded</div> : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      <Card title="Stages">
        <div className="px-4 py-3 text-13 space-y-1">
          {c.stage_progress.filter((st) => st.total > 0 || st.stage === c.stage).map((st) => (
            <div key={st.stage} className="flex items-center gap-2">
              <span className={`flex-1 ${st.stage === c.stage ? 'font-medium text-neutral-900' : 'text-neutral-600'}`}>{stageLabel(st.stage)}{st.stage === c.stage ? ' · current' : ''}</span>
              <span className="tabular-nums text-neutral-700">{st.total ? `${st.done} / ${st.total}` : '—'}</span>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Document summary">
        <div className="px-4 py-3 text-13 space-y-1">
          <div className="flex"><span className="flex-1 text-neutral-500">Required</span><span className="tabular-nums">{p.docs_required}</span></div>
          <div className="flex"><span className="flex-1 text-neutral-500">Uploaded</span><span className="tabular-nums">{p.docs_uploaded}</span></div>
          <div className="flex"><span className="flex-1 text-neutral-500">Verified</span><span className="tabular-nums">{p.docs_verified}</span></div>
          <div className="flex"><span className="flex-1 text-neutral-500">Pending</span><span className="tabular-nums">{docCounts.pending}</span></div>
          {c.partners.length === 0 ? (
            <p className="text-12 text-amber pt-2">No partners yet — per-partner documents (PAN, ID proof, photo) appear once partners are added in Registration Details.</p>
          ) : null}
          <div className="pt-2"><Button size="sm" onClick={onOpenDocuments}>View Documents</Button></div>
        </div>
      </Card>
      </div>

      <AddCategoryModal caseId={c.id} open={addCategory} onClose={() => setAddCategory(false)} />
      {addItemTo ? <AddItemModal caseId={c.id} categoryId={addItemTo.categoryId} partnerId={addItemTo.partnerId} onClose={() => setAddItemTo(null)} /> : null}
      {uploadFor ? <UploadModal c={c} requirement={uploadFor} onClose={() => setUploadFor(null)} /> : null}
    </div>
  );
}

function ItemRow({ c, item, reqById, onUpload }: {
  c: CaseDetail; item: CaseItem; reqById: Map<string, DocRequirement>; onUpload: (r: DocRequirement) => void;
}) {
  const { api: regApi } = useSvc();
  const [expanded, setExpanded] = useState(false);
  const update = useCaseMutation((v: Record<string, unknown>) => regApi.updateItem(c.id, item.id, v));
  const remove = useCaseMutation(() => regApi.removeItem(c.id, item.id), 'Item removed');
  const done = item.status === 'COMPLETED';
  const na = item.status === 'NOT_APPLICABLE' || !item.applicable;
  const docs = item.documents.filter((d) => d.status !== 'NOT_APPLICABLE' || item.applicable);

  return (
    <div className={`px-4 py-2 border-b border-neutral-100 last:border-b-0 ${na ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 accent-neutral-900"
          checked={done}
          disabled={!c.permissions.manage || update.isPending || na}
          onChange={() => update.mutate({ status: done ? 'PENDING' : 'COMPLETED' })}
          aria-label={`Mark ${item.name} ${done ? 'pending' : 'completed'}`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setExpanded((x) => !x)} className={`text-13 text-left ${done ? 'text-neutral-500 line-through' : 'text-neutral-900'} font-medium`}>
              {item.name}
            </button>
            <RequirementTag value={item.requirement} condition={item.condition} />
            {item.per_partner ? <span className="text-11 text-neutral-500">All partners</span> : null}
            {item.is_custom ? <span className="text-11 text-neutral-500">Custom</span> : null}
            {item.status !== 'PENDING' && item.status !== 'COMPLETED' ? <Status value={item.status.toLowerCase()} /> : null}
          </div>
          {item.description ? <div className="text-12 text-neutral-500">{item.description}</div> : null}
          {item.doc_type_options ? <div className="text-12 text-neutral-500">Any one: {item.doc_type_options.join(' / ')}</div> : null}
          {!item.applicable ? <div className="text-12 text-neutral-500">Not applicable to this case{item.condition === 'RENTED' || item.condition === 'OWNED' ? "'s premises" : "'s business type"}.</div> : null}
          {done && item.completed_at ? (
            <div className="text-12 text-neutral-500">Completed {fmtDate(item.completed_at)}{item.completed_by ? ` by ${item.completed_by.full_name}` : ''}</div>
          ) : null}
          {docs.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-2">
              {docs.map((d) => {
                const r = reqById.get(d.requirement_id);
                return (
                  <span key={d.requirement_id} className="inline-flex items-center gap-1 text-12 border border-neutral-200 rounded px-1.5 h-6">
                    <span className="text-neutral-700">{d.partner ? d.partner.name : 'Document'}</span>
                    <Status value={d.status === 'UPLOADED' ? 'uploaded' : d.status.toLowerCase()} />
                    {c.permissions.upload && r && d.status !== 'VERIFIED' && d.status !== 'NOT_APPLICABLE' ? (
                      <button type="button" className="underline text-neutral-700" onClick={() => onUpload(r)}>
                        {d.status === 'PENDING' ? 'Upload' : 'Replace'}
                      </button>
                    ) : null}
                  </span>
                );
              })}
            </div>
          ) : item.kind === 'DOCUMENT' && item.per_partner && c.partners.length === 0 ? (
            <div className="text-12 text-amber mt-1">Add partners in Registration Details to collect this per partner.</div>
          ) : null}
        </div>
        <div className="text-right shrink-0 space-y-0.5">
          <DueChip date={item.due_date} state={item.due_state} />
          <div className="text-12 text-neutral-500">{item.assigned?.full_name ?? ''}</div>
        </div>
      </div>

      {expanded ? (
        <div className="mt-2 ml-7 grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
          <label className="block">
            <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Status</span>
            <select className={inputClass} disabled={!c.permissions.manage} value={item.status} onChange={(e) => update.mutate({ status: e.target.value })}>
              {ITEM_STATUS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Assigned to</span>
            <EmployeeSelect className="w-full" value={item.assigned?.id ?? ''} onChange={(v) => c.permissions.manage && update.mutate({ assigned_employee_id: v || null })} />
          </label>
          <label className="block">
            <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Due date</span>
            <input type="date" className={inputClass} disabled={!c.permissions.manage} value={item.due_date ?? ''} onChange={(e) => update.mutate({ due_date: e.target.value || null })} />
          </label>
          <label className="block">
            <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Priority</span>
            <select className={inputClass} disabled={!c.permissions.manage} value={item.priority} onChange={(e) => update.mutate({ priority: e.target.value })}>
              <option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option>
            </select>
          </label>
          <NotesEditor
            key={item.updated_at}
            initial={item.notes ?? ''}
            disabled={!c.permissions.manage}
            onSave={(notes) => update.mutate({ notes })}
          />
          <div className="col-span-2 md:col-span-4 text-11 text-neutral-400">
            Created {fmtDate(item.created_at)} · Updated {fmtDate(item.updated_at)}
            {item.is_custom && c.permissions.manage ? (
              <button type="button" className="ml-3 text-red underline" onClick={() => remove.mutate(undefined)}>Remove item</button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A per-partner category (LLP KYC): each partner's own copy of the items. */
function PartnerGroups({ c, cat, reqById, onUpload, onAddItem, onOpenDetails }: {
  c: CaseDetail; cat: CaseDetail['categories'][number]; reqById: Map<string, DocRequirement>;
  onUpload: (r: DocRequirement) => void; onAddItem: (partnerId: string) => void; onOpenDetails: () => void;
}) {
  if (c.partners.length === 0) {
    return (
      <div className="px-4 py-4 text-13 text-neutral-500">
        No partners added yet. Each partner gets their own copy of these items.{' '}
        {c.permissions.manage ? <button type="button" className="underline text-neutral-900" onClick={onOpenDetails}>+ Add Partner</button> : null}
      </div>
    );
  }
  return (
    <div>
      {c.partners.map((p) => {
        const items = cat.items.filter((i) => i.partner?.id === p.id);
        const counted = items.filter((i) => i.applicable && i.status !== 'NOT_APPLICABLE');
        const done = counted.filter((i) => i.status === 'COMPLETED').length;
        return (
          <div key={p.id} className="border-b border-neutral-200 last:border-b-0">
            <div className="px-4 h-8 flex items-center bg-neutral-50 text-12">
              <span className="font-medium text-neutral-900">Partner — {p.name}</span>
              <div className="flex-1" />
              <span className="tabular-nums text-neutral-500">{done} / {counted.length} completed</span>
            </div>
            {items.map((item) => <ItemRow key={item.id} c={c} item={item} reqById={reqById} onUpload={onUpload} />)}
            {c.permissions.manage ? (
              <div className="px-4 py-1.5">
                <button type="button" className="text-13 text-neutral-600 hover:text-neutral-900" onClick={() => onAddItem(p.id)}>+ Add Checklist Item for {p.name}</button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function NotesEditor({ initial, onSave, disabled }: { initial: string; onSave: (v: string) => void; disabled: boolean }) {
  const [v, setV] = useState(initial);
  return (
    <div className="col-span-2 md:col-span-4">
      <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Notes</span>
      <textarea className={textareaClass} rows={2} disabled={disabled} value={v} onChange={(e) => setV(e.target.value)} />
      {v !== initial && !disabled ? <Button size="sm" className="mt-1" onClick={() => onSave(v)}>Save notes</Button> : null}
    </div>
  );
}

export function AddCategoryModal({ caseId, open, onClose, defaultName = '' }: { caseId: string; open: boolean; onClose: () => void; defaultName?: string }) {
  const { api: regApi } = useSvc();
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const m = useCaseMutation(() => regApi.addCategory(caseId, { name, description }), 'Category added');
  const errs = fieldErrors(m.error);
  return (
    <Modal
      open={open}
      title="Add Category"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={m.isPending} onClick={() => m.mutate(undefined, { onSuccess: () => { setName(''); setDescription(''); onClose(); } })}>Add</Button></>}
    >
      <Field label="Name" error={errs.name}><input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Additional Client Requirements" /></Field>
      <Field label="Description" error={errs.description}><input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <p className="text-12 text-neutral-500">Belongs to this client's case only. The master checklist is not changed.</p>
    </Modal>
  );
}

function AddItemModal({ caseId, categoryId, partnerId, onClose }: { caseId: string; categoryId: string; partnerId?: string; onClose: () => void }) {
  const { api: regApi } = useSvc();
  const [f, setF] = useState({ name: '', description: '', assigned_employee_id: '', due_date: '', priority: 'MEDIUM', requirement: 'REQUIRED', kind: 'ACTION', notes: '' });
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const m = useCaseMutation(() => regApi.addItem(caseId, { ...f, category_id: categoryId, partner_id: partnerId }), 'Checklist item added');
  const errs = fieldErrors(m.error);
  return (
    <Modal
      open
      title="Add Checklist Item"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={m.isPending} onClick={() => m.mutate(undefined, { onSuccess: onClose })}>Add item</Button></>}
    >
      <Field label="Item name" error={errs.name}><input className={inputClass} value={f.name} onChange={(e) => set('name')(e.target.value)} /></Field>
      <Field label="Description" error={errs.description}><textarea className={textareaClass} rows={2} value={f.description} onChange={(e) => set('description')(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Assigned to" error={errs.assigned_employee_id}><EmployeeSelect className="w-full" value={f.assigned_employee_id} onChange={set('assigned_employee_id')} /></Field>
        <Field label="Due date" error={errs.due_date}><input type="date" className={inputClass} value={f.due_date} onChange={(e) => set('due_date')(e.target.value)} /></Field>
        <Field label="Priority"><select className={inputClass} value={f.priority} onChange={(e) => set('priority')(e.target.value)}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></Field>
        <Field label="Required / Optional"><select className={inputClass} value={f.requirement} onChange={(e) => set('requirement')(e.target.value)}><option value="REQUIRED">Required</option><option value="OPTIONAL">Optional</option><option value="CONDITIONAL">Conditional</option></select></Field>
        <Field label="Type" hint="A Document item also creates a document to collect."><select className={inputClass} value={f.kind} onChange={(e) => set('kind')(e.target.value)}><option value="ACTION">Task / action</option><option value="INFO">Information</option><option value="DOCUMENT">Document</option></select></Field>
      </div>
      <Field label="Notes"><textarea className={textareaClass} rows={2} value={f.notes} onChange={(e) => set('notes')(e.target.value)} /></Field>
      <p className="text-12 text-neutral-500">Added to this client's case only. The master checklist is not changed.</p>
    </Modal>
  );
}
