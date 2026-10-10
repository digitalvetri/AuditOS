/**
 * /hrms/payroll — runs list + drill-in per §8.4.
 *
 * List: period, stage (left-border encoded), headcount, gross/deductions/net.
 * Detail: "show the working" — one row per employee with every component.
 * Actions gated on stage + permission (Calculate / Review / Approve / Process).
 */
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { payrollApi, STAGE_LABEL, type PayrollBlocker, type PayrollVariance } from '@/modules/payroll/api';
import { inr } from '@/lib/format';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { StatusLabel, type StatusVariant } from '@/components/StatusRow';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import type { PayrollRun, PayrollStage } from '@/data/models';

// ── List page ─────────────────────────────────────────────────────────────
export function PayrollPage() {
  const { session } = useAuth();
  const canRun = can(session?.role.code, 'payroll.run', 'organisation');
  const [creating, setCreating] = useState(false);

  const q = useQuery({
    queryKey: ['payroll', 'runs'],
    queryFn: payrollApi.runs.list,
    retry: false,
  });

  if (q.isError) {
    return (
      <div className="max-w-[720px] mx-auto bg-white border border-neutral-200 rounded p-6">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Access denied</div>
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-neutral-900">Payroll is HR / Finance / MD only.</h1>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {canRun ? (
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => setCreating(true)} data-testid="payroll-create-open">
            New run
          </Button>
        </div>
      ) : null}

      {creating ? <CreateRunForm onDone={() => setCreating(false)} /> : null}

      <div className="bg-white border border-neutral-200 rounded overflow-hidden" data-testid="payroll-runs">
        {q.isLoading ? (
          <div className="h-40 bg-neutral-100" aria-label="Loading" />
        ) : (q.data?.items.length ?? 0) === 0 ? (
          <div className="p-6 text-13 text-neutral-500">No payroll runs yet.</div>
        ) : (
          <table className="hr-float w-full border-collapse tabular-nums">
            <thead>
              <tr>
                {['Period', 'Stage', 'Headcount', 'Gross', 'Deductions', 'Net', ''].map((c) => (
                  <th key={c} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data!.items.map((r) => {
                const s = stageStyle(r.stage);
                const border =
                  s.variant === 'problem'
                    ? 'border-red'
                    : s.variant === 'pending'
                      ? 'border-amber'
                      : s.variant === 'awaiting'
                        ? 'border-neutral-400'
                        : 'border-transparent';
                return (
                  <tr key={r.id} className="border-b border-neutral-200" data-testid={`payroll-run-row-${r.id}`}>
                    <td className={`px-3 py-2 border-l-2 ${border}`}>
                      <div className="text-13 text-neutral-900">{r.period_start} → {r.period_end}</div>
                      <div className="text-11 text-neutral-500">{r.id}</div>
                    </td>
                    <td className="px-3 py-2"><StatusLabel variant={s.variant} label={s.label} /></td>
                    <td className="px-3 py-2 text-13 text-neutral-900">{r.headcount}</td>
                    <td className="px-3 py-2 text-13 text-neutral-900">{inr(r.gross_total_paise)}</td>
                    <td className="px-3 py-2 text-13 text-neutral-900">{inr(r.deductions_total_paise)}</td>
                    <td className="px-3 py-2 text-13 text-neutral-900 font-medium">{inr(r.net_total_paise)}</td>
                    <td className="px-3 py-2">
                      <Link to={`/hrms/accounts/payroll/runs/${r.id}`} className="text-13 text-gold hover:text-gold-hover">Open →</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function CreateRunForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  // Payroll periods are one calendar month. A month picker rules out the
  // 2026-12-30 → 2027-01-30 shape the previous two-date form allowed. The
  // server derives period_start/end from (year, month); the client never
  // sends dates.
  const today = new Date();
  const defaultMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const [month, setMonth] = useState(defaultMonth);
  const create = useMutation({
    mutationFn: () => {
      const [y, m] = month.split('-').map(Number);
      return payrollApi.runs.create(y, m);
    },
    onSuccess: (res) => {
      toast.push('success', `Run created for ${res.run.period_start} → ${res.run.period_end}.`);
      qc.invalidateQueries({ queryKey: ['payroll', 'runs'] });
      onDone();
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  // Restrict the month picker to the current month or earlier: the future
  // guard is enforced server-side, but blocking it in the UI cuts the
  // error round-trip.
  const maxMonth = defaultMonth;
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        create.mutate();
      }}
      className="bg-white border border-neutral-200 rounded p-4 flex items-end gap-3 flex-wrap"
    >
      <Input
        label="Pay month"
        type="month"
        value={month}
        max={maxMonth}
        onChange={(e) => setMonth(e.target.value)}
        required
        data-testid="payroll-create-month"
      />
      <Button
        variant="primary"
        type="submit"
        disabled={create.isPending || !/^\d{4}-\d{2}$/.test(month)}
        data-testid="payroll-create-submit"
      >
        Save
      </Button>
      <Button variant="ghost" type="button" onClick={onDone}>Cancel</Button>
    </form>
  );
}

function stageStyle(stage: PayrollStage): { variant: StatusVariant; label: string } {
  switch (stage) {
    case 'draft': return { variant: 'awaiting', label: STAGE_LABEL.draft };
    case 'hr_review': return { variant: 'pending', label: STAGE_LABEL.hr_review };
    case 'finance_review': return { variant: 'pending', label: STAGE_LABEL.finance_review };
    case 'approved': return { variant: 'pending', label: STAGE_LABEL.approved };
    case 'processed': return { variant: 'ok', label: STAGE_LABEL.processed };
  }
}

// ── Detail page ───────────────────────────────────────────────────────────
export function PayrollRunDetailPage() {
  const params = useParams<{ id: string }>();
  const runId = params.id!;
  const { session } = useAuth();
  const canRun = can(session?.role.code, 'payroll.run', 'organisation');
  const canReview = can(session?.role.code, 'payroll.review', 'organisation');
  const canApprove = can(session?.role.code, 'payroll.approve', 'organisation');
  const canProcess = can(session?.role.code, 'payroll.process', 'organisation');

  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['payroll', 'run', runId],
    queryFn: () => payrollApi.runs.get(runId),
    retry: false,
  });

  const mutate = (fn: (id: string) => Promise<unknown>, label: string) =>
    useMutation({
      mutationFn: () => fn(runId),
      onSuccess: () => {
        toast.push('success', `${label}.`);
        qc.invalidateQueries({ queryKey: ['payroll'] });
      },
      onError: (e: Error) => toast.push('error', e.message),
    });

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const calc = useMutation({
    mutationFn: () => payrollApi.runs.calculate(runId),
    onSuccess: () => {
      toast.push('success', 'Calculated.');
      qc.invalidateQueries({ queryKey: ['payroll'] });
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const review = useMutation({
    mutationFn: () => payrollApi.runs.review(runId),
    onSuccess: () => { toast.push('success', 'Advanced.'); qc.invalidateQueries({ queryKey: ['payroll'] }); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const approve = useMutation({
    mutationFn: () => payrollApi.runs.approve(runId),
    onSuccess: () => { toast.push('success', 'Approved.'); qc.invalidateQueries({ queryKey: ['payroll'] }); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const proc = useMutation({
    mutationFn: () => payrollApi.runs.process(runId),
    onSuccess: () => { toast.push('success', 'Processed — payslips published.'); qc.invalidateQueries({ queryKey: ['payroll'] }); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  void mutate;

  if (q.isLoading) return <div className="h-40 bg-neutral-100 " />;
  if (q.isError || !q.data) {
    return (
      <div className="max-w-[720px] mx-auto bg-white border border-neutral-200 rounded p-6">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Access denied</div>
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-neutral-900">You can't view this payroll run.</h1>
      </div>
    );
  }
  const { run, items, blockers, variance, can_process } = q.data;
  const s = stageStyle(run.stage);

  return (
    <div className="space-y-6">
      <div>
        <Link to="/hrms/accounts/payroll" className="text-13 text-neutral-500 hover:text-neutral-900">← Payroll</Link>
      </div>
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Payroll &amp; expenses › Payroll › {run.label}</div>
          <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-neutral-900">
            {run.label} · {run.period_start} → {run.period_end}
          </h1>
          <div className="mt-1"><StatusLabel variant={s.variant} label={s.label} /></div>
        </div>
        <StageActions
          run={run}
          canRun={canRun}
          canReview={canReview}
          canApprove={canApprove}
          canProcess={canProcess}
          canProcessBlocked={!can_process}
          blockerCount={blockers.length}
          onCalculate={() => calc.mutate()}
          onReview={() => review.mutate()}
          onApprove={() => approve.mutate()}
          onProcess={() => proc.mutate()}
          busy={calc.isPending || review.isPending || approve.isPending || proc.isPending}
        />
      </header>

      <KpiRow run={run} />

      {variance && Math.abs(variance.delta_paise) >= 100_000 ? (
        <VarianceBanner variance={variance} />
      ) : null}

      {items.length === 0 && blockers.length === 0 ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">
          No items — Calculate to populate.
        </div>
      ) : (
        <div className="bg-white border border-neutral-200 rounded overflow-x-auto">
          <table className="hr-float w-full border-collapse tabular-nums" data-testid="payroll-items">
            <thead>
              <tr>
                {[
                  'Employee', 'Days', 'Basic', 'HRA', 'Conv', 'Special', 'Gross',
                  'PF', 'ESI', 'PT', 'TDS', 'LOP', 'Total ded', 'Net',
                ].map((c) => (
                  <th key={c} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="border-b border-neutral-200" data-testid={`payroll-item-${i.employee_id}`}>
                  <td className="px-3 py-2">
                    <div className="text-13 text-neutral-900">{i.employee?.full_name ?? '—'}</div>
                    <div className="text-11 text-neutral-500">{i.employee?.employee_code}</div>
                  </td>
                  <td className="px-3 py-2 text-13 text-neutral-700">{i.present_days}/{i.payable_days}{i.lop_days ? ` · ${i.lop_days} LOP` : ''}</td>
                  <td className="px-3 py-2 text-13 text-neutral-900">{inr(i.earnings.basic_paise)}</td>
                  <td className="px-3 py-2 text-13 text-neutral-900">{inr(i.earnings.hra_paise)}</td>
                  <td className="px-3 py-2 text-13 text-neutral-900">{inr(i.earnings.conveyance_paise)}</td>
                  <td className="px-3 py-2 text-13 text-neutral-900">{inr(i.earnings.special_paise)}</td>
                  <td className="px-3 py-2 text-13 text-neutral-900 font-medium">{inr(i.gross_paise)}</td>
                  <td className="px-3 py-2 text-13 text-neutral-900">{inr(i.deductions.pf_employee_paise)}</td>
                  <td className="px-3 py-2 text-13 text-neutral-900">{inr(i.deductions.esi_employee_paise)}</td>
                  <td className="px-3 py-2 text-13 text-neutral-900">{inr(i.deductions.pt_paise)}</td>
                  <td className="px-3 py-2 text-13 text-neutral-900">{inr(i.deductions.tds_paise)}</td>
                  <td className={'px-3 py-2 text-13 ' + (i.deductions.lop_paise > 0 ? 'text-red font-medium' : 'text-neutral-900')}>{inr(i.deductions.lop_paise)}</td>
                  <td className="px-3 py-2 text-13 text-neutral-700">{inr(i.total_deductions_paise)}</td>
                  <td className="px-3 py-2 text-13 text-neutral-900 font-medium">{inr(i.net_paise)}</td>
                </tr>
              ))}
              {blockers.map((b) => (
                <BlockerRow key={b.employee?.id ?? b.message} blocker={b} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {run.statutory_snapshot ? (
        <div className="text-11 text-neutral-500">
          Statutory snapshot locked at calculate:{' '}
          {Object.keys(run.statutory_snapshot).length} rate codes captured.
        </div>
      ) : null}

    </div>
  );
}

function BlockerRow({ blocker }: { blocker: PayrollBlocker }) {
  return (
    <tr className="border-b border-neutral-200" data-testid={`payroll-blocker-${blocker.employee?.id ?? 'unknown'}`}>
      <td className="px-3 py-2 border-l-2 border-amber">
        <div className="text-13 text-neutral-900">{blocker.employee?.full_name ?? '—'}</div>
        <div className="text-11 text-neutral-500">{blocker.message}</div>
      </td>
      <td className="px-3 py-2 text-13 text-neutral-500">0 days</td>
      <td className="px-3 py-2 text-13 text-neutral-400" colSpan={11}>—</td>
      <td className="px-3 py-2 text-13 text-neutral-400">—</td>
      <td className="px-3 py-2 text-13 text-neutral-400">—</td>
    </tr>
  );
}

function VarianceBanner({ variance }: { variance: PayrollVariance }) {
  const abs = Math.abs(variance.delta_paise);
  const direction = variance.delta_paise < 0 ? 'below' : 'above';
  return (
    <div
      className="bg-white border border-neutral-200 rounded px-4 py-3 border-l-2 border-l-gold"
      data-testid="payroll-variance-banner"
    >
      <div className="text-13 text-neutral-900">
        Gross is <span className="font-medium">{inr(abs)}</span>{' '}
        {direction} <span className="font-medium">{variance.previous_label}</span> at the same headcount.
      </div>
    </div>
  );
}

function KpiRow({ run }: { run: PayrollRun }) {
  return (
    <div className="bg-white border border-neutral-200 rounded p-4 grid grid-cols-2 md:grid-cols-4 gap-4 tabular-nums">
      <Kpi label="Headcount" value={String(run.headcount)} />
      <Kpi label="Gross" value={inr(run.gross_total_paise)} />
      <Kpi label="Deductions" value={inr(run.deductions_total_paise)} />
      <Kpi label="Net" value={inr(run.net_total_paise)} emphasise />
    </div>
  );
}

function Kpi({ label, value, emphasise }: { label: string; value: string; emphasise?: boolean }) {
  return (
    <div>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
      <div className={'text-20 mt-1 ' + (emphasise ? 'text-neutral-900 font-semibold' : 'text-neutral-900')}>{value}</div>
    </div>
  );
}

function StageActions({
  run,
  canRun,
  canReview,
  canApprove,
  canProcess,
  canProcessBlocked,
  blockerCount,
  onCalculate,
  onReview,
  onApprove,
  onProcess,
  busy,
}: {
  run: PayrollRun;
  canRun: boolean;
  canReview: boolean;
  canApprove: boolean;
  canProcess: boolean;
  canProcessBlocked: boolean;
  blockerCount: number;
  onCalculate: () => void;
  onReview: () => void;
  onApprove: () => void;
  onProcess: () => void;
  busy: boolean;
}) {
  if (run.stage === 'processed') {
    return <span className="text-13 text-neutral-500">Immutable — Processed {run.processed_at?.slice(0, 10)}</span>;
  }
  const blockerHint = canProcessBlocked
    ? `${blockerCount} employee${blockerCount === 1 ? '' : 's'} without a salary structure — resolve before processing.`
    : null;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2 flex-wrap">
        {run.stage === 'draft' && canRun ? (
          <Button variant="secondary" onClick={onCalculate} disabled={busy} data-testid="payroll-calculate">
            Calculate
          </Button>
        ) : null}
        {(run.stage === 'draft' || run.stage === 'hr_review') && canReview && run.headcount > 0 ? (
          <Button
            variant="primary"
            onClick={onReview}
            disabled={busy || canProcessBlocked}
            data-testid="payroll-review"
          >
            {run.stage === 'draft' ? 'Send to HR review' : 'Send to Finance review'}
          </Button>
        ) : null}
        {run.stage === 'finance_review' && canApprove ? (
          <Button
            variant="primary"
            onClick={onApprove}
            disabled={busy || canProcessBlocked}
            data-testid="payroll-approve"
          >
            Approve
          </Button>
        ) : null}
        {run.stage === 'approved' && canProcess ? (
          <Button
            variant="primary"
            onClick={onProcess}
            disabled={busy || canProcessBlocked}
            data-testid="payroll-process"
          >
            Process (pay + publish)
          </Button>
        ) : null}
      </div>
      {blockerHint ? (
        <span className="text-11 text-neutral-500" data-testid="payroll-blocker-hint">
          {blockerHint}
        </span>
      ) : null}
    </div>
  );
}
