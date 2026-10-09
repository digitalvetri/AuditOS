import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Lock, PenLine, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { Field, Modal, inputClass, textareaClass } from '@/modules/workstation/components';
import { fmtDay } from '@/modules/workstation/listUi';
import { workstationApi } from '@/modules/workstation/api';
import { useToast } from '@/components/Toast';
import { auditApi, udinError } from '@/modules/audit/api';
import {
  Chip, STATUS_FLOW, TEAM_ROLES, Why, daysUntil, errText, inr, label, linkBtn, paiseToRupeesText, primaryBtn,
  rupeesToPaise, smallBtn, useAudit, useMe,
} from '@/modules/audit/components';
import type { AuditFile, AuditStatus, Blocker, MaterialityBenchmark, OpinionType } from '@/modules/audit/types';

const card = 'dash-card p-5 min-w-0';

function useWrite<T>(fn: () => Promise<T>, done: string, after?: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => { toast.push('success', done); void qc.invalidateQueries({ queryKey: ['audits'] }); after?.(); },
    onError: (e) => toast.push('error', errText(e)),
  });
}

export function OverviewTab() {
  const { file: f } = useAudit();
  return (
    <div className="space-y-5">
      <Stepper f={f} />
      <ProgressCards f={f} />
      <div className="grid gap-5 grid-cols-1 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)]">
        <div className="space-y-5 min-w-0">
          <TeamCard f={f} />
          <MaterialityCard f={f} />
        </div>
        <div className="space-y-5 min-w-0">
          <SigningCard f={f} />
          <BlockersCard f={f} />
          <AcceptanceCard f={f} />
          <DetailsCard f={f} />
        </div>
      </div>
    </div>
  );
}

// ── Status stepper ────────────────────────────────────────────────────────

function Stepper({ f }: { f: AuditFile }) {
  const a = useAudit();
  const me = useMe();
  const at = STATUS_FLOW.indexOf(f.status);
  const signedAt = STATUS_FLOW.indexOf('signed');
  const qc = useQueryClient();
  const toast = useToast();
  const setStatus = useMutation({
    mutationFn: (status: AuditStatus) => auditApi.update(f.id, a.w({ status })),
    onSuccess: (_d, s) => { toast.push('success', `Moved to ${label(s)}.`); void qc.invalidateQueries({ queryKey: ['audits'] }); },
    onError: (e) => toast.push('error', errText(e)),
  });
  const canMove = me.canManage && !a.locked && at < signedAt;
  const prev = at > 0 && at < signedAt ? STATUS_FLOW[at - 1] : null;
  const next = at + 1 < signedAt ? STATUS_FLOW[at + 1] : null;

  return (
    <section className="dash-card px-5 py-4">
      <ol className="flex items-center gap-1 overflow-x-auto pb-1" aria-label="Audit stage">
        {STATUS_FLOW.map((s, i) => {
          const done = i < at;
          const cur = i === at;
          return (
            <li key={s} className="flex items-center gap-1 shrink-0">
              <span className={`inline-flex items-center gap-2 h-8 px-3 rounded-full text-13 whitespace-nowrap ${
                cur ? 'bg-primary text-white font-medium' : done ? 'bg-[#ecfdf5] text-[#047857]' : 'bg-neutral-100 text-neutral-500'}`}
                aria-current={cur ? 'step' : undefined}>
                {done ? <CheckCircle2 size={14} /> : <span className="tabular-nums text-12">{i + 1}</span>}
                {label(s)}
              </span>
              {i < STATUS_FLOW.length - 1 ? <span className="w-4 h-px bg-neutral-300" aria-hidden /> : null}
            </li>
          );
        })}
      </ol>
      {canMove && (prev || next) ? (
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          {prev ? <button type="button" className={smallBtn} disabled={setStatus.isPending} onClick={() => setStatus.mutate(prev)}>Back to {label(prev)}</button> : null}
          {next ? <button type="button" className={primaryBtn} disabled={setStatus.isPending} onClick={() => setStatus.mutate(next)}>Move to {label(next)}</button> : null}
          <span className="text-12 text-neutral-500">Signing moves the file to Signed; it is done from the Signing card.</span>
        </div>
      ) : null}
    </section>
  );
}

