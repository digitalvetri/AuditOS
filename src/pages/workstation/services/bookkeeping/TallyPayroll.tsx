import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Upload } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { tallyApi, tallyAccountingApi } from '@/modules/tools/audit-automation/tally';
import { DataTable, Money, Panel, Loading, ErrorNote, ReportHeader, StatusPill } from '@/modules/tools/tally/ui';
import type { ApiError } from '@/services/api';

/**
 * /payroll — employees, pay heads, monthly processing and posting.
 *
 * Statutory rates (PF, ESI, PT) come from the company's payroll settings,
 * not from code. Processing a month produces a working; posting it writes
 * a salary journal through the same engine as every other voucher, so it
 * balances or it does not save.
 */
export function TallyPayroll() {
  const { companyId = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const base = `/tally/companies/${companyId}`;

  const employeesQ = useQuery({ queryKey: ['tally.employees', companyId], queryFn: () => tallyAccountingApi.listEmployees(companyId) });
  const headsQ = useQuery({ queryKey: ['tally.payHeads', companyId], queryFn: () => tallyAccountingApi.listPayHeads(companyId) });
  const runsQ = useQuery({ queryKey: ['tally.payrollRuns', companyId], queryFn: () => tallyAccountingApi.listPayrollRuns(companyId) });
  const ledgersQ = useQuery({ queryKey: ['tally.ledgers', companyId, ''], queryFn: () => tallyApi.listLedgers(companyId) });
  const runQ = useQuery({
    queryKey: ['tally.payrollRun', companyId, openRunId],
    enabled: Boolean(openRunId),
    queryFn: () => tallyAccountingApi.getPayrollRun(companyId, openRunId!),
  });

  const process = useMutation({
    mutationFn: () => tallyAccountingApi.processPayroll(companyId, period),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['tally.payrollRuns', companyId] });
      setOpenRunId(r.id);
      toast.push('success', `Payroll for ${r.period} processed — net ₹${(r.net_paise / 100).toFixed(2)}.`);
    },
    onError: (e: ApiError) => toast.push('error', e.message),
  });

  const post = useMutation({
    mutationFn: (input: { runId: string; paymentLedgerId: string; expenseLedgerId: string }) =>
      tallyAccountingApi.postPayroll(companyId, input.runId, {
        date: `${period}-28`, payment_ledger_id: input.paymentLedgerId, default_expense_ledger_id: input.expenseLedgerId,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tally.payrollRuns', companyId] });
      await qc.invalidateQueries({ queryKey: ['tally.payrollRun', companyId] });
      toast.push('success', 'Salary journal posted.');
    },
    onError: (e: ApiError) => toast.push('error', e.message),
  });

  const employees = employeesQ.data?.items ?? [];
  const heads = headsQ.data?.items ?? [];
  const ledgers = ledgersQ.data?.items ?? [];
  const [paymentLedgerId, setPaymentLedgerId] = useState('');
  const [expenseLedgerId, setExpenseLedgerId] = useState('');

  if (employeesQ.isLoading) return <Loading />;
  if (employeesQ.isError) return <ErrorNote message={(employeesQ.error as Error).message} />;

  return (
    <div data-testid="tally-payroll">
      <ReportHeader
        title="Payroll"
        subtitle="Employees, pay heads and monthly processing. Statutory rates live in Settings → Payroll."
        actions={
          <>
            <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="h-8 px-2 text-12 border border-neutral-300 rounded" />
            <Button size="sm" variant="primary" onClick={() => process.mutate()} disabled={process.isPending || employees.length === 0}>
              <Play size={13} className="mr-1" /> {process.isPending ? 'Processing…' : 'Process month'}
            </Button>
          </>
        }
      />

      {employees.length === 0 ? (
        <Panel><div className="px-3 py-6 text-13 text-neutral-500">
          No employees yet. Payroll needs employees, pay heads mapped to ledgers, and a salary structure per employee.
          Add them through the API or seed them, then process a month here.
        </div></Panel>
      ) : null}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
        <Panel title={`Employees (${employees.length})`}>
          <DataTable
            minWidth="420px" rows={employees} rowKey={(e) => e.id}
            columns={[
              { key: 'name', label: 'Name', value: (e) => e.name },
              { key: 'designation', label: 'Designation', value: (e) => e.designation ?? '' },
              { key: 'structure', label: 'Pay heads', align: 'right', value: (e) => e.structure.length },
              { key: 'gross', label: 'Structure gross', align: 'right', value: (e) => e.structure.filter((s) => s.head_type === 'earning').reduce((s2, s) => s2 + s.value_paise, 0) / 100, render: (e) => <Money paise={e.structure.filter((s) => s.head_type === 'earning').reduce((s2, s) => s2 + s.value_paise, 0)} /> },
            ]}
            empty="No employees."
          />
        </Panel>
        <Panel title={`Pay heads (${heads.length})`}>
          <DataTable
            minWidth="420px" rows={heads} rowKey={(h) => h.id}
            columns={[
              { key: 'name', label: 'Name', value: (h) => h.name },
              { key: 'type', label: 'Type', value: (h) => h.head_type.replace(/_/g, ' ') },
              { key: 'calc', label: 'Basis', value: (h) => (h.calc_type === 'percent_of_basic' ? `${h.percent_bp / 100}% of basic` : h.calc_type) },
              { key: 'ledger', label: 'Ledger', value: (h) => h.ledger_name ?? '', render: (h) => (h.ledger_name ? <span className="text-neutral-700">{h.ledger_name}</span> : <span className="text-danger text-12">unmapped</span>) },
            ]}
            empty="No pay heads. A pay head maps a salary component to the ledger it posts to."
          />
        </Panel>
      </div>

      <Panel title="Payroll runs" className="mb-4">
        <DataTable
          minWidth="620px" rows={runsQ.data?.items ?? []} rowKey={(r) => r.id}
          onRowClick={(r) => setOpenRunId(r.id)}
          columns={[
            { key: 'period', label: 'Month', value: (r) => r.period },
            { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <StatusPill status={r.status} /> },
            { key: 'gross', label: 'Gross', align: 'right', value: (r) => r.gross_paise / 100, render: (r) => <Money paise={r.gross_paise} /> },
            { key: 'ded', label: 'Deductions', align: 'right', value: (r) => r.deductions_paise / 100, render: (r) => <Money paise={r.deductions_paise} /> },
            { key: 'net', label: 'Net pay', align: 'right', value: (r) => r.net_paise / 100, render: (r) => <Money paise={r.net_paise} /> },
            { key: 'voucher', label: 'Journal', value: (r) => r.voucher_id ?? '', render: (r) => (r.voucher_id ? <Link to={`${base}/vouchers/${r.voucher_id}`} className="text-gold hover:underline">View</Link> : <span className="text-neutral-400">not posted</span>) },
          ]}
          empty="No payroll has been processed yet."
        />
      </Panel>

      {openRunId && runQ.data ? (
        <Panel
          title={`Payslips — ${runQ.data.period}`}
          actions={
            runQ.data.status !== 'posted' ? (
              <div className="flex items-center gap-2 flex-wrap">
                <select value={expenseLedgerId} onChange={(e) => setExpenseLedgerId(e.target.value)} className="h-7 px-1 text-12 border border-neutral-300 rounded">
                  <option value="">Default expense ledger…</option>
                  {ledgers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <select value={paymentLedgerId} onChange={(e) => setPaymentLedgerId(e.target.value)} className="h-7 px-1 text-12 border border-neutral-300 rounded">
                  <option value="">Pay from…</option>
                  {ledgers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <Button size="sm" variant="primary" disabled={!paymentLedgerId || post.isPending}
                  onClick={() => post.mutate({ runId: openRunId, paymentLedgerId, expenseLedgerId })}>
                  <Upload size={13} className="mr-1" /> Post salary journal
                </Button>
              </div>
            ) : <span className="text-12 text-emerald-700">Posted</span>
          }
        >
          <div className="p-3 grid grid-cols-1 md:grid-cols-2 gap-3">
            {runQ.data.payslips?.map((p) => (
              <div key={p.employee_id} className="border border-neutral-200 rounded p-3">
                <div className="text-13 font-medium text-neutral-900 mb-2">{p.employee_name}</div>
                <ul className="text-12 space-y-0.5">
                  {p.earnings.map((e) => <li key={e.name} className="flex justify-between"><span className="text-neutral-600">{e.name}</span><Money paise={e.amount_paise} /></li>)}
                  {p.deductions.map((e) => <li key={e.name} className="flex justify-between"><span className="text-neutral-600">less {e.name}</span><Money paise={e.amount_paise} /></li>)}
                </ul>
                <div className="border-t border-neutral-100 mt-2 pt-2 flex justify-between text-13 font-medium">
                  <span>Net pay</span><Money paise={p.net_paise} bold />
                </div>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
