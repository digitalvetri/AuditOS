import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ListCard, ListEmpty, ListToolbar, Spacer, StatusPills, TogglePill } from '@/modules/workstation/listUi';
import { auditApi } from '@/modules/audit/api';
import { SignOff, Why, errText, linkBtn, useAudit, useAuditMutation, useMe } from '@/modules/audit/components';
import type { ChecklistAnswer, ChecklistItem, ChecklistTemplate } from '@/modules/audit/types';

/**
 * Checklists offered for this audit type — client acceptance and completion
 * on every file, CARO 2020 on a statutory audit, Form 3CD on a tax audit.
 * Templates are data on the server; this only reads them.
 */

const ANSWERS: { value: ChecklistAnswer; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'na', label: 'N/A' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'adverse', label: 'Adverse' },
];
const ANSWER_TINT: Record<ChecklistAnswer, string> = {
  pending: '#f1f5f9', yes: '#ecfdf5', no: '#fef2f2', na: '#f1f5f9', qualified: '#fffbeb', adverse: '#fef2f2',
};

const FALLBACK: { code: string; name: string; applies: string[] }[] = [
  { code: 'acceptance', name: 'Client acceptance', applies: ['*'] },
  { code: 'caro_2020', name: 'CARO 2020', applies: ['statutory'] },
  { code: 'form_3cd', name: 'Form 3CD', applies: ['tax'] },
  { code: 'completion', name: 'Completion', applies: ['*'] },
];
const ALWAYS = new Set(['acceptance', 'completion']);
const ORDER = ['acceptance', 'caro_2020', 'form_3cd', 'completion'];

export function ChecklistsTab() {
  const a = useAudit();
  const [params, setParams] = useSearchParams();
  const templates = useQuery({ queryKey: ['audits', 'checklist-templates'], queryFn: auditApi.templates, staleTime: 300_000 });

  const offered = useMemo(() => {
    const type = a.file.audit_type;
    const list: { code: string; name: string }[] = templates.data?.length
      ? templates.data
        .filter((t: ChecklistTemplate) => t.is_active !== false)
        .filter((t) => ALWAYS.has(t.code) || (Array.isArray(t.applies_to) ? t.applies_to : t.applies_to.split(',')).map((x) => x.trim()).some((x) => x === type || x === '*' || x === 'all'))
        .map((t) => ({ code: t.code, name: t.name }))
      : FALLBACK.filter((t) => t.applies.includes('*') || t.applies.includes(type));
    const rank = (c: string) => { const i = ORDER.indexOf(c); return i < 0 ? ORDER.length - 0.5 : i; };
    return list.sort((x, y) => rank(x.code) - rank(y.code));
  }, [templates.data, a.file.audit_type]);

  const code = offered.some((t) => t.code === params.get('cl')) ? params.get('cl')! : offered[0]?.code ?? 'acceptance';
  const setCode = (c: string) => setParams((p) => { const n = new URLSearchParams(p); n.set('cl', c); return n; }, { replace: true });

  return (
    <div>
      <div className="mb-3">
        <StatusPills options={offered.map((t) => ({ value: t.code, label: t.name }))} value={code} onChange={setCode} />
      </div>
      <ChecklistView key={code} code={code} />
    </div>
  );
}

function ChecklistView({ code }: { code: string }) {
  const a = useAudit();
  const [pendingOnly, setPendingOnly] = useState(false);
  const q = useQuery({ queryKey: ['audits', a.file.id, 'checklist', code], queryFn: () => auditApi.checklist(a.file.id, code) });
  const items = q.data?.items ?? [];
  const shown = pendingOnly ? items.filter((i) => i.answer === 'pending') : items;
  const c = q.data?.counts;
  const pending = c?.pending ?? items.filter((i) => i.answer === 'pending').length;
  const reviewed = c?.reviewed ?? items.filter((i) => i.reviewed_at).length;
  const total = c?.total ?? items.length;

  return (
    <>
      <ListToolbar>
        <span className="text-13 text-neutral-600">
          <strong className="text-neutral-900 tabular-nums">{total - pending}</strong> of {total} answered
          {' · '}<strong className="text-neutral-900 tabular-nums">{reviewed}</strong> reviewed
          {pending ? <> · <span className="text-danger tabular-nums">{pending} pending</span></> : null}
        </span>
        <Spacer />
        <TogglePill on={pendingOnly} onChange={setPendingOnly}>Pending only</TogglePill>
      </ListToolbar>
      {q.data?.template?.source || q.data?.template?.description ? (
        <p className="text-12 text-neutral-500 mb-3">{q.data.template.description}{q.data.template.source ? ` Source: ${q.data.template.source}.` : ''} Headings are short descriptions; read the Order / form for the exact wording.</p>
      ) : null}
      <ListCard>
        {q.isLoading ? <div className="p-5 text-13 text-neutral-500">Loading…</div>
          : q.isError ? <div className="p-5 text-13 text-danger">{errText(q.error)}</div>
            : shown.length === 0 ? <ListEmpty>{pendingOnly ? 'Nothing pending.' : 'This checklist has no items.'}</ListEmpty> : (
              <ul className="divide-y divide-neutral-100">
                {shown.map((it) => <ItemRow key={it.clause} code={code} it={it} />)}
              </ul>
            )}
      </ListCard>
    </>
  );
}

