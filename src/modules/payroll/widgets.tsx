/**
 * Payroll dashboard widgets.
 *
 *   Primary (HR/MD/Finance): current-period stage + KPIs
 *   Feed (Employee): latest payslip preview when published
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { registerWidget } from '@/platform/dashboard/registry';
import { payrollApi, STAGE_LABEL } from './api';
import { inr } from '@/lib/format';
import { useAuth } from '@/platform/auth/AuthContext';

function PayrollStageWidget() {
  const q = useQuery({
    queryKey: ['payroll', 'runs'],
    queryFn: payrollApi.runs.list,
    retry: false,
  });
  if (q.isError) return <div className="text-13 text-neutral-500">Payroll unavailable.</div>;
  const current = q.data?.items[0]; // newest first
  if (!current) return <div className="text-13 text-neutral-500">No payroll runs yet.</div>;
  return (
    <div data-testid="payroll-stage-widget">
      <div className="flex items-baseline justify-between">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Payroll</div>
        <Link to={`/hrms/payroll/runs/${current.id}`} className="text-11 text-gold hover:text-gold-hover">Open →</Link>
      </div>
      <div className="mt-2 text-16 text-neutral-900 tabular-nums">
        {current.period_start.slice(0, 7)}
      </div>
      <div className="text-13 text-neutral-500 mt-1">Stage: <span className="text-neutral-900 font-medium">{STAGE_LABEL[current.stage]}</span></div>
      <div className="mt-3 grid grid-cols-3 gap-2 tabular-nums">
        <div>
          <div className="text-11 text-neutral-500">Headcount</div>
          <div className="text-13 text-neutral-900">{current.headcount}</div>
        </div>
        <div>
          <div className="text-11 text-neutral-500">Gross</div>
          <div className="text-13 text-neutral-900">{inr(current.gross_total_paise)}</div>
        </div>
        <div>
          <div className="text-11 text-neutral-500">Net</div>
          <div className="text-13 text-neutral-900 font-medium">{inr(current.net_total_paise)}</div>
        </div>
      </div>
    </div>
  );
}

function LatestPayslipWidget() {
  const { session } = useAuth();
  const employeeId = session?.employee?.id;
  const q = useQuery({
    queryKey: ['payroll', 'payslips', 'latest', employeeId],
    queryFn: () => payrollApi.payslips.list({ employeeId }),
    enabled: !!employeeId,
  });
  const latest = q.data?.items[0];
  if (!latest) return <div className="text-13 text-neutral-500">No payslips yet.</div>;
  return (
    <div data-testid="latest-payslip-widget">
      <div className="flex items-baseline justify-between">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Latest payslip</div>
        <Link to={`/me/payslips/${latest.id}`} className="text-11 text-gold hover:text-gold-hover">Open →</Link>
      </div>
      <div className="mt-2 text-16 text-neutral-900 tabular-nums">
        {latest.period_start} → {latest.period_end}
      </div>
      <div className="text-13 text-neutral-500 mt-1 tabular-nums">
        Net {inr(latest.net_paise)}
      </div>
    </div>
  );
}

registerWidget({
  id: 'payroll.stage',
  slot: 'primary',
  roles: ['hr_admin', 'finance_admin', 'md'],
  scope: 'organisation',
  component: PayrollStageWidget,
  order: 40,
});

registerWidget({
  id: 'payroll.latest-payslip',
  slot: 'secondary',
  roles: ['employee', 'dept_manager', 'hr_admin', 'finance_admin', 'md'],
  scope: 'self',
  component: LatestPayslipWidget,
  order: 15,
});
