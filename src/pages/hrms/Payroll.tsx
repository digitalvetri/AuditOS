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
import { payrollApi, STAGE_LABEL } from '@/modules/payroll/api';
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
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">Payroll is HR / Finance / MD only.</h1>
      </div>
    );
  }

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">HRMS</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">Payroll</h1>
        </div>
        {canRun ? (
          <Button variant="primary" onClick={() => setCreating(true)} data-testid="payroll-create-open">
            New run
          </Button>
        ) : null}
      </header>

      {creating ? <CreateRunForm onDone={() => setCreating(false)} /> : null}

      <div className="bg-white border border-neutral-200 rounded overflow-hidden" data-testid="payroll-runs">
        {q.isLoading ? (
          <div className="h-40 bg-neutral-100" aria-label="Loading" />
        ) : (q.data?.items.length ?? 0) === 0 ? (
          <div className="p-6 text-13 text-neutral-500">No payroll runs yet.</div>
        ) : (
          <table className="w-full border-collapse tabular-nums">
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
                      <Link to={`/hrms/payroll/runs/${r.id}`} className="text-13 text-gold hover:text-gold-hover">Open →</Link>
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
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const create = useMutation({
    mutationFn: () => payrollApi.runs.create(start, end),
    onSuccess: (res) => {
      toast.push('success', `Run created for ${res.run.period_start} → ${res.run.period_end}.`);
      qc.invalidateQueries({ queryKey: ['payroll', 'runs'] });
      onDone();
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        create.mutate();
      }}
      className="bg-white border border-neutral-200 rounded p-4 flex items-end gap-3 flex-wrap"
    >
      <Input label="Period start" type="date" value={start} onChange={(e) => setStart(e.target.value)} required data-testid="payroll-create-start" />
      <Input label="Period end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} required data-testid="payroll-create-end" />
      <Button variant="primary" type="submit" disabled={create.isPending} data-testid="payroll-create-submit">
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

  if (q.isLoading) return <div className="h-40 bg-neutral-100 max-w-[1200px] mx-auto" />;
  if (q.isError || !q.data) {
    return (
      <div className="max-w-[720px] mx-auto bg-white border border-neutral-200 rounded p-6">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Access denied</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">You can't view this payroll run.</h1>
      </div>
    );
  }
  const { run, items } = q.data;
  const s = stageStyle(run.stage);

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <div>
        <Link to="/hrms/payroll" className="text-13 text-neutral-500 hover:text-neutral-900">← Payroll</Link>
      </div>
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{run.id}</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">
            Payroll · {run.period_start} → {run.period_end}
          </h1>
          <div className="mt-1"><StatusLabel variant={s.variant} label={s.label} /></div>
        </div>
        <StageActions
          run={run}
          canRun={canRun}
          canReview={canReview}
          canApprove={canApprove}
          canProcess={canProcess}
          onCalculate={() => calc.mutate()}
          onReview={() => review.mutate()}
          onApprove={() => approve.mutate()}
          onProcess={() => proc.mutate()}
          busy={calc.isPending || review.isPending || approve.isPending || proc.isPending}
        />
      </header>

      <KpiRow run={run} />

      {items.length === 0 ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">
          No items — Calculate to populate.
        </div>
      ) : (
        <div className="bg-white border border-neutral-200 rounded overflow-x-auto">
          <table className="w-full border-collapse tabular-nums" data-testid="payroll-items">
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
  onCalculate: () => void;
  onReview: () => void;
  onApprove: () => void;
  onProcess: () => void;
  busy: boolean;
}) {
  if (run.stage === 'processed') {
    return <span className="text-13 text-neutral-500">Immutable — Processed {run.processed_at?.slice(0, 10)}</span>;
  }
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {run.stage === 'draft' && canRun ? (
        <Button variant="secondary" onClick={onCalculate} disabled={busy} data-testid="payroll-calculate">
          Calculate
        </Button>
      ) : null}
      {(run.stage === 'draft' || run.stage === 'hr_review') && canReview && run.headcount > 0 ? (
        <Button variant="primary" onClick={onReview} disabled={busy} data-testid="payroll-review">
          {run.stage === 'draft' ? 'Send to HR review' : 'Send to Finance review'}
        </Button>
      ) : null}
      {run.stage === 'finance_review' && canApprove ? (
        <Button variant="primary" onClick={onApprove} disabled={busy} data-testid="payroll-approve">
          Approve
        </Button>
      ) : null}
      {run.stage === 'approved' && canProcess ? (
        <Button variant="primary" onClick={onProcess} disabled={busy} data-testid="payroll-process">
          Process (pay + publish)
        </Button>
      ) : null}
    </div>
  );
}