const cellInput = 'block w-full h-8 px-2 text-13 bg-white text-neutral-900 border border-neutral-200 rounded focus:outline-none focus:border-primary/60 disabled:bg-neutral-50 disabled:text-neutral-600';

function ItemRow({ code, it }: { code: string; it: ChecklistItem }) {
  const a = useAudit();
  const me = useMe();
  const [remarks, setRemarks] = useState(it.remarks ?? '');
  const [wpRef, setWpRef] = useState(it.working_paper_ref ?? '');
  useEffect(() => { setRemarks(it.remarks ?? ''); setWpRef(it.working_paper_ref ?? ''); }, [it.remarks, it.working_paper_ref]);

  const save = useAuditMutation(
    (v: { answer: ChecklistAnswer; remarks: string; working_paper_ref: string }) =>
      auditApi.answer(a.file.id, code, it.clause, a.w({ answer: v.answer, remarks: v.remarks.trim() || null, working_paper_ref: v.working_paper_ref.trim() || null })),
    `${it.clause} saved.`,
  );
  const review = useAuditMutation(() => auditApi.reviewItem(a.file.id, code, it.clause, a.w({})), `${it.clause} reviewed.`);

  const ro = !a.editable || Boolean(it.reviewed_at);
  const commit = (answer: ChecklistAnswer = it.answer) => {
    if (answer === it.answer && remarks === (it.remarks ?? '') && wpRef === (it.working_paper_ref ?? '')) return;
    save.mutate({ answer, remarks, working_paper_ref: wpRef });
  };
  const reviewWhy = !it.prepared_at ? 'Answer the item first.'
    : it.answer === 'pending' ? 'Still pending.'
      : me.isMe(it.prepared_by) ? 'You prepared this item; a different person must review it.' : null;

  return (
    <li className="px-5 py-3 grid gap-3 grid-cols-1 lg:grid-cols-[88px_minmax(0,1.3fr)_128px_minmax(0,1.2fr)_96px_minmax(0,0.9fr)] lg:items-center">
      <div className="text-13 font-semibold text-neutral-900 tracking-[0.02em]">{it.clause}</div>
      <div className="text-13 text-neutral-800 min-w-0" title={it.guidance ?? undefined}>
        {it.heading}
        {it.guidance ? <div className="text-11 text-neutral-500 mt-0.5 line-clamp-2">{it.guidance}</div> : null}
      </div>
      <select aria-label={`Answer for ${it.clause}`} className={cellInput} style={{ background: ANSWER_TINT[it.answer] }}
        value={it.answer} disabled={ro || save.isPending} onChange={(e) => commit(e.target.value as ChecklistAnswer)}>
        {ANSWERS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
      </select>
      <input aria-label={`Remarks for ${it.clause}`} className={cellInput} placeholder="Remarks / reporting text" value={remarks} disabled={ro}
        onChange={(e) => setRemarks(e.target.value)} onBlur={() => commit()} />
      <input aria-label={`Working paper for ${it.clause}`} className={cellInput} placeholder="WP ref" value={wpRef} disabled={ro}
        onChange={(e) => setWpRef(e.target.value)} onBlur={() => commit()} />
      <div className="flex items-center gap-3 text-12 flex-wrap">
        <span title="Prepared"><span className="text-neutral-400">P </span><SignOff who={it.prepared_by_name} at={it.prepared_at} /></span>
        {it.reviewed_at ? (
          <span title="Reviewed"><span className="text-neutral-400">R </span><SignOff who={it.reviewed_by_name} at={it.reviewed_at} /></span>
        ) : me.canReview && a.writable ? (
          <Why reason={reviewWhy}>
            <button type="button" className={linkBtn} disabled={Boolean(reviewWhy) || review.isPending} onClick={() => review.mutate()}>Review</button>
          </Why>
        ) : null}
      </div>
    </li>
  );
}
