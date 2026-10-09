import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, FilePlus2, Paperclip, Trash2, Upload } from 'lucide-react';
import { Field, Modal, inputClass, textareaClass } from '@/modules/workstation/components';
import { ListCard, ListEmpty, ListRow, ListTable, ListToolbar, SearchBox, Spacer, TD, TogglePill } from '@/modules/workstation/listUi';
import { fmtDateTime } from '@/lib/format';
import { useToast } from '@/components/Toast';
import { auditApi, downloadBinary } from '@/modules/audit/api';
import {
  Chip, Drawer, SignOff, Why, errText, initials, linkBtn, primaryBtn, sectionTitle, smallBtn, useAudit,
  useAuditMutation, useMe,
} from '@/modules/audit/components';
import type { ReviewNote, WorkingPaper } from '@/modules/audit/types';
import { NoteItem, RaiseNoteModal } from './ReviewNotes';
import { confirmAction } from '@/components/ConfirmDialog';

/**
 * The working-paper index, grouped by its letter (A Planning … E Reporting,
 * T Tax), and a drawer per paper: what was done, what was found, the
 * evidence, the sign-offs and the reviewer's notes.
 */

const LETTER_NAME: Record<string, string> = {
  A: 'Planning', B: 'Controls', C: 'Execution', D: 'Completion', E: 'Reporting', T: 'Tax audit', P: 'Permanent file',
};
const SECTIONS = [
  { value: 'planning', letter: 'A', label: 'A · Planning' },
  { value: 'risk', letter: 'B', label: 'B · Risk and controls' },
  { value: 'execution', letter: 'C', label: 'C · Execution' },
  { value: 'completion', letter: 'D', label: 'D · Completion' },
  { value: 'reporting', letter: 'E', label: 'E · Reporting' },
  { value: 'permanent', letter: 'P', label: 'P · Permanent file' },
];
const letterOf = (ref: string) => /^[A-Za-z]+/.exec(ref)?.[0].toUpperCase() ?? '#';
/** 'C-10' after 'C-9', not after 'C-1'. */
const refCompare = (x: string, y: string) => x.localeCompare(y, 'en', { numeric: true });

const openNotesOf = (wp: WorkingPaper, notes: ReviewNote[]) =>
  wp.open_review_notes ?? notes.filter((n) => n.working_paper_id === wp.id && n.status !== 'cleared').length;

