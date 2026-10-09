import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MessageSquarePlus } from 'lucide-react';
import { Field, Modal, textareaClass } from '@/modules/workstation/components';
import { ListCard, ListEmpty, ListToolbar, Spacer, StatusPills } from '@/modules/workstation/listUi';
import { fmtDateTime } from '@/lib/format';
import { auditApi } from '@/modules/audit/api';
import { Chip, linkBtn, primaryBtn, smallBtn, useAudit, useAuditMutation, useMe } from '@/modules/audit/components';
import type { ReviewNote, WorkingPaper } from '@/modules/audit/types';
import { useSearchParams } from 'react-router-dom';

/**
 * Review notes — the reviewer's points. A note is answered by the preparer
 * and cleared by whoever raised it, the manager or the signing partner; a
 * working paper cannot be signed off as reviewed while any of its notes is
 * not cleared.
 */

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'responded', label: 'Responded' },
  { value: 'cleared', label: 'Cleared' },
];

export function ReviewNotesTab() {
  const a = useAudit();
  const me = useMe();
  const [status, setStatus] = useState('open');
  const [raising, setRaising] = useState(false);
  const [, setParams] = useSearchParams();
  const notes = useQuery({ queryKey: ['audits', a.file.id, 'notes'], queryFn: () => auditApi.notes(a.file.id) });
  const wps = useQuery({ queryKey: ['audits', a.file.id, 'wps'], queryFn: () => auditApi.workingPapers(a.file.id) });
  const all = notes.data ?? [];
  const shown = status ? all.filter((n) => n.status === status) : all;
  const counts = { open: all.filter((n) => n.status === 'open').length, responded: all.filter((n) => n.status === 'responded').length };
  const refOf = (n: ReviewNote) => n.working_paper_ref ?? wps.data?.find((w) => w.id === n.working_paper_id)?.ref ?? null;

  return (
    <div>
      <ListToolbar>
        <StatusPills options={FILTERS} value={status} onChange={setStatus} counts={counts} />
        <Spacer />
        {me.canReview && a.writable ? (
          <button type="button" className={primaryBtn} onClick={() => setRaising(true)}><MessageSquarePlus size={14} /> Raise a note</button>
        ) : null}
      </ListToolbar>
      <ListCard>
        {notes.isLoading ? <div className="p-5 text-13 text-neutral-500">Loading…</div>
          : notes.isError ? <div className="p-5 text-13 text-danger">Could not load the review notes.</div>
            : shown.length === 0 ? <ListEmpty>{status ? `No ${status} notes.` : 'No review notes on this file.'}</ListEmpty> : (
              <ul className="divide-y divide-neutral-100">
                {shown.map((n) => {
                  const ref = refOf(n);
                  return (
                    <li key={n.id} className="px-5 py-4">
                      {ref ? (
                        <button type="button" className={`${linkBtn} mb-1`} onClick={() => setParams((p) => { const x = new URLSearchParams(p); x.set('tab', 'papers'); x.set('wp', n.working_paper_id ?? ''); return x; })}>
                          {ref}
                        </button>
                      ) : <div className="text-12 text-neutral-500 mb-1">File-level note</div>}
                      <NoteItem n={n} />
                    </li>
                  );
                })}
              </ul>
            )}
      </ListCard>
      {raising ? <RaiseNoteModal papers={wps.data ?? []} onClose={() => setRaising(false)} /> : null}
    </div>
  );
}

/** One note with its response and the actions open to the caller. */
export function NoteItem({ n }: { n: ReviewNote }) {
  const a = useAudit();
  const me = useMe();
  const [reply, setReply] = useState('');
  const [replying, setReplying] = useState(false);
  const respond = useAuditMutation(() => auditApi.respondNote(a.file.id, n.id, a.w({ response: reply.trim() })), 'Response saved.', () => { setReply(''); setReplying(false); });
  const clear = useAuditMutation(() => auditApi.clearNote(a.file.id, n.id, a.w({})), 'Note cleared.');
  const mayClear = n.status !== 'cleared' && a.writable && me.canReview && (me.isMe(n.raised_by) || a.isLead);
  const mayRespond = n.status !== 'cleared' && a.editable; // editable = writable + manage

  return (
    <div className="text-13">
      <div className="flex items-start gap-2 flex-wrap">
        <p className="text-neutral-900 whitespace-pre-wrap flex-1 min-w-0">{n.note}</p>
        <Chip value={n.status} />
      </div>
      <div className="text-12 text-neutral-500 mt-1">Raised by {n.raised_by_name ?? '—'} · {fmtDateTime(n.raised_at)}</div>
      {n.response ? (
        <div className="mt-2 border-l-2 border-neutral-200 pl-3">
          <p className="text-neutral-800 whitespace-pre-wrap">{n.response}</p>
          <div className="text-12 text-neutral-500 mt-1">{n.responded_by_name ?? '—'}{n.responded_at ? ` · ${fmtDateTime(n.responded_at)}` : ''}</div>
        </div>
      ) : null}
      {n.cleared_at ? <div className="text-12 text-[#047857] mt-1">Cleared by {n.cleared_by_name ?? '—'} · {fmtDateTime(n.cleared_at)}</div> : null}
      {replying ? (
        <div className="mt-2">
          <textarea className={textareaClass} rows={3} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="What was done to address this point" autoFocus />
          <div className="flex gap-2 mt-2">
            <button type="button" className={primaryBtn} disabled={!reply.trim() || respond.isPending} onClick={() => respond.mutate()}>Save response</button>
            <button type="button" className={smallBtn} onClick={() => setReplying(false)}>Cancel</button>
          </div>
        </div>
      ) : (mayRespond || mayClear) ? (
        <div className="flex gap-3 mt-2">
          {mayRespond ? <button type="button" className={linkBtn} onClick={() => { setReply(n.response ?? ''); setReplying(true); }}>{n.response ? 'Edit response' : 'Respond'}</button> : null}
          {mayClear ? <button type="button" className={linkBtn} disabled={clear.isPending} onClick={() => clear.mutate()}>Clear</button> : null}
        </div>
      ) : null}
    </div>
  );
}

export function RaiseNoteModal({ papers, workingPaperId, onClose }: { papers: WorkingPaper[]; workingPaperId?: string; onClose: () => void }) {
  const a = useAudit();
  const [wp, setWp] = useState(workingPaperId ?? '');
  const [note, setNote] = useState('');
  const raise = useAuditMutation(() => auditApi.addNote(a.file.id, a.w({ working_paper_id: wp || undefined, note: note.trim() })), 'Review note raised.', onClose);
  return (
    <Modal open title="Raise a review note" onClose={onClose} width="w-[520px]"
      footer={<>
        <button type="button" className={smallBtn} onClick={onClose}>Cancel</button>
        <button type="button" className={primaryBtn} disabled={!note.trim() || raise.isPending} onClick={() => raise.mutate()}>Raise note</button>
      </>}>
      <Field label="Working paper">
        <select className="block w-full h-9 px-3 text-13 bg-white text-neutral-900 border border-neutral-200 rounded-lg focus:outline-none focus:border-primary/60"
          value={wp} onChange={(e) => setWp(e.target.value)} disabled={Boolean(workingPaperId)}>
          <option value="">The file as a whole</option>
          {papers.map((p) => <option key={p.id} value={p.id}>{p.ref} · {p.title}</option>)}
        </select>
      </Field>
      <Field label="Note">
        <textarea className={textareaClass} rows={4} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}
