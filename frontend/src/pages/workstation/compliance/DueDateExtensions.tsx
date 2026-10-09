import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/Button';
import { Modal, QueryState, fieldErrors } from '@/modules/workstation/components';
import { ListAction, ListCard, ListEmpty, ListHeader, ListRow, ListTable, TD, TwoLine } from '@/modules/workstation/listUi';
import { complianceApi, complianceKeys, type Extension } from '@/modules/compliance/api';
import { Chip, Labelled, day, errorText, fieldClass, smallBtn } from '@/modules/compliance/ui';

const ENTITY_TYPES = ['company', 'llp', 'firm', 'individual', 'huf', 'trust', 'society', 'aop'];

/**
 * Due-date extensions — a CBDT / CBIC / MCA extension entered once replaces
 * the due date for every client (optionally only some entity types).
 */
export function DueDateExtensionsPage() {
  const { session } = useAuth();
  const role = session?.role.code;
  const canManage = can(role, 'workstation.compliance.manage', 'self');
  const canRead = canManage || can(role, 'workstation.compliance.read', 'self');
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);

  const list = useQuery({ queryKey: complianceKeys.extensions, queryFn: complianceApi.extensions, enabled: canRead });
  const forms = useQuery({ queryKey: complianceKeys.forms, queryFn: complianceApi.forms, enabled: canRead, staleTime: 600_000 });
  const formName = (code: string) => forms.data?.find((f) => f.code === code)?.name ?? code;

  const remove = useMutation({
    mutationFn: (id: string) => complianceApi.deleteExtension(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: complianceKeys.all }); toast.push('success', 'Extension removed'); },
    onError: (e) => toast.push('error', errorText(e)),
  });

  return (
    <div className="max-w-[1100px]">
      <Link to="/workstation/compliance" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900 mb-2">
        <ArrowLeft size={14} /> Compliance
      </Link>
      <ListHeader
        title="Due-date extensions"
        meta="Notified extensions apply to every client's calendar; the statutory date stays visible, struck through."
        action={canManage ? <ListAction onClick={() => setAdding(true)} icon={<Plus size={15} />}>Add extension</ListAction> : undefined}
      />
      <QueryState query={list}>
        {(items: Extension[]) => items.length ? (
          <ListCard>
            <ListTable cols={['Form', 'Period', 'New due date', 'Reference', 'Applies to', '']}>
              {items.map((x) => (
                <ListRow key={x.id}>
                  <TD first><TwoLine top={x.form_name ?? formName(x.form_code)} sub={x.form_code} /></TD>
                  <TD nowrap>{x.period_key}</TD>
                  <TD nowrap strong>{day(x.new_due_date)}</TD>
                  <TD>
                    {x.source_url ? (
                      <a href={x.source_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                        {x.reference} <ExternalLink size={12} />
                      </a>
                    ) : x.reference}
                  </TD>
                  <TD>
                    {entityList(x.entity_types).length
                      ? <span className="flex flex-wrap gap-1">{entityList(x.entity_types).map((e) => <Chip key={e} tone="blue" dot={false}>{e.toUpperCase()}</Chip>)}</span>
                      : <span className="text-neutral-500">All entities</span>}
                  </TD>
                  <TD last>
                    {canManage ? (
                      <button type="button" className={smallBtn} disabled={remove.isPending}
                        onClick={() => { if (window.confirm(`Remove the extension for ${x.form_code} ${x.period_key}? Due dates go back to the statutory date.`)) remove.mutate(x.id); }}>
                        <Trash2 size={13} /> Delete
                      </button>
                    ) : null}
                  </TD>
                </ListRow>
              ))}
            </ListTable>
          </ListCard>
        ) : <ListCard><ListEmpty>No extensions recorded.</ListEmpty></ListCard>}
      </QueryState>
      {adding ? <AddExtension forms={forms.data ?? []} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function entityList(v: string | string[] | null | undefined): string[] {
  return Array.isArray(v) ? v : (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function AddExtension({ forms, onClose }: { forms: { code: string; name: string }[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ form_code: '', period_key: '', new_due_date: '', reference: '', source_url: '' });
  const [entities, setEntities] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: () => complianceApi.addExtension({
      ...f,
      source_url: f.source_url.trim() || undefined,
      entity_types: entities.length ? entities : undefined,
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: complianceKeys.all }); toast.push('success', 'Extension added'); onClose(); },
    onError: (e) => toast.push('error', errorText(e)),
  });
  const errs = fieldErrors(save.error);
  const up = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const ok = f.form_code && f.period_key.trim() && f.new_due_date && f.reference.trim();

  return (
    <Modal open title="Add due-date extension" onClose={onClose} width="w-[560px]"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!ok || save.isPending} onClick={() => save.mutate()}>Save</Button>
      </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Labelled label="Form" hint={errs.form_code}>
          <select className={fieldClass} value={f.form_code} onChange={up('form_code')}>
            <option value="">Choose…</option>
            {forms.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
          </select>
        </Labelled>
        <Labelled label="Period" hint={errs.period_key ?? '2025-26 · 2025-26-Q2 · 2026-09'}>
          <input className={fieldClass} value={f.period_key} onChange={up('period_key')} placeholder="2025-26" />
        </Labelled>
        <Labelled label="New due date" hint={errs.new_due_date}>
          <input type="date" className={fieldClass} value={f.new_due_date} onChange={up('new_due_date')} />
        </Labelled>
        <Labelled label="Notification reference" hint={errs.reference}>
          <input className={fieldClass} value={f.reference} onChange={up('reference')} placeholder="CBDT Circular 9/2026" />
        </Labelled>
        <Labelled label="Source URL (optional)" className="sm:col-span-2" hint={errs.source_url}>
          <input type="url" className={fieldClass} value={f.source_url} onChange={up('source_url')} placeholder="https://incometaxindia.gov.in/…" />
        </Labelled>
      </div>
      <div className="mt-3">
        <span className="block text-12 font-medium text-neutral-500 mb-1">Limited to entity types (leave empty for all)</span>
        <div className="flex flex-wrap gap-2">
          {ENTITY_TYPES.map((e) => (
            <label key={e} className="inline-flex items-center gap-1 text-13 text-neutral-700">
              <input type="checkbox" checked={entities.includes(e)}
                onChange={(ev) => setEntities((s) => (ev.target.checked ? [...s, e] : s.filter((x) => x !== e)))} />
              {e.toUpperCase()}
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
