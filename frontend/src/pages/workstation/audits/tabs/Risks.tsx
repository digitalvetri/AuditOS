import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Field, Modal, inputClass, textareaClass } from '@/modules/workstation/components';
import { ListCard, ListEmpty, ListRow, ListTable, ListToolbar, Spacer, TD } from '@/modules/workstation/listUi';
import { auditApi } from '@/modules/audit/api';
import { Chip, errText, label, primaryBtn, smallBtn, useAudit, useAuditMutation } from '@/modules/audit/components';
import type { AuditRisk, RiskLevel } from '@/modules/audit/types';
import { confirmAction } from '@/components/ConfirmDialog';

/** SA 315 risk register: the risks of material misstatement and the planned response. */

const ASSERTIONS = ['existence', 'completeness', 'accuracy', 'cut_off', 'classification', 'valuation', 'rights', 'presentation', 'occurrence'];
const LEVELS: RiskLevel[] = ['low', 'medium', 'high', 'significant'];

export function RisksTab() {
  const a = useAudit();
  const [editing, setEditing] = useState<AuditRisk | 'new' | null>(null);
  const risks = useQuery({ queryKey: ['audits', a.file.id, 'risks'], queryFn: () => auditApi.risks(a.file.id) });
  const items = risks.data ?? [];
  const significant = items.filter((r) => r.level === 'significant' || r.fraud_risk).length;

  return (
    <div>
      <ListToolbar>
        <span className="text-13 text-neutral-500">{items.length} risk{items.length === 1 ? '' : 's'}{significant ? ` · ${significant} significant or fraud` : ''}</span>
        <Spacer />
        {a.editable ? <button type="button" className={primaryBtn} onClick={() => setEditing('new')}><Plus size={14} /> Add risk</button> : null}
      </ListToolbar>
      <ListCard>
        {risks.isLoading ? <div className="p-5 text-13 text-neutral-500">Loading…</div>
          : risks.isError ? <div className="p-5 text-13 text-danger">{errText(risks.error)}</div>
            : items.length === 0 ? <ListEmpty>No risks recorded. SA 315 asks for the identified and assessed risks of material misstatement and the response to each.</ListEmpty> : (
              <ListTable cols={['Area', 'Assertion', 'Risk', 'Level', 'Fraud', 'Planned response', 'Working papers']}>
                {items.map((r) => (
                  <ListRow key={r.id} onOpen={a.editable ? () => setEditing(r) : undefined}>
                    <TD first strong>{r.area}</TD>
                    <TD muted nowrap>{label(r.assertion)}</TD>
                    <TD className="max-w-[320px]"><span className="whitespace-pre-wrap">{r.description}</span></TD>
                    <TD><Chip value={r.level} /></TD>
                    <TD nowrap>{r.fraud_risk ? <Chip value="high" text="Fraud risk" /> : <span className="text-neutral-400">—</span>}</TD>
                    <TD muted className="max-w-[300px]"><span className="whitespace-pre-wrap">{r.response ?? '—'}</span></TD>
                    <TD last muted nowrap>{r.working_paper_refs ?? '—'}</TD>
                  </ListRow>
                ))}
              </ListTable>
            )}
      </ListCard>
      {editing ? <RiskModal risk={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function RiskModal({ risk, onClose }: { risk: AuditRisk | null; onClose: () => void }) {
  const a = useAudit();
  const [area, setArea] = useState(risk?.area ?? '');
  const [assertion, setAssertion] = useState(risk?.assertion ?? '');
  const [description, setDescription] = useState(risk?.description ?? '');
  const [level, setLevel] = useState<RiskLevel>(risk?.level ?? 'medium');
  const [fraud, setFraud] = useState(risk?.fraud_risk ?? false);
  const [response, setResponse] = useState(risk?.response ?? '');
  const [refs, setRefs] = useState(risk?.working_paper_refs ?? '');
  const body = () => a.w({
    area: area.trim(), assertion: assertion || null, description: description.trim(), level, fraud_risk: fraud,
    response: response.trim() || null, working_paper_refs: refs.trim() || null,
  });
  const save = useAuditMutation(() => (risk ? auditApi.updateRisk(a.file.id, risk.id, body()) : auditApi.addRisk(a.file.id, body())),
    risk ? 'Risk updated.' : 'Risk added.', onClose);
  const remove = useAuditMutation(() => auditApi.deleteRisk(a.file.id, risk!.id), 'Risk removed.', onClose);
  return (
    <Modal open title={risk ? 'Edit risk' : 'Add risk'} onClose={onClose} width="w-[600px]"
      footer={<>
        {risk && !a.locked ? <button type="button" className={`${smallBtn} mr-auto text-danger`} disabled={remove.isPending}
          onClick={async () => { if (await confirmAction('Remove this risk?')) remove.mutate(); }}>Remove</button> : null}
        <button type="button" className={smallBtn} onClick={onClose}>Cancel</button>
        <button type="button" className={primaryBtn} disabled={!area.trim() || !description.trim() || save.isPending} onClick={() => save.mutate()}>Save</button>
      </>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
        <Field label="Area"><input className={inputClass} value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Revenue" autoFocus /></Field>
        <Field label="Assertion">
          <select className={inputClass} value={assertion} onChange={(e) => setAssertion(e.target.value)}>
            <option value="">—</option>
            {ASSERTIONS.map((x) => <option key={x} value={x}>{label(x)}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Risk of material misstatement"><textarea className={textareaClass} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 items-end">
        <Field label="Assessed level">
          <select className={inputClass} value={level} onChange={(e) => setLevel(e.target.value as RiskLevel)}>
            {LEVELS.map((x) => <option key={x} value={x}>{label(x)}</option>)}
          </select>
        </Field>
        <label className="flex items-center gap-2 mb-3 h-9 text-13 text-neutral-800">
          <input type="checkbox" checked={fraud} onChange={(e) => setFraud(e.target.checked)} /> Fraud risk (SA 240)
        </label>
      </div>
      <Field label="Planned audit response"><textarea className={textareaClass} rows={3} value={response} onChange={(e) => setResponse(e.target.value)} /></Field>
      <Field label="Working paper refs" hint="Comma-separated, e.g. C-8, C-9"><input className={inputClass} value={refs} onChange={(e) => setRefs(e.target.value)} /></Field>
    </Modal>
  );
}