export function WorkingPapersTab() {
  const a = useAudit();
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [mineOnly, setMineOnly] = useState(false);
  const [adding, setAdding] = useState(false);
  const wps = useQuery({ queryKey: ['audits', a.file.id, 'wps'], queryFn: () => auditApi.workingPapers(a.file.id) });
  const notes = useQuery({ queryKey: ['audits', a.file.id, 'notes'], queryFn: () => auditApi.notes(a.file.id) });
  const noteList = useMemo(() => notes.data ?? [], [notes.data]);

  const openId = params.get('wp');
  const setOpen = (id: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (id) n.set('wp', id); else n.delete('wp'); return n; }, { replace: true });

  const groups = useMemo(() => {
    const t = q.trim().toLowerCase();
    const items = (wps.data ?? [])
      .filter((w) => !t || `${w.ref} ${w.title} ${w.area ?? ''}`.toLowerCase().includes(t))
      .filter((w) => !mineOnly || me.isMe(w.assigned_to))
      .sort((x, y) => refCompare(x.ref, y.ref));
    const map = new Map<string, WorkingPaper[]>();
    for (const w of items) {
      const k = letterOf(w.ref);
      map.set(k, [...(map.get(k) ?? []), w]);
    }
    return [...map.entries()].sort(([x], [y]) => x.localeCompare(y));
  }, [wps.data, q, mineOnly, me]);

  const open = wps.data?.find((w) => w.id === openId) ?? null;

  return (
    <div>
      <ListToolbar>
        <SearchBox value={q} onChange={setQ} placeholder="Ref, title or area" />
        {me.employeeId ? <TogglePill on={mineOnly} onChange={setMineOnly}>Assigned to me</TogglePill> : null}
        <Spacer />
        {a.addable ? <button type="button" className={primaryBtn} onClick={() => setAdding(true)}><FilePlus2 size={14} /> {a.locked ? 'Add working paper (addendum)' : 'Add working paper'}</button> : null}
      </ListToolbar>

      {wps.isLoading ? <ListCard><div className="p-5 text-13 text-neutral-500">Loading…</div></ListCard>
        : wps.isError ? <ListCard><div className="p-5 text-13 text-danger">{errText(wps.error)}</div></ListCard>
          : groups.length === 0 ? <ListCard><ListEmpty>{q || mineOnly ? 'Nothing matches.' : 'No working papers yet.'}</ListEmpty></ListCard> : (
            <div className="space-y-5">
              {groups.map(([letter, items]) => {
                const reviewed = items.filter((w) => w.status === 'reviewed').length;
                return (
                  <ListCard key={letter} title={<>{letter} · {LETTER_NAME[letter] ?? items[0]?.section ?? 'Other'} <span className="font-normal text-neutral-500">· {reviewed}/{items.length} reviewed</span></>}>
                    <ListTable plainHead cols={['Ref', 'Title', 'Assignee', 'Status', 'Prepared', 'Reviewed', { label: 'Files', align: 'right' }, { label: 'Open notes', align: 'right' }]}>
                      {items.map((w) => {
                        const on = openNotesOf(w, noteList);
                        return (
                          <ListRow key={w.id} onOpen={() => setOpen(w.id)}>
                            <TD first strong nowrap className="tracking-[0.02em]">{w.ref}</TD>
                            <TD>
                              <div className="font-medium text-neutral-900">{w.title}{w.is_addendum ? <span className="ml-2 text-11 text-warning font-medium">Addendum</span> : null}</div>
                              {w.area ? <div className="text-11 text-neutral-500">{w.area}</div> : null}
                            </TD>
                            <TD muted nowrap><span title={w.assigned_to_name ?? undefined}>{w.assigned_to_name ? `${initials(w.assigned_to_name)} · ${w.assigned_to_name.split(' ')[0]}` : '—'}</span></TD>
                            <TD><Chip value={w.status} /></TD>
                            <TD muted><SignOff who={w.prepared_by_name} at={w.prepared_at} /></TD>
                            <TD muted><SignOff who={w.reviewed_by_name} at={w.reviewed_at} /></TD>
                            <TD right muted className="tabular-nums">{w.files?.length ?? 0}</TD>
                            <TD last right className="tabular-nums">{on > 0 ? <span className="font-semibold text-danger">{on}</span> : <span className="text-neutral-400">0</span>}</TD>
                          </ListRow>
                        );
                      })}
                    </ListTable>
                  </ListCard>
                );
              })}
            </div>
          )}

      {open ? <PaperDrawer wp={open} notes={noteList.filter((n) => n.working_paper_id === open.id)} papers={wps.data ?? []} onClose={() => setOpen(null)} /> : null}
      {adding ? <AddPaperModal papers={wps.data ?? []} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

// ── Add ───────────────────────────────────────────────────────────────────

function AddPaperModal({ papers, onClose }: { papers: WorkingPaper[]; onClose: () => void }) {
  const a = useAudit();
  const [section, setSection] = useState('execution');
  const letter = section === 'execution' && a.file.audit_type === 'tax' ? 'T' : SECTIONS.find((s) => s.value === section)?.letter ?? 'C';
  const nextRef = useMemo(() => {
    const nums = papers.filter((p) => letterOf(p.ref) === letter).map((p) => Number(/-(\d+)/.exec(p.ref)?.[1] ?? 0));
    return `${letter}-${(nums.length ? Math.max(...nums) : 0) + 1}`;
  }, [papers, letter]);
  const [ref, setRef] = useState('');
  const [refTouched, setRefTouched] = useState(false);
  useEffect(() => { if (!refTouched) setRef(nextRef); }, [nextRef, refTouched]);
  const [title, setTitle] = useState('');
  const [area, setArea] = useState('');
  const [assignee, setAssignee] = useState('');
  const [objective, setObjective] = useState('');
  const taken = papers.some((p) => p.ref.toLowerCase() === ref.trim().toLowerCase());
  const add = useAuditMutation(() => auditApi.addWorkingPaper(a.file.id, a.w({
    ref: ref.trim(), section, area: area.trim() || undefined, title: title.trim(),
    objective: objective.trim() || undefined, assigned_to: assignee || undefined,
  })), `${ref.trim()} added.`, onClose);
  return (
    <Modal open title="Add working paper" onClose={onClose} width="w-[560px]"
      footer={<>
        <button type="button" className={smallBtn} onClick={onClose}>Cancel</button>
        <button type="button" className={primaryBtn} disabled={!ref.trim() || !title.trim() || taken || add.isPending} onClick={() => add.mutate()}>Add</button>
      </>}>
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_140px] gap-x-3">
        <Field label="Section">
          <select className={inputClass} value={section} onChange={(e) => setSection(e.target.value)}>
            {SECTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </Field>
        <Field label="Ref" error={taken ? 'Already used on this file.' : undefined}>
          <input className={inputClass} value={ref} onChange={(e) => { setRef(e.target.value); setRefTouched(true); }} />
        </Field>
      </div>
      <Field label="Title"><input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
        <Field label="Area (optional)"><input className={inputClass} value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Trade receivables" /></Field>
        <Field label="Assigned to">
          <select className={inputClass} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {a.file.team.map((m) => <option key={m.employee_id} value={m.employee_id}>{m.employee_name ?? m.employee_id}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Objective (optional)"><textarea className={textareaClass} rows={2} value={objective} onChange={(e) => setObjective(e.target.value)} /></Field>
    </Modal>
  );
}

// ── Drawer ────────────────────────────────────────────────────────────────

function PaperDrawer({ wp, notes, papers, onClose }: { wp: WorkingPaper; notes: ReviewNote[]; papers: WorkingPaper[]; onClose: () => void }) {
  const a = useAudit();
  const me = useMe();
  const toast = useToast();
  const [title, setTitle] = useState(wp.title);
  const [area, setArea] = useState(wp.area ?? '');
  const [assignee, setAssignee] = useState(wp.assigned_to ?? '');
  const [objective, setObjective] = useState(wp.objective ?? '');
  const [procedure, setProcedure] = useState(wp.procedure ?? '');
  const [conclusion, setConclusion] = useState(wp.conclusion ?? '');
  const [raising, setRaising] = useState(false);
  const [reopening, setReopening] = useState(false);
  // Reset only when the paper itself changes — not when an upload or a note
  // refetches the list and hands back a new object with the same text.
  useEffect(() => {
    setTitle(wp.title); setArea(wp.area ?? ''); setAssignee(wp.assigned_to ?? '');
    setObjective(wp.objective ?? ''); setProcedure(wp.procedure ?? ''); setConclusion(wp.conclusion ?? '');
  }, [wp.id, wp.title, wp.area, wp.assigned_to, wp.objective, wp.procedure, wp.conclusion]);

  const reviewed = wp.status === 'reviewed';
  const canEdit = a.editable && !reviewed;
  const dirty = title !== wp.title || area !== (wp.area ?? '') || assignee !== (wp.assigned_to ?? '')
    || objective !== (wp.objective ?? '') || procedure !== (wp.procedure ?? '') || conclusion !== (wp.conclusion ?? '');
  const openNotes = openNotesOf(wp, notes);

  const save = useAuditMutation(() => auditApi.updateWorkingPaper(a.file.id, wp.id, a.w({
    title: title.trim(), area: area.trim() || null, assigned_to: assignee || null,
    objective: objective.trim() || null, procedure: procedure.trim() || null, conclusion: conclusion.trim() || null,
  })), 'Working paper saved.');
  const prepare = useAuditMutation(() => auditApi.prepare(a.file.id, wp.id, a.w({})), `${wp.ref} signed off as prepared.`);
  const review = useAuditMutation(() => auditApi.review(a.file.id, wp.id, a.w({})), `${wp.ref} signed off as reviewed.`);

  const prepareWhy = !wp.conclusion?.trim() ? 'Write and save a conclusion first.' : dirty ? 'Save your changes first.' : null;
  const reviewWhy = me.isMe(wp.prepared_by) ? 'You prepared this paper; a different person must review it.'
    : openNotes > 0 ? `${openNotes} review note${openNotes === 1 ? ' is' : 's are'} not cleared.` : null;

  const fileInput = useRef<HTMLInputElement>(null);
  const upload = useAuditMutation((file: File) => auditApi.uploadFile(a.file.id, wp.id, file, a.w({})), (f) => `${f.name} uploaded.`);
  const del = useAuditMutation((fileId: string) => auditApi.deleteFile(a.file.id, wp.id, fileId), 'File removed.');
  const files = wp.files ?? [];

  return (
    <Drawer onClose={onClose}
      title={<>{wp.ref} · {wp.title}</>}
      sub={<span className="inline-flex items-center gap-2"><Chip value={wp.status} />{wp.is_addendum ? <span className="text-warning">Addendum{wp.addendum_reason ? ` — ${wp.addendum_reason}` : ''}</span> : null}</span>}
      footer={<>
        {canEdit && dirty ? <button type="button" className={smallBtn} disabled={save.isPending || !title.trim()} onClick={() => save.mutate()}>Save changes</button> : null}
        {a.editable && (wp.status === 'not_started' || wp.status === 'in_progress') ? (
          <Why reason={prepareWhy}><button type="button" className={primaryBtn} disabled={Boolean(prepareWhy) || prepare.isPending} onClick={() => prepare.mutate()}>Mark prepared</button></Why>
        ) : null}
        {wp.status === 'prepared' && me.canReview && a.writable ? (
          <Why reason={reviewWhy}><button type="button" className={primaryBtn} disabled={Boolean(reviewWhy) || review.isPending} onClick={() => review.mutate()}>Mark reviewed</button></Why>
        ) : null}
        {wp.status === 'reviewed' && (me.canReview || me.canManage) && a.writable ? (
          <button type="button" className={smallBtn} onClick={() => setReopening(true)}>Reopen</button>
        ) : null}
      </>}>
      <div className="space-y-5">
        <section className="grid grid-cols-2 gap-3 text-13">
          <div><div className={sectionTitle}>Prepared</div><SignOff who={wp.prepared_by_name} at={wp.prepared_at} />{wp.prepared_by_name ? <div className="text-12 text-neutral-500">{wp.prepared_by_name}</div> : null}</div>
          <div><div className={sectionTitle}>Reviewed</div><SignOff who={wp.reviewed_by_name} at={wp.reviewed_at} />{wp.reviewed_by_name ? <div className="text-12 text-neutral-500">{wp.reviewed_by_name}</div> : null}</div>
        </section>

        {reviewed && a.editable ? <p className="text-12 text-neutral-500 border-l-2 border-neutral-300 pl-3">Reviewed papers are frozen. Reopen it to change anything; that clears the review sign-off.</p> : null}

        <section>
          <Field label="Title"><input className={inputClass} value={title} disabled={!canEdit} onChange={(e) => setTitle(e.target.value)} /></Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
            <Field label="Area"><input className={inputClass} value={area} disabled={!canEdit} onChange={(e) => setArea(e.target.value)} /></Field>
            <Field label="Assigned to">
              <select className={inputClass} value={assignee} disabled={!canEdit} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Unassigned</option>
                {a.file.team.map((m) => <option key={m.employee_id} value={m.employee_id}>{m.employee_name ?? m.employee_id}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Objective"><textarea className={textareaClass} rows={3} value={objective} disabled={!canEdit} onChange={(e) => setObjective(e.target.value)} /></Field>
          <Field label="Procedure performed"><textarea className={textareaClass} rows={5} value={procedure} disabled={!canEdit} onChange={(e) => setProcedure(e.target.value)} /></Field>
          <Field label="Findings and conclusion" hint="Required before the paper can be marked prepared.">
            <textarea className={textareaClass} rows={4} value={conclusion} disabled={!canEdit} onChange={(e) => setConclusion(e.target.value)} />
          </Field>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-2">
            <h3 className={`${sectionTitle} mb-0 flex-1`}>Evidence ({files.length})</h3>
            {a.addable && (a.locked || !reviewed) ? (
              <>
                <input ref={fileInput} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
                <button type="button" className={smallBtn} disabled={upload.isPending} onClick={() => fileInput.current?.click()}>
                  <Upload size={14} /> {upload.isPending ? 'Uploading…' : 'Upload'}
                </button>
              </>
            ) : null}
          </div>
          {files.length === 0 ? <p className="text-13 text-neutral-500">No files attached.</p> : (
            <ul className="divide-y divide-neutral-100 border border-neutral-200 rounded-lg">
              {files.map((f) => (
                <li key={f.id} className="px-3 py-2 flex items-center gap-3">
                  <Paperclip size={14} className="text-neutral-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-13 text-neutral-900 truncate">{f.original_name}{f.is_addendum ? <span className="ml-2 text-11 text-warning">Addendum</span> : null}</div>
                    <div className="text-11 text-neutral-500 truncate">
                      {Math.max(1, Math.round(f.size_bytes / 1024))} KB · {fmtDateTime(f.uploaded_at)}
                      {' · '}<span className="font-mono" title={`SHA-256 ${f.sha256}`}>sha256 {f.sha256.slice(0, 12)}…</span>
                    </div>
                  </div>
                  <button type="button" aria-label={`Download ${f.original_name}`} className="h-8 w-8 inline-flex items-center justify-center text-neutral-500 hover:text-neutral-900"
                    onClick={() => downloadBinary(auditApi.fileUrl(a.file.id, wp.id, f.id), f.original_name).catch((e) => toast.push('error', errText(e)))}>
                    <Download size={14} />
                  </button>
                  {canEdit && !a.locked ? (
                    <button type="button" aria-label={`Remove ${f.original_name}`} className="h-8 w-8 inline-flex items-center justify-center text-neutral-400 hover:text-danger"
                      onClick={async () => { if (await confirmAction(`Remove ${f.original_name}? The record of it stays in the audit trail.`)) del.mutate(f.id); }}>
                      <Trash2 size={14} />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <div className="flex items-center gap-2 mb-2">
            <h3 className={`${sectionTitle} mb-0 flex-1`}>Review notes ({notes.length})</h3>
            {me.canReview && a.writable ? <button type="button" className={linkBtn} onClick={() => setRaising(true)}>Raise a note</button> : null}
          </div>
          {notes.length === 0 ? <p className="text-13 text-neutral-500">No review notes on this paper.</p> : (
            <ul className="space-y-4">{notes.map((n) => <li key={n.id}><NoteItem n={n} /></li>)}</ul>
          )}
        </section>
      </div>
      {raising ? <RaiseNoteModal papers={papers} workingPaperId={wp.id} onClose={() => setRaising(false)} /> : null}
      {reopening ? <ReopenModal wp={wp} onClose={() => setReopening(false)} /> : null}
    </Drawer>
  );
}

function ReopenModal({ wp, onClose }: { wp: WorkingPaper; onClose: () => void }) {
  const a = useAudit();
  const [reason, setReason] = useState('');
  const go = useAuditMutation(() => auditApi.reopen(a.file.id, wp.id, a.w({ reason: reason.trim() })), `${wp.ref} reopened.`, onClose);
  return (
    <Modal open title={`Reopen ${wp.ref}`} onClose={onClose} width="w-[480px]"
      footer={<>
        <button type="button" className={smallBtn} onClick={onClose}>Cancel</button>
        <button type="button" className={primaryBtn} disabled={!reason.trim() || go.isPending} onClick={() => go.mutate()}>Reopen</button>
      </>}>
      <p className="text-13 text-neutral-600 mb-3">Reopening clears the sign-offs so the paper can be changed. The reason is kept in the audit trail.</p>
      <Field label="Reason"><textarea className={textareaClass} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}
