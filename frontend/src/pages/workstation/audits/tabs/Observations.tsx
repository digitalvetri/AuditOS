import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Field, Modal, inputClass, textareaClass } from '@/modules/workstation/components';
import { ListCard, ListEmpty, ListRow, ListTable, ListToolbar, Spacer, StatusPills, TD, fmtDay } from '@/modules/workstation/listUi';
import { auditApi } from '@/modules/audit/api';
import {
  Chip, errText, inr, label, paiseToRupeesText, primaryBtn, rupeesToPaise, smallBtn, useAudit, useAuditMutation,
} from '@/modules/audit/components';
import type { AuditObservation, ObsKind, ObsStatus, ReportImpact, Severity } from '@/modules/audit/types';

/** Points raised with the client — queries, observations, misstatements (SA 450), control deficiencies. */

const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];
const KINDS: { value: ObsKind; label: string }[] = [
  { value: 'query', label: 'Query' },
  { value: 'observation', label: 'Observation' },
  { value: 'misstatement', label: 'Misstatement (SA 450)' },
  { value: 'control_deficiency', label: 'Control deficiency (SA 265)' },
];
const IMPACTS: { value: ReportImpact; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'caro', label: 'CARO reporting' },
  { value: 'emphasis_of_matter', label: 'Emphasis of matter' },
  { value: 'qualification', label: 'Qualification' },
  { value: 'management_letter', label: 'Management letter' },
];
const STATUSES: { value: ObsStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'sent_to_client', label: 'Sent to client' },
  { value: 'responded', label: 'Responded' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'carried_forward', label: 'Carried forward' },
];

