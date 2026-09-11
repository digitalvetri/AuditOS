/**
 * /hrms/payroll/payslips/:id  &  /me/payslips/:id — same component.
 *
 * Renders the full payslip: header · employee block · earnings/deductions
 * tables · gross/net in figures + words · Download PDF (mock).
 */
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { payrollApi } from '@/modules/payroll/api';
import { inr } from '@/lib/format';
import { inrToWords } from '@/lib/payroll/inrWords';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';

export function PayslipDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id!;
  const toast = useToast();
  const q = useQuery({
    queryKey: ['payroll', 'payslip', id],
    queryFn: () => payrollApi.payslips.get(id),
    retry: false,
  });

  const download = useMutation({
    mutationFn: () => payrollApi.payslips.downloadUrl(id),
    onSuccess: (res) => window.open(res.url, '_blank', 'noopener'),
    onError: (e: Error) => toast.push('error', e.message),
  });

  if (q.isLoading) return <div className="h-40 bg-neutral-100 max-w-[720px] mx-auto" />;
  if (q.isError || !q.data) {
    return (
      <div className="max-w-[720px] mx-auto bg-white border border-neutral-200 rounded p-6">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Access denied</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">Payslip unavailable.</h1>
      </div>
    );
  }
  const { payslip, run, item, employee, department, designation } = q.data;

  return (
    <div className="max-w-[840px] mx-auto space-y-4" data-testid="payslip-detail">
      <div className="flex items-center justify-between">
        <Link to="/me/payslips" className="text-13 text-neutral-500 hover:text-neutral-900">← My payslips</Link>
        <Button variant="secondary" onClick={() => download.mutate()} disabled={download.isPending} data-testid="payslip-download">
          {download.isPending ? 'Preparing…' : 'Download PDF'}
        </Button>
      </div>

      <div className="bg-white border border-neutral-200 rounded p-6">
        <div className="flex items-center gap-3">
          <img
            src="/jns-logo-tight.png"
            alt="JNS Accounting Solutions"
            className="h-10 w-auto"
          />
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Payslip</div>
        </div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-3">
          {run?.period_start} → {run?.period_end}
        </h1>

        <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-4 text-13">
          <Field label="Employee" value={employee?.full_name ?? '—'} />
          <Field label="Code" value={employee?.employee_code ?? '—'} />
          <Field label="Email" value={employee?.email ?? '—'} />
          <Field label="Department" value={department?.name ?? '—'} />
          <Field label="Designation" value={designation?.name ?? '—'} />
          <Field label="Published" value={payslip.published_at.slice(0, 10)} />
        </div>

        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
          <Panel title="Earnings">
            <Row label="Basic" amount={item?.earnings.basic_paise ?? 0} />
            <Row label="HRA" amount={item?.earnings.hra_paise ?? 0} />
            <Row label="Conveyance" amount={item?.earnings.conveyance_paise ?? 0} />
            <Row label="Special allowance" amount={item?.earnings.special_paise ?? 0} />
            {item?.earnings.incentive_paise ? (
              <Row label="Incentive" amount={item.earnings.incentive_paise} />
            ) : null}
            <RowTotal label="Gross" amount={item?.gross_paise ?? 0} />
          </Panel>
          <Panel title="Deductions">
            <Row label="PF (employee)" amount={item?.deductions.pf_employee_paise ?? 0} />
            <Row label="ESI (employee)" amount={item?.deductions.esi_employee_paise ?? 0} />
            <Row label="Professional Tax" amount={item?.deductions.pt_paise ?? 0} />
            <Row label="TDS" amount={item?.deductions.tds_paise ?? 0} />
            <Row label="LOP" amount={item?.deductions.lop_paise ?? 0} problem={!!item?.deductions.lop_paise} />
            <Row label="Advance recovery" amount={item?.deductions.advance_paise ?? 0} />
            <RowTotal label="Total deductions" amount={item?.total_deductions_paise ?? 0} />
          </Panel>
        </div>

        <div className="mt-6 border-t border-neutral-200 pt-4">
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Net pay</div>
          <div className="text-20 text-neutral-900 mt-1 tabular-nums font-semibold">
            {inr(item?.net_paise ?? 0)}
          </div>
          <div className="text-13 text-neutral-500 mt-1" data-testid="payslip-in-words">
            {inrToWords(item?.net_paise ?? 0)}
          </div>
        </div>

        <div className="mt-6 text-11 text-neutral-500 border-l-2 border-neutral-400 pl-3">
          Simulated payslip. No actual payment processed. Statutory rates locked at run's Calculate.
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
      <div className="text-13 text-neutral-900 mt-1">{value}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">{title}</div>
      <div className="border border-neutral-200 rounded">{children}</div>
    </div>
  );
}

function Row({ label, amount, problem }: { label: string; amount: number; problem?: boolean }) {
  return (
    <div className={'flex items-center justify-between px-3 h-9 text-13 border-b border-neutral-200 last:border-b-0 ' + (problem ? 'border-l-2 border-l-red' : '')}>
      <span className="text-neutral-700">{label}</span>
      <span className="tabular-nums text-neutral-900">{inr(amount)}</span>
    </div>
  );
}

function RowTotal({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="flex items-center justify-between px-3 h-10 text-13 font-medium bg-neutral-50">
      <span className="text-neutral-900">{label}</span>
      <span className="tabular-nums text-neutral-900">{inr(amount)}</span>
    </div>
  );
}