// ── Progress ──────────────────────────────────────────────────────────────

function ProgressCards({ f }: { f: AuditFile }) {
  const p = f.progress;
  const wp = p?.working_papers ?? { total: 0, prepared: 0, reviewed: 0 };
  const tiles: { label: string; value: ReactNode; sub: string; warn?: boolean; tab: string }[] = [
    { label: 'Working papers reviewed', value: `${wp.reviewed} / ${wp.total}`, sub: `${wp.prepared} prepared`, tab: 'papers' },
    { label: 'Review notes open', value: p?.review_notes_open ?? 0, sub: 'Must be cleared to sign', warn: (p?.review_notes_open ?? 0) > 0, tab: 'notes' },
    { label: 'Checklist items pending', value: p?.checklist_pending ?? 0, sub: 'Acceptance, CARO / 3CD, completion', warn: (p?.checklist_pending ?? 0) > 0, tab: 'checklists' },
    { label: 'Observations open', value: p?.observations_open ?? 0, sub: 'Queries and points with the client', tab: 'observations' },
    { label: 'Independence pending', value: p?.team_undeclared ?? 0, sub: 'Team members yet to declare', warn: (p?.team_undeclared ?? 0) > 0, tab: 'overview' },
  ];
  return (
    <section className="grid gap-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
      {tiles.map((t) => (
        <Link key={t.label} to={`?tab=${t.tab}`} className="dash-card dash-card-link p-4 min-w-0">
          <div className="text-12 text-neutral-500 truncate">{t.label}</div>
          <div className={`text-20 font-semibold tabular-nums mt-1 ${t.warn ? 'text-danger' : 'text-neutral-900'}`}>{t.value}</div>
          <div className="text-11 text-neutral-500 mt-1 truncate">{t.sub}</div>
          {t.label.startsWith('Working') ? (
            <div className="h-2 rounded-full bg-neutral-100 overflow-hidden mt-2">
              <div className="h-full rounded-full bg-primary" style={{ width: `${wp.total ? Math.round((wp.reviewed / wp.total) * 100) : 0}%` }} />
            </div>
          ) : null}
        </Link>
      ))}
    </section>
  );
}

// ── Team & independence ───────────────────────────────────────────────────

