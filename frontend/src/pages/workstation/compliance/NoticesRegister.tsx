import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileText, Pencil, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/Button';
import { inr } from '@/lib/format';
import { istToday } from '@/modules/dashboardV2/brief';
import { Modal, QueryState, fieldErrors } from '@/modules/workstation/components';
import {
  FilterSelect, ListAction, ListCard, ListEmpty, ListHeader, ListRow, ListTable, ListToolbar, SearchBox, TD,
  TogglePill, TwoLine,
} from '@/modules/workstation/listUi';
import { AUTHORITY_LABEL, paiseToRupeesInput, rupeesToPaise, toPaise } from '@/modules/compliance/api';
import {
  Chip, DaysChip, Labelled, day, daysUntil, errorText, fieldClass, smallBtn, useAssignees, useClientOptions,
  type ChipTone,
} from '@/modules/compliance/ui';
import {
  COMMON_SECTIONS, NOTICE_AUTHORITIES, NOTICE_STATUSES, NOTICE_STATUS_LABEL, gstNoticePage, noticesRegisterApi,
  noticesRegisterKeys, type NoticePatch, type RegisterNotice,
} from '@/modules/noticesRegister/api';

const isGst = (n: RegisterNotice) => n.source === 'gst' || (n.source === undefined && n.authority === 'gst' && !!n.kind);
const isClosed = (n: RegisterNotice) => n.status === 'closed';
/** Days to the reply deadline while a reply is still owed; null once replied / closed. */
const noticeDays = (n: RegisterNotice, today: string): number | null =>
  'days_left' in n ? n.days_left ?? null : (isClosed(n) ? null : daysUntil(n.response_due_date, today));

const STATUS_TONE: Record<string, ChipTone> = {
  received: 'amber', in_progress: 'blue', replied: 'green', hearing: 'amber', order_received: 'blue',
  appeal: 'amber', closed: 'grey', draft: 'grey', review: 'blue', sent: 'green',
};

/**
 * Notices register — income-tax, MCA and other notices, with GST notices
 * merged in, in one list ordered by reply deadline.
 */