export function ObservationsTab() {
  const a = useAudit();
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState<AuditObservation | 'new' | null>(null);
  const obs = useQuery({ queryKey: ['audits', a.file.id, 'observations'], queryFn: () => auditApi.observations(a.file.id) });
  const all = obs.data ?? [];
  const items = status ? all.filter((o) => o.status === status) : all;

  return (
    <div>
      <ListToolbar>
        <StatusPills options={[{ value: '', label: 'All' }, ...STATUSES]} value={status} onChange={setStatus}
          counts={Object.fromEntries(STATUSES.map((s) => [s.value, all.filter((o) => o.status === s.value).length]))} />
        <Spacer />
        {a.editable ? <button type="button" className={primaryBtn} onClick={() => setEditing('new')}><Plus size={14} /> Add observation</button> : null}
      </ListToolbar>
      <ListCard>
        {obs.isLoading ? <div className="p-5 text-13 text-neutral-500">Loading…</div>
          : obs.isError ? <div className="p-5 text-13 text-danger">{errText(obs.error)}</div>
            : items.length === 0 ? <ListEmpty>{status ? 'Nothing with this status.' : 'No observations yet.'}</ListEmpty> : (
              <ListTable cols={['Ref', 'Observation', 'Severity', 'Kind', { label: 'Amount', align: 'right' }, 'Report impact', 'Status', 'Owner', 'Due']}>
                {items.map((o) => (
                  <ListRow key={o.id} onOpen={() => setEditing(o)}>
                    <TD first strong nowrap>{o.ref}</TD>
                    <TD className="max-w-[320px]">
                      <div className="font-medium text-neutral-900">{o.title}</div>
                      {o.area ? <div className="text-11 text-neutral-500">{o.area}</div> : null}
                    </TD>
                    <TD><Chip value={o.severity} /></TD>
                    <TD muted nowrap>{label(o.kind)}</TD>
                    <TD right nowrap className="tabular-nums">
                      {o.amount_paise !== null ? <>{inr(o.amount_paise)}{o.adjusted !== null ? <div className="text-11 text-neutral-500">{o.adjusted ? 'Adjusted' : 'Unadjusted'}</div> : null}</> : '—'}
                    </TD>
                    <TD muted nowrap>{IMPACTS.find((i) => i.value === o.report_impact)?.label ?? label(o.report_impact)}</TD>
                    <TD><Chip value={o.status} /></TD>
                    <TD muted nowrap>{o.owner_name ?? '—'}</TD>
                    <TD last muted nowrap>{fmtDay(o.due_date)}</TD>
                  </ListRow>
                ))}
              </ListTable>
            )}
      </ListCard>
      {editing ? <ObservationModal obs={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function ObservationModal({ obs, onClose }: { obs: AuditObservation | null; onClose: () => void }) {
  const a = useAudit();
  const ro = !a.editable;
  const [title, setTitle] = useState(obs?.title ?? '');
  const [description, setDescription] = useState(obs?.description ?? '');
  const [area, setArea] = useState(obs?.area ?? '');
  const [severity, setSeverity] = useState<Severity>(obs?.severity ?? 'medium');
  const [kind, setKind] = useState<ObsKind>(obs?.kind ?? 'query');
  const [amount, setAmount] = useState(paiseToRupeesText(obs?.amount_paise));
  const [adjusted, setAdjusted] = useState(obs?.adjusted === null || obs?.adjusted === undefined ? '' : obs.adjusted ? 'yes' : 'no');
  const [impact, setImpact] = useState<ReportImpact>(obs?.report_impact ?? 'none');
  const [status, setStatus] = useState<ObsStatus>(obs?.status ?? 'open');
  const [owner, setOwner] = useState(obs?.owner_id ?? '');
  const [due, setDue] = useState(obs?.due_date ?? '');
  const [mgmt, setMgmt] = useState(obs?.management_response ?? '');

  const amountPaise = rupeesToPaise(amount);
  const amountErr = amount.trim() && amountPaise === null ? 'Enter an amount in rupees.' : undefined;
  const body = () => a.w({
    title: title.trim(), description: description.trim(), area: area.trim() || null, severity, kind,
    amount_paise: amountPaise, adjusted: adjusted === '' ? null : adjusted === 'yes', report_impact: impact,
    owner_id: owner || null, due_date: due || null,
    ...(obs ? { status, management_response: mgmt.trim() || null } : {}),
  });
  const save = useAuditMutation(() => (obs ? auditApi.updateObservation(a.file.id, obs.id, body()) : auditApi.addObservation(a.file.id, body())),
    obs ? 'Observation updated.' : 'Observation added.', onClose);

  return (
    <Modal open title={obs ? `${obs.ref} · ${obs.title}` : 'Add observation'} onClose={onClose} width="w-[640px]"
      footer={ro ? <button type="button" className={smallBtn} onClick={onClose}>Close</button> : <>
        <button type="button" className={smallBtn} onClick={onClose}>Cancel</button>
        <button type="button" className={primaryBtn} disabled={!title.trim() || !description.trim() || Boolean(amountErr) || save.isPending} onClick={() => save.mutate()}>Save</button>
      </>}>
      <fieldset disabled={ro}>
        <Field label="Title"><input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></Field>
        <Field label="Description"><textarea className={textareaClass} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-3">
          <Field label="Area"><input className={inputClass} value={area} onChange={(e) => setArea(e.target.value)} /></Field>
          <Field label="Severity">
            <select className={inputClass} value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
              {SEVERITIES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
            </select>
          </Field>
          <Field label="Kind">
            <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as ObsKind)}>
              {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </Field>
          <Field label="Amount (₹)" error={amountErr}>
            <input className={`${inputClass} tabular-nums`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Adjusted?">
            <select className={inputClass} value={adjusted} onChange={(e) => setAdjusted(e.target.value)}>
              <option value="">—</option><option value="yes">Adjusted</option><option value="no">Unadjusted</option>
            </select>
          </Field>
          <Field label="Report impact">
            <select className={inputClass} value={impact} onChange={(e) => setImpact(e.target.value as ReportImpact)}>
              {IMPACTS.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
            </select>
          </Field>
          <Field label="Owner">
            <select className={inputClass} value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">—</option>
              {a.file.team.map((m) => <option key={m.employee_id} value={m.employee_id}>{m.employee_name ?? m.employee_id}</option>)}
            </select>
          </Field>
          <Field label="Due date"><input type="date" className={inputClass} value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          {obs ? (
            <Field label="Status">
              <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value as ObsStatus)}>
                {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </Field>
          ) : null}
        </div>
        {obs ? (
          <Field label="Management response"><textarea className={textareaClass} rows={3} value={mgmt} onChange={(e) => setMgmt(e.target.value)} /></Field>
        ) : null}
      </fieldset>
    </Modal>
  );
}