function TeamCard({ f }: { f: AuditFile }) {
  const a = useAudit();
  const me = useMe();
  const [adding, setAdding] = useState(false);
  const [declaring, setDeclaring] = useState(false);
  const mine = f.team.find((m) => me.isMe(m.employee_id));
  const qc = useQueryClient();
  const toast = useToast();
  const del = useMutation({
    mutationFn: (memberId: string) => auditApi.removeMember(f.id, memberId),
    onSuccess: () => { toast.push('success', 'Removed from the team.'); void qc.invalidateQueries({ queryKey: ['audits'] }); },
    onError: (e) => toast.push('error', errText(e)),
  });

  return (
    <section className={card}>
      <header className="flex items-center gap-3 mb-3 flex-wrap">
        <h2 className="text-15 font-semibold text-neutral-900">Engagement team</h2>
        <span className="text-12 text-neutral-500">Independence declared per member</span>
        <span className="flex-1" />
        {mine && !mine.independence_declared_at && a.editable ? (
          <button type="button" className={primaryBtn} onClick={() => setDeclaring(true)}><ShieldCheck size={14} /> Declare my independence</button>
        ) : null}
        {a.editable ? <button type="button" className={smallBtn} onClick={() => setAdding(true)}><UserPlus size={14} /> Add member</button> : null}
      </header>
      {f.team.length === 0 ? <p className="text-13 text-neutral-500">No one on the team yet.</p> : (
        <ul className="divide-y divide-neutral-100">
          {f.team.map((m) => {
            const isSigner = m.employee_id === f.signing_partner_id;
            return (
              <li key={m.id} className="py-2 flex items-center gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="text-13 font-semibold text-neutral-900 truncate">
                    {m.employee_name ?? 'Unknown'}{me.isMe(m.employee_id) ? <span className="font-normal text-neutral-500"> (you)</span> : null}
                  </div>
                  <div className="text-12 text-neutral-500">{TEAM_ROLES.find((r) => r.value === m.role)?.label ?? label(m.role)}{isSigner ? ' · signing partner' : ''}</div>
                </div>
                {m.independence_declared_at
                  ? <span className="text-12 text-[#047857] inline-flex items-center gap-1 whitespace-nowrap" title={m.independence_note ?? undefined}><CheckCircle2 size={14} /> Declared {fmtDay(m.independence_declared_at)}</span>
                  : <Chip value="pending" text="Not declared" tone="amber" />}
                {a.editable && !isSigner ? (
                  <button type="button" aria-label={`Remove ${m.employee_name ?? 'member'}`} className="h-8 w-8 inline-flex items-center justify-center text-neutral-400 hover:text-danger"
                    onClick={() => { if (window.confirm(`Remove ${m.employee_name ?? 'this member'} from the team?`)) del.mutate(m.id); }}>
                    <Trash2 size={14} />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {adding ? <AddMemberModal f={f} onClose={() => setAdding(false)} /> : null}
      {declaring ? <DeclareModal f={f} onClose={() => setDeclaring(false)} /> : null}
    </section>
  );
}

function AddMemberModal({ f, onClose }: { f: AuditFile; onClose: () => void }) {
  const a = useAudit();
  const [employeeId, setEmployeeId] = useState('');
  const [role, setRole] = useState('assistant');
  const staff = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees, staleTime: 120_000 });
  const taken = new Set(f.team.map((m) => m.employee_id));
  const add = useWrite(() => auditApi.addMember(f.id, a.w({ employee_id: employeeId, role })), 'Added to the team.', onClose);
  return (
    <Modal open title="Add team member" onClose={onClose} width="w-[460px]"
      footer={<>
        <button type="button" className={smallBtn} onClick={onClose}>Cancel</button>
        <button type="button" className={primaryBtn} disabled={!employeeId || add.isPending} onClick={() => add.mutate()}>Add</button>
      </>}>
      <Field label="Person">
        <select className={inputClass} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          <option value="">Select…</option>
          {(staff.data?.items ?? []).filter((p) => !taken.has(p.id)).map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.designation ? ` · ${p.designation}` : ''}</option>)}
        </select>
      </Field>
      <Field label="Role on this audit">
        <select className={inputClass} value={role} onChange={(e) => setRole(e.target.value)}>
          {TEAM_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </Field>
    </Modal>
  );
}

function DeclareModal({ f, onClose }: { f: AuditFile; onClose: () => void }) {
  const a = useAudit();
  const [note, setNote] = useState('');
  const go = useWrite(() => auditApi.declareIndependence(f.id, a.w({ note: note.trim() || undefined })), 'Independence declared.', onClose);
  return (
    <Modal open title="Declare independence" onClose={onClose} width="w-[520px]"
      footer={<>
        <button type="button" className={smallBtn} onClick={onClose}>Cancel</button>
        <button type="button" className={primaryBtn} disabled={go.isPending} onClick={() => go.mutate()}>I declare</button>
      </>}>
      <p className="text-13 text-neutral-700 mb-3">
        I confirm that I am independent of <strong>{f.client?.company_name ?? 'the client'}</strong> for FY {f.financial_year}
        in terms of the ICAI Code of Ethics: I hold no financial interest in, have no business or family relationship
        with, and am not indebted to the client or its management, and I will keep its information confidential.
      </p>
      <Field label="Note (optional)" hint="Anything to disclose, and how it was addressed.">
        <textarea className={textareaClass} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

// ── Acceptance ────────────────────────────────────────────────────────────

function AcceptanceCard({ f }: { f: AuditFile }) {
  const a = useAudit();
  const me = useMe();
  const approve = useWrite(() => auditApi.approveAcceptance(f.id, a.w({})), 'Client acceptance approved.');
  return (
    <section className={card}>
      <h2 className="text-15 font-semibold text-neutral-900 mb-2">Client acceptance (SQC 1)</h2>
      {f.acceptance_approved_at ? (
        <p className="text-13 text-[#047857] inline-flex items-center gap-1"><CheckCircle2 size={14} /> Approved {fmtDay(f.acceptance_approved_at)}{f.acceptance_approved_by_name ? ` by ${f.acceptance_approved_by_name}` : ''}</p>
      ) : (
        <p className="text-13 text-neutral-600">Not approved yet. Complete the acceptance checklist, then the signing partner approves it.</p>
      )}
      <div className="flex items-center gap-3 mt-3 flex-wrap">
        <Link to="?tab=checklists&cl=acceptance" className={linkBtn}>Open acceptance checklist</Link>
        {!f.acceptance_approved_at && a.isPartner && me.canReview ? (
          <button type="button" className={primaryBtn} disabled={approve.isPending || !a.writable} onClick={() => approve.mutate()}>Approve acceptance</button>
        ) : null}
      </div>
    </section>
  );
}

// ── Materiality (SA 320) ──────────────────────────────────────────────────

const BENCHMARKS: { value: MaterialityBenchmark; label: string }[] = [
  { value: 'profit_before_tax', label: 'Profit before tax' },
  { value: 'revenue', label: 'Revenue' },
  { value: 'total_assets', label: 'Total assets' },
  { value: 'equity', label: 'Equity' },
  { value: 'expenses', label: 'Total expenses' },
  { value: 'other', label: 'Other' },
];

const ratio = (part: number | null | undefined, whole: number | null | undefined) =>
  part && whole ? String(Math.round((part / whole) * 10000) / 100) : '';

function MaterialityCard({ f }: { f: AuditFile }) {
  const a = useAudit();
  const m = f.materiality;
  const [benchmark, setBenchmark] = useState<string>(m?.benchmark ?? 'profit_before_tax');
  const [base, setBase] = useState(paiseToRupeesText(m?.base_paise));
  const [pct, setPct] = useState(m?.percent ?? '5');
  const [perf, setPerf] = useState(String(m?.performance_percent ?? (ratio(m?.performance_paise, m?.overall_paise) || '75')));
  const [trivial, setTrivial] = useState(String(m?.trivial_percent ?? (ratio(m?.clearly_trivial_paise, m?.overall_paise) || '5')));
  const [rationale, setRationale] = useState(m?.rationale ?? '');

  useEffect(() => {
    setBenchmark(m?.benchmark ?? 'profit_before_tax');
    setBase(paiseToRupeesText(m?.base_paise));
    setPct(m?.percent ?? '5');
    setPerf(String(m?.performance_percent ?? (ratio(m?.performance_paise, m?.overall_paise) || '75')));
    setTrivial(String(m?.trivial_percent ?? (ratio(m?.clearly_trivial_paise, m?.overall_paise) || '5')));
    setRationale(m?.rationale ?? '');
  }, [m]);

  const basePaise = rupeesToPaise(base);
  const num = (s: string) => { const n = Number(s); return Number.isFinite(n) ? n : NaN; };
  const preview = useMemo(() => {
    if (basePaise === null || !(num(pct) > 0)) return null;
    const overall = Math.round((basePaise * num(pct)) / 100);
    return {
      overall,
      performance: Math.round((overall * (num(perf) || 0)) / 100),
      trivial: Math.round((overall * (num(trivial) || 0)) / 100),
    };
  }, [basePaise, pct, perf, trivial]);

  const err = basePaise === null ? 'Enter the benchmark amount in rupees.'
    : !(num(pct) > 0 && num(pct) <= 100) ? 'Percentage between 0 and 100.'
      : !(num(perf) > 0 && num(perf) <= 100) ? 'Performance materiality % between 0 and 100.'
        : !(num(trivial) >= 0 && num(trivial) <= 100) ? 'Clearly-trivial % between 0 and 100.' : null;

  const save = useWrite(() => auditApi.materiality(f.id, a.w({
    benchmark, base_paise: basePaise, percent: pct.trim(), performance_percent: num(perf), trivial_percent: num(trivial),
    rationale: rationale.trim() || null,
  })), 'Materiality saved.');

  const ro = !a.editable;
  return (
    <section className={card}>
      <header className="flex items-center gap-3 mb-3 flex-wrap">
        <h2 className="text-15 font-semibold text-neutral-900">Materiality (SA 320)</h2>
        <span className="flex-1" />
        {m?.overall_paise ? <span className="text-12 text-neutral-500">Saved: overall {inr(m.overall_paise)}</span> : null}
      </header>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
        <Field label="Benchmark">
          <select className={inputClass} value={benchmark} disabled={ro} onChange={(e) => setBenchmark(e.target.value)}>
            {BENCHMARKS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </Field>
        <Field label="Benchmark amount (₹)">
          <input className={`${inputClass} tabular-nums`} inputMode="decimal" value={base} disabled={ro} onChange={(e) => setBase(e.target.value)} placeholder="e.g. 2,50,00,000" />
        </Field>
        <Field label="Percentage applied (%)">
          <input className={`${inputClass} tabular-nums`} inputMode="decimal" value={pct} disabled={ro} onChange={(e) => setPct(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-x-3">
          <Field label="Performance (%)">
            <input className={`${inputClass} tabular-nums`} inputMode="decimal" value={perf} disabled={ro} onChange={(e) => setPerf(e.target.value)} />
          </Field>
          <Field label="Clearly trivial (%)">
            <input className={`${inputClass} tabular-nums`} inputMode="decimal" value={trivial} disabled={ro} onChange={(e) => setTrivial(e.target.value)} />
          </Field>
        </div>
      </div>
      <dl className="grid grid-cols-3 gap-3 rounded-lg bg-neutral-50 px-4 py-3 mb-3">
        <Figure label="Overall" value={preview ? inr(preview.overall) : inr(m?.overall_paise)} />
        <Figure label="Performance" value={preview ? inr(preview.performance) : inr(m?.performance_paise)} />
        <Figure label="Clearly trivial" value={preview ? inr(preview.trivial) : inr(m?.clearly_trivial_paise)} />
      </dl>
      <Field label="Rationale" hint="Why this benchmark and percentage suit the entity and its users.">
        <textarea className={textareaClass} rows={3} value={rationale} disabled={ro} onChange={(e) => setRationale(e.target.value)} />
      </Field>
      {!ro ? (
        <div className="flex items-center gap-3 flex-wrap">
          <Why reason={err}><button type="button" className={primaryBtn} disabled={Boolean(err) || save.isPending} onClick={() => save.mutate()}>Save materiality</button></Why>
          {err && base ? <span className="text-12 text-danger">{err}</span> : <span className="text-12 text-neutral-500">The server computes and stores the final figures.</span>}
        </div>
      ) : null}
    </section>
  );
}

const Figure = ({ label: l, value }: { label: string; value: string }) => (
  <div className="min-w-0">
    <dt className="text-11 uppercase tracking-[0.06em] text-neutral-500">{l}</dt>
    <dd className="text-14 font-semibold text-neutral-900 tabular-nums truncate">{value}</dd>
  </div>
);

// ── Blockers ──────────────────────────────────────────────────────────────

function BlockersCard({ f }: { f: AuditFile }) {
  if (f.report_date) return null;
  const list = f.blockers ?? [];
  return (
    <section className={card}>
      <h2 className="text-15 font-semibold text-neutral-900 mb-2">Blockers to signing</h2>
      {list.length === 0 ? (
        <p className="text-13 text-[#047857] inline-flex items-center gap-1"><CheckCircle2 size={14} /> Nothing stops signing.</p>
      ) : (
        <ul className="space-y-2">
          {list.map((b, i) => <BlockerItem key={b.code ?? i} b={b} />)}
        </ul>
      )}
    </section>
  );
}

/** Where a blocker is cleared from. */
const BLOCKER_TAB: Record<string, string> = {
  acceptance_not_approved: '?tab=checklists&cl=acceptance',
  working_papers_not_reviewed: '?tab=papers',
  review_notes_open: '?tab=notes',
  checklist_pending: '?tab=checklists',
};

function BlockerItem({ b }: { b: Blocker | string }) {
  const x: Blocker = typeof b === 'string' ? { code: '', message: b, count: 0, items: [] } : b;
  const to = BLOCKER_TAB[x.code] ?? (x.code.startsWith('checklist') ? '?tab=checklists' : null);
  return (
    <li className="flex items-start gap-2 text-13 text-neutral-800">
      <AlertTriangle size={14} className="text-warning mt-0.5 shrink-0" />
      <span className="min-w-0">
        {to ? <Link to={to} className="hover:underline">{x.message}</Link> : x.message}
        {x.items?.length ? <span className="block text-12 text-neutral-500 truncate" title={x.items.join(', ')}>{x.items.slice(0, 12).join(', ')}{x.items.length > 12 ? ` +${x.items.length - 12} more` : ''}</span> : null}
      </span>
    </li>
  );
}

// ── Signing & assembly ────────────────────────────────────────────────────

function SigningCard({ f }: { f: AuditFile }) {
  const a = useAudit();
  const me = useMe();
  const [signing, setSigning] = useState(false);
  const lock = useWrite(() => auditApi.lock(f.id, a.w({})), 'File locked. It is now read-only.');
  const left = daysUntil(f.assembly_due_date);
  const blocked = (f.blockers ?? []).length > 0;

  return (
    <section className={card}>
      <h2 className="text-15 font-semibold text-neutral-900 mb-3">Report &amp; assembly</h2>
      {!f.report_date ? (
        <>
          <dl className="text-13 grid grid-cols-[140px_minmax(0,1fr)] gap-y-1 mb-3">
            <dt className="text-neutral-500">Signing partner</dt><dd className="text-neutral-900">{f.signing_partner_name ?? '—'}{f.partner_membership_no ? ` (M.No. ${f.partner_membership_no})` : ''}</dd>
            <dt className="text-neutral-500">Planned report</dt><dd className="text-neutral-900">{fmtDay(f.planned_report_date)}</dd>
          </dl>
          {a.isPartner && me.canSign ? (
            <Why reason={blocked ? 'Clear the blockers to signing first.' : null}>
              <button type="button" className={primaryBtn} disabled={blocked || a.locked} onClick={() => setSigning(true)}><PenLine size={14} /> Sign report</button>
            </Why>
          ) : <p className="text-12 text-neutral-500">Only the signing partner signs the report.</p>}
        </>
      ) : (
        <>
          <dl className="text-13 grid grid-cols-[140px_minmax(0,1fr)] gap-y-1 mb-3">
            <dt className="text-neutral-500">Report date</dt><dd className="text-neutral-900">{fmtDay(f.report_date)}</dd>
            <dt className="text-neutral-500">Opinion</dt><dd className="text-neutral-900">{label(f.opinion_type)}</dd>
            <dt className="text-neutral-500">Place</dt><dd className="text-neutral-900">{f.report_place ?? '—'}</dd>
            <dt className="text-neutral-500">Assembly due</dt>
            <dd className="text-neutral-900">
              {fmtDay(f.assembly_due_date)}
              {!a.locked && left !== null ? (
                <span className={`ml-2 text-12 font-medium ${left < 0 ? 'text-danger' : left <= 15 ? 'text-warning' : 'text-neutral-500'}`}>
                  {left < 0 ? `${-left} day${left === -1 ? '' : 's'} overdue` : left === 0 ? 'due today' : `${left} day${left === 1 ? '' : 's'} left`}
                </span>
              ) : null}
            </dd>
          </dl>
          <p className="text-12 text-neutral-500 mb-3">
            SA 230 expects the final audit file to be assembled within 60 days of the date of the auditor’s report.
            Locking freezes it; later changes can only be recorded as addenda.
          </p>
          {a.locked ? (
            <p className="text-13 text-neutral-700 inline-flex items-center gap-1"><Lock size={14} /> Locked {f.locked_at ? fmtDay(f.locked_at) : ''}</p>
          ) : a.isLead && me.canSign ? (
            <button type="button" className={primaryBtn} disabled={lock.isPending}
              onClick={() => { if (window.confirm('Lock this audit file? After this, every change is an addendum.')) lock.mutate(); }}>
              <Lock size={14} /> Lock file
            </button>
          ) : <p className="text-12 text-neutral-500">The signing partner or manager locks the file.</p>}
        </>
      )}
      {signing ? <SignModal f={f} onClose={() => setSigning(false)} /> : null}
    </section>
  );
}

const OPINIONS: { value: OpinionType; label: string }[] = [
  { value: 'unmodified', label: 'Unmodified (SA 700)' },
  { value: 'qualified', label: 'Qualified (SA 705)' },
  { value: 'adverse', label: 'Adverse (SA 705)' },
  { value: 'disclaimer', label: 'Disclaimer of opinion (SA 705)' },
];

function SignModal({ f, onClose }: { f: AuditFile; onClose: () => void }) {
  const a = useAudit();
  const toast = useToast();
  const qc = useQueryClient();
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [opinion, setOpinion] = useState<OpinionType>('unmodified');
  const [place, setPlace] = useState('');
  const [udin, setUdin] = useState('');
  const [blockers, setBlockers] = useState<(Blocker | string)[]>([]);
  const uErr = udin ? udinError(udin, f.partner_membership_no ?? '') : null;
  const sign = useMutation({
    mutationFn: () => auditApi.sign(f.id, a.w({ report_date: date, opinion_type: opinion, report_place: place.trim(), udin: udin.trim() || undefined })),
    onSuccess: () => { toast.push('success', 'Report signed. The 60-day assembly clock has started.'); void qc.invalidateQueries({ queryKey: ['audits'] }); onClose(); },
    onError: (e) => {
      const d = (e as { details?: unknown }).details as { blockers?: (Blocker | string)[] } | (Blocker | string)[] | undefined;
      const list = Array.isArray(d) ? d : d?.blockers;
      if (list?.length) setBlockers(list);
      toast.push('error', errText(e));
    },
  });
  const ok = date && place.trim() && !uErr;
  return (
    <Modal open title="Sign the auditor's report" onClose={onClose} width="w-[520px]"
      footer={<>
        <button type="button" className={smallBtn} onClick={onClose}>Cancel</button>
        <button type="button" className={primaryBtn} disabled={!ok || sign.isPending} onClick={() => sign.mutate()}>Sign</button>
      </>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
        <Field label="Report date"><input type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Place of signature"><input className={inputClass} value={place} onChange={(e) => setPlace(e.target.value)} placeholder="e.g. Coimbatore" /></Field>
      </div>
      <Field label="Opinion">
        <select className={inputClass} value={opinion} onChange={(e) => setOpinion(e.target.value as OpinionType)}>
          {OPINIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      <Field label="UDIN (optional)" error={uErr ?? undefined} hint="Can also be added later in the UDIN register.">
        <input className={`${inputClass} font-mono tracking-[0.04em]`} maxLength={18} value={udin} onChange={(e) => setUdin(e.target.value.toUpperCase().replace(/\s/g, ''))} />
      </Field>
      {blockers.length ? (
        <div className="border-l-2 border-red pl-3 text-13">
          <div className="font-medium text-neutral-900 mb-1">Signing is blocked</div>
          <ul className="space-y-1">{blockers.map((b, i) => <BlockerItem key={i} b={b} />)}</ul>
        </div>
      ) : null}
    </Modal>
  );
}

// ── Engagement details ────────────────────────────────────────────────────

function DetailsCard({ f }: { f: AuditFile }) {
  const a = useAudit();
  const [editing, setEditing] = useState(false);
  return (
    <section className={card}>
      <header className="flex items-center gap-3 mb-2">
        <h2 className="text-15 font-semibold text-neutral-900">Engagement details</h2>
        <span className="flex-1" />
        {a.editable && !f.report_date ? <button type="button" className={linkBtn} onClick={() => setEditing(true)}>Edit</button> : null}
      </header>
      <dl className="text-13 grid grid-cols-[140px_minmax(0,1fr)] gap-y-1">
        <dt className="text-neutral-500">Manager</dt><dd className="text-neutral-900">{f.manager_name ?? '—'}</dd>
        <dt className="text-neutral-500">Planned start</dt><dd className="text-neutral-900">{fmtDay(f.planned_start_date)}</dd>
        <dt className="text-neutral-500">Engagement letter</dt>
        <dd className="text-neutral-900">{f.engagement_letter_id ? <Link className={linkBtn} to={`/workstation/engagement/${f.engagement_letter_id}/edit`}>Open letter</Link> : 'Not linked'}</dd>
      </dl>
      {editing ? <EditDetailsModal f={f} onClose={() => setEditing(false)} /> : null}
    </section>
  );
}

function EditDetailsModal({ f, onClose }: { f: AuditFile; onClose: () => void }) {
  const a = useAudit();
  const staff = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees, staleTime: 120_000 });
  const [title, setTitle] = useState(f.title);
  const [partner, setPartner] = useState(f.signing_partner_id ?? '');
  const [mno, setMno] = useState(f.partner_membership_no ?? '');
  const [manager, setManager] = useState(f.manager_id ?? '');
  const [start, setStart] = useState(f.planned_start_date ?? '');
  const [rep, setRep] = useState(f.planned_report_date ?? '');
  const save = useWrite(() => auditApi.update(f.id, a.w({
    title: title.trim(), signing_partner_id: partner || null, partner_membership_no: mno.trim() || null,
    manager_id: manager || null, planned_start_date: start || null, planned_report_date: rep || null,
  })), 'Details saved.', onClose);
  const people = staff.data?.items ?? [];
  const mErr = mno && !/^\d{1,6}$/.test(mno) ? 'A membership number is up to 6 digits.' : undefined;
  return (
    <Modal open title="Engagement details" onClose={onClose} width="w-[560px]"
      footer={<>
        <button type="button" className={smallBtn} onClick={onClose}>Cancel</button>
        <button type="button" className={primaryBtn} disabled={!title.trim() || Boolean(mErr) || save.isPending} onClick={() => save.mutate()}>Save</button>
      </>}>
      <Field label="Title"><input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
        <Field label="Signing partner">
          <select className={inputClass} value={partner} onChange={(e) => setPartner(e.target.value)}>
            <option value="">Not yet chosen</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        </Field>
        <Field label="Membership no." error={mErr}>
          <input className={inputClass} inputMode="numeric" maxLength={6} value={mno} onChange={(e) => setMno(e.target.value.replace(/\D/g, ''))} />
        </Field>
        <Field label="Manager">
          <select className={inputClass} value={manager} onChange={(e) => setManager(e.target.value)}>
            <option value="">None</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        </Field>
        <div />
        <Field label="Planned start"><input type="date" className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="Planned report date"><input type="date" className={inputClass} value={rep} onChange={(e) => setRep(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