export function NoticesRegisterPage() {
  const { session } = useAuth();
  const role = session?.role.code;
  const canManage = can(role, 'workstation.notice.manage', 'self');
  const canRead = canManage || can(role, 'workstation.notice.read', 'self');
  const me = session?.employee?.id ?? null;
  const qc = useQueryClient();
  const toast = useToast();
  const today = istToday();

  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const set = (k: string, v: string | boolean) => {
    const next = new URLSearchParams(params);
    if (v === '' || v === false) next.delete(k); else next.set(k, v === true ? '1' : v);
    setParams(next, { replace: true });
  };
  const dueWithin = Number(get('due')) || 0;
  const showClosed = get('closed') === '1';
  const [q, setQ] = useState('');

  const filters = {
    client_id: get('client') || undefined,
    authority: get('authority') || undefined,
    status: get('status') || undefined,
    assigned_to: get('assignee') || undefined,
  };
  const mine = get('mine') === '1';
  const list = useQuery({ queryKey: noticesRegisterKeys.list(filters), queryFn: () => noticesRegisterApi.list(filters), enabled: canRead });
  const clients = useClientOptions(canRead);
  const assignees = useAssignees(canRead);

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<RegisterNotice | null>(null);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list.data ?? [])
      .filter((n) => showClosed || get('status') ? true : !isClosed(n))
      .filter((n) => !mine || (!!me && n.assigned_employee_id === me))
      .filter((n) => {
        if (!dueWithin) return true;
        const d = noticeDays(n, today);
        return d !== null && d <= dueWithin && !isClosed(n);
      })
      .filter((n) => !needle || [n.client_name, n.section, n.reference_no, n.din, n.kind].some((x) => (x ?? '').toLowerCase().includes(needle)))
      .sort((a, b) => (a.response_due_date ?? '9999').localeCompare(b.response_due_date ?? '9999'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, q, showClosed, dueWithin, mine, me, params]);

  const remove = useMutation({
    mutationFn: (id: string) => noticesRegisterApi.remove(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: noticesRegisterKeys.all }); toast.push('success', 'Notice removed'); },
    onError: (e) => toast.push('error', errorText(e)),
  });
  const patch = useMutation({
    mutationFn: (v: { n: RegisterNotice; body: NoticePatch }) => noticesRegisterApi.update(v.n.id, v.body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: noticesRegisterKeys.all }); toast.push('success', 'Saved'); },
    onError: (e) => toast.push('error', errorText(e)),
  });

  if (!canRead) {
    return <div className="max-w-[1400px]"><ListHeader title="Notices" /><ListCard><ListEmpty>You do not have access to the notices register.</ListEmpty></ListCard></div>;
  }

  return (
    <div className="max-w-[1400px]">
      <ListHeader
        title="Notices"
        meta="Income-tax, GST, MCA and other departmental notices with their reply deadlines."
        action={canManage ? <ListAction onClick={() => setAdding(true)} icon={<Plus size={15} />}>Add notice</ListAction> : undefined}
      />
      <ListToolbar>
        <SearchBox value={q} onChange={setQ} placeholder="Client, section, reference, DIN" />
        <FilterSelect label="Client" value={get('client')} onChange={(v) => set('client', v)} options={clients.options} />
        <FilterSelect label="Authority" value={get('authority')} onChange={(v) => set('authority', v)} options={NOTICE_AUTHORITIES} />
        <FilterSelect label="Status" value={get('status')} onChange={(v) => set('status', v)}
          options={NOTICE_STATUSES.map((s) => ({ value: s, label: NOTICE_STATUS_LABEL[s] }))} />
        <FilterSelect label="Assignee" value={get('assignee')} onChange={(v) => set('assignee', v)} options={assignees.options} />
        <TogglePill on={get('mine') === '1'} onChange={(v) => set('mine', v)}>Mine</TogglePill>
        <TogglePill on={dueWithin === 7} onChange={(v) => set('due', v ? '7' : '')}>Reply due ≤ 7 days</TogglePill>
        <TogglePill on={showClosed} onChange={(v) => set('closed', v)}>Show closed</TogglePill>
      </ListToolbar>

      <QueryState query={list}>
        {() => rows.length ? (
          <ListCard>
            <ListTable cols={['Client', 'Notice', 'Notice date', 'Reply due', 'Status', 'Assignee', { label: 'Demand', align: 'right' }, '']}>
              {rows.map((n) => {
                const gst = isGst(n);
                const days = noticeDays(n, today);
                const demand = toPaise(n.demand_paise);
                const assignee = n.assigned_employee_name ?? assignees.nameOf(n.assigned_employee_id);
                const nextStatuses = forwardStatuses(n.status, canManage);
                return (
                  <ListRow key={`${n.source ?? 'n'}:${n.id}`}>
                    <TD first><TwoLine top={n.client_name ?? '—'} sub={n.assessment_year ? `AY ${n.assessment_year}` : undefined} /></TD>
                    <TD>
                      <TwoLine
                        top={<>{n.section || n.kind || '—'} <span className="text-11 font-normal text-neutral-500">· {AUTHORITY_LABEL[n.authority] ?? n.authority}</span></>}
                        sub={[n.reference_no, n.din ? `DIN ${n.din}` : null].filter(Boolean).join(' · ') || undefined} />
                    </TD>
                    <TD nowrap muted>{day(n.notice_date)}</TD>
                    <TD nowrap>
                      {n.response_due_date ? (
                        <span className="flex flex-col gap-0.5 items-start">
                          <span>{day(n.response_due_date)}</span>
                          <DaysChip days={days} done={days === null} urgentAt={3} />
                        </span>
                      ) : <span className="text-neutral-400">Not set</span>}
                    </TD>
                    <TD>
                      {gst || !canManage || nextStatuses.length <= 1 ? (
                        <Chip tone={STATUS_TONE[n.status] ?? 'grey'}>{NOTICE_STATUS_LABEL[n.status] ?? n.status}</Chip>
                      ) : (
                        <select aria-label="Status" value={n.status}
                          onChange={(e) => { if (e.target.value !== n.status) patch.mutate({ n, body: { status: e.target.value } }); }}
                          className="h-8 px-2 text-13 bg-white border border-neutral-200 rounded-lg">
                          {nextStatuses.map((s) => <option key={s} value={s}>{s === n.status ? NOTICE_STATUS_LABEL[s] : `→ ${NOTICE_STATUS_LABEL[s]}`}</option>)}
                        </select>
                      )}
                    </TD>
                    <TD muted>{assignee ?? '—'}</TD>
                    <TD right nowrap>{demand ? inr(demand) : <span className="text-neutral-400">—</span>}</TD>
                    <TD last>
                      <div className="flex items-center justify-end gap-1 flex-wrap">
                        {gst ? (
                          <Link to={gstNoticePage(n.client_id)} className={smallBtn} title="Open the GST notice and its drafted reply">
                            Draft reply <ExternalLink size={13} />
                          </Link>
                        ) : n.has_file || n.file_name ? (
                          <a href={noticesRegisterApi.fileUrl(n.id)} target="_blank" rel="noopener noreferrer" className={smallBtn} title={n.file_name ?? 'Notice file'}>
                            <FileText size={13} /> File
                          </a>
                        ) : null}
                        {canManage ? (
                          <button type="button" className={smallBtn} onClick={() => setEditing(n)}>
                            <Pencil size={13} /> {gst ? 'Reply due' : 'Edit'}
                          </button>
                        ) : null}
                        {canManage && !gst ? (
                          <button type="button" className={smallBtn} aria-label="Delete notice" disabled={remove.isPending}
                            onClick={() => { if (window.confirm('Remove this notice from the register?')) remove.mutate(n.id); }}>
                            <Trash2 size={13} />
                          </button>
                        ) : null}
                      </div>
                    </TD>
                  </ListRow>
                );
              })}
            </ListTable>
          </ListCard>
        ) : <ListCard><ListEmpty>No notices{dueWithin ? ` with a reply due in the next ${dueWithin} days` : ''}.</ListEmpty></ListCard>}
      </QueryState>

      {adding ? <AddNotice clients={clients.options} assignees={assignees.options} onClose={() => setAdding(false)} /> : null}
      {editing ? (
        isGst(editing)
          ? <GstNoticeEdit notice={editing} assignees={assignees.options} onClose={() => setEditing(null)} />
          : <EditNotice notice={editing} assignees={assignees.options} canManage={canManage} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
}

/** Current status plus the ones after it; a closed notice may be reopened by a manager. */
function forwardStatuses(current: string, canManage: boolean): string[] {
  const i = NOTICE_STATUSES.indexOf(current as (typeof NOTICE_STATUSES)[number]);
  if (i < 0) return [current];
  const ahead: string[] = NOTICE_STATUSES.slice(i);
  if (current === 'closed' && canManage) return ['closed', 'in_progress'];
  return ahead;
}

type Opt = { value: string; label: string };

function AddNotice({ clients, assignees, onClose }: { clients: Opt[]; assignees: Opt[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    client_id: '', authority: 'income_tax', section: '', section_other: '', reference_no: '', din: '',
    notice_date: istToday(), assessment_year: '', response_due_date: '', hearing_date: '', demand: '',
    assigned_employee_id: '', summary: '',
  });
  const [file, setFile] = useState<File | null>(null);
  const up = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const sections = COMMON_SECTIONS[f.authority] ?? [];
  const section = f.section === '__other' || !sections.length ? f.section_other.trim() : f.section;

  const save = useMutation({
    mutationFn: () => {
      const form = new FormData();
      const put = (k: string, v: string | null | undefined) => { if (v) form.append(k, v); };
      put('client_id', f.client_id);
      put('authority', f.authority);
      put('section', section);
      put('reference_no', f.reference_no.trim());
      put('din', f.din.trim());
      put('notice_date', f.notice_date);
      put('assessment_year', f.assessment_year.trim());
      put('response_due_date', f.response_due_date);
      put('hearing_date', f.hearing_date);
      const demand = rupeesToPaise(f.demand);
      if (demand !== null) form.append('demand_paise', String(demand));
      put('assigned_employee_id', f.assigned_employee_id);
      put('summary', f.summary.trim());
      if (file) form.append('file', file);
      return noticesRegisterApi.create(form);
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: noticesRegisterKeys.all }); toast.push('success', 'Notice added'); onClose(); },
    onError: (e) => toast.push('error', errorText(e)),
  });
  const errs = fieldErrors(save.error);
  const ok = f.client_id && section && f.notice_date;

  return (
    <Modal open title="Add notice" onClose={onClose} width="w-[680px]"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!ok || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Add notice'}</Button>
      </>}>
      {f.authority === 'gst' ? (
        <p className="mb-3 border-l-2 border-amber pl-3 text-13 text-neutral-600">
          GST notices with a drafted reply are uploaded on the client's GST page; record one here only if it is outside that flow.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Labelled label="Client" hint={errs.client_id}>
          <select className={fieldClass} value={f.client_id} onChange={up('client_id')}>
            <option value="">Choose…</option>
            {clients.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </Labelled>
        <Labelled label="Authority">
          <select className={fieldClass} value={f.authority} onChange={(e) => setF((s) => ({ ...s, authority: e.target.value, section: '' }))}>
            {NOTICE_AUTHORITIES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </Labelled>
        <Labelled label="Section" hint={errs.section}>
          {sections.length ? (
            <select className={fieldClass} value={f.section} onChange={up('section')}>
              <option value="">Choose…</option>
              {sections.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              <option value="__other">Other…</option>
            </select>
          ) : (
            <input className={fieldClass} value={f.section_other} onChange={up('section_other')} placeholder="Section / notice type" />
          )}
        </Labelled>
        {sections.length && f.section === '__other' ? (
          <Labelled label="Other section">
            <input className={fieldClass} value={f.section_other} onChange={up('section_other')} placeholder="e.g. 133(6)" />
          </Labelled>
        ) : (
          <Labelled label="Assessment year">
            <input className={fieldClass} value={f.assessment_year} onChange={up('assessment_year')} placeholder="2025-26" />
          </Labelled>
        )}
        <Labelled label="Reference no.">
          <input className={fieldClass} value={f.reference_no} onChange={up('reference_no')} />
        </Labelled>
        <Labelled label="DIN">
          <input className={fieldClass} value={f.din} onChange={up('din')} placeholder="ITBA/…" />
        </Labelled>
        <Labelled label="Notice date" hint={errs.notice_date}>
          <input type="date" className={fieldClass} value={f.notice_date} onChange={up('notice_date')} />
        </Labelled>
        <Labelled label="Reply due by" hint={errs.response_due_date}>
          <input type="date" className={fieldClass} value={f.response_due_date} onChange={up('response_due_date')} />
        </Labelled>
        <Labelled label="Hearing date">
          <input type="date" className={fieldClass} value={f.hearing_date} onChange={up('hearing_date')} />
        </Labelled>
        <Labelled label="Demand (₹)">
          <input inputMode="decimal" className={fieldClass} value={f.demand} onChange={up('demand')} placeholder="0" />
        </Labelled>
        <Labelled label="Assignee">
          <select className={fieldClass} value={f.assigned_employee_id} onChange={up('assigned_employee_id')}>
            <option value="">Unassigned</option>
            {assignees.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </Labelled>
        <Labelled label="Notice file (PDF / image)">
          <input type="file" accept=".pdf,image/*" className="block w-full text-13 text-neutral-700"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Labelled>
        <Labelled label="Summary" className="sm:col-span-2">
          <textarea rows={3} className="block w-full px-3 py-2 text-13 bg-white text-neutral-900 border border-neutral-200 rounded-lg focus:outline-none focus:border-primary/60"
            value={f.summary} onChange={up('summary')} placeholder="What the department is asking for" />
        </Labelled>
      </div>
    </Modal>
  );
}

function EditNotice({ notice, assignees, canManage, onClose }: { notice: RegisterNotice; assignees: Opt[]; canManage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    status: notice.status,
    response_due_date: notice.response_due_date ?? '',
    hearing_date: notice.hearing_date ?? '',
    reply_filed_on: notice.reply_filed_on ?? '',
    reply_ack_no: notice.reply_ack_no ?? '',
    demand: paiseToRupeesInput(notice.demand_paise),
    assigned_employee_id: notice.assigned_employee_id ?? '',
    summary: notice.summary ?? '',
    outcome: notice.outcome ?? '',
  });
  const up = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => noticesRegisterApi.update(notice.id, {
      ...(f.status !== notice.status ? { status: f.status } : {}),
      response_due_date: f.response_due_date || null,
      hearing_date: f.hearing_date || null,
      reply_filed_on: f.reply_filed_on || null,
      reply_ack_no: f.reply_ack_no.trim() || null,
      demand_paise: rupeesToPaise(f.demand),
      assigned_employee_id: f.assigned_employee_id || null,
      summary: f.summary.trim() || null,
      outcome: f.outcome.trim() || null,
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: noticesRegisterKeys.all }); toast.push('success', 'Notice updated'); onClose(); },
    onError: (e) => toast.push('error', errorText(e)),
  });
  const errs = fieldErrors(save.error);
  return (
    <Modal open title={`${notice.section ?? 'Notice'} — ${notice.client_name ?? ''}`} onClose={onClose} width="w-[640px]"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>
      </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Labelled label="Status" hint={errs.status ?? 'Status moves forward only.'}>
          <select className={fieldClass} value={f.status} onChange={up('status')}>
            {forwardStatuses(notice.status, canManage).map((s) => <option key={s} value={s}>{NOTICE_STATUS_LABEL[s] ?? s}</option>)}
          </select>
        </Labelled>
        <Labelled label="Assignee">
          <select className={fieldClass} value={f.assigned_employee_id} onChange={up('assigned_employee_id')}>
            <option value="">Unassigned</option>
            {assignees.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </Labelled>
        <Labelled label="Reply due by" hint={errs.response_due_date}>
          <input type="date" className={fieldClass} value={f.response_due_date} onChange={up('response_due_date')} />
        </Labelled>
        <Labelled label="Hearing date">
          <input type="date" className={fieldClass} value={f.hearing_date} onChange={up('hearing_date')} />
        </Labelled>
        <Labelled label="Reply filed on">
          <input type="date" className={fieldClass} value={f.reply_filed_on} onChange={up('reply_filed_on')} />
        </Labelled>
        <Labelled label="Reply acknowledgement no.">
          <input className={fieldClass} value={f.reply_ack_no} onChange={up('reply_ack_no')} />
        </Labelled>
        <Labelled label="Demand (₹)">
          <input inputMode="decimal" className={fieldClass} value={f.demand} onChange={up('demand')} />
        </Labelled>
        <div />
        <Labelled label="Summary" className="sm:col-span-2">
          <textarea rows={2} className="block w-full px-3 py-2 text-13 bg-white border border-neutral-200 rounded-lg focus:outline-none focus:border-primary/60"
            value={f.summary} onChange={up('summary')} />
        </Labelled>
        <Labelled label="Outcome" className="sm:col-span-2">
          <textarea rows={2} className="block w-full px-3 py-2 text-13 bg-white border border-neutral-200 rounded-lg focus:outline-none focus:border-primary/60"
            value={f.outcome} onChange={up('outcome')} placeholder="Order passed, demand confirmed / dropped, appeal filed…" />
        </Labelled>
      </div>
    </Modal>
  );
}

function GstNoticeEdit({ notice, assignees, onClose }: { notice: RegisterNotice; assignees: Opt[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [due, setDue] = useState(notice.response_due_date ?? '');
  const [who, setWho] = useState(notice.assigned_employee_id ?? '');
  const save = useMutation({
    mutationFn: () => noticesRegisterApi.updateGst(notice.id, { response_due_date: due || null, assigned_employee_id: who || null }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: noticesRegisterKeys.all }); toast.push('success', 'Saved'); onClose(); },
    onError: (e) => toast.push('error', errorText(e)),
  });
  return (
    <Modal open title={`GST notice — ${notice.client_name ?? ''}`} onClose={onClose} width="w-[460px]"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>
      </>}>
      <p className="text-13 text-neutral-600 mb-3">
        {notice.section || notice.kind} · {notice.reference_no ?? 'no reference'}. The reply itself is drafted on the{' '}
        <Link to={gstNoticePage(notice.client_id)} className="text-primary underline">client's GST page</Link>.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Labelled label="Reply due by">
          <input type="date" className={fieldClass} value={due} onChange={(e) => setDue(e.target.value)} />
        </Labelled>
        <Labelled label="Assignee">
          <select className={fieldClass} value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Unassigned</option>
            {assignees.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </Labelled>
      </div>
    </Modal>
  );
}
