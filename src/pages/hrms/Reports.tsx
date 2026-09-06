/**
 * /hrms/reports — left-rail nav per §8.10.
 *
 * Reports available per caller's grants; server returns 403 when scope
 * disallows. Every report gets CSV export (client-side blob).
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { reportsApi, type ReportType, type AttendanceReport, type LeaveReport, type PayrollReport, type ExpenseReport } from '@/modules/reports/api';
import { addDays, istToday } from '@/lib/dates';
import { inr } from '@/lib/format';

interface FilterState {
  from: string;
  to: string;
  departmentId: string;
  employeeId: string;
  runId: string;
}

export function ReportsPage() {
  const { session } = useAuth();
  const canHrOrg = can(session?.role.code, 'reports.hr', 'organisation') || can(session?.role.code, 'reports.all', 'organisation');
  const canHrDept = can(session?.role.code, 'reports.hr', 'department') || canHrOrg;
  const canHrSelf = can(session?.role.code, 'reports.hr', 'self') || canHrDept;
  const canFinance = can(session?.role.code, 'reports.finance', 'organisation') || can(session?.role.code, 'reports.all', 'organisation');
  const canPayrollOwn = can(session?.role.code, 'payroll.view.own', 'self') || canFinance;
  const canExpenseOwn = can(session?.role.code, 'expense.submit', 'self') || canFinance;

  const [params, setParams] = useSearchParams();
  const initialType = (params.get('type') as ReportType | null) ?? 'attendance';
  const [type, setType] = useState<ReportType>(initialType);

  const today = istToday();
  const [filters, setFilters] = useState<FilterState>({
    from: addDays(today, -30),
    to: today,
    departmentId: '',
    employeeId: '',
    runId: '',
  });

  const setActive = (t: ReportType) => {
    setType(t);
    setParams({ type: t }, { replace: true });
  };

  const availableTypes: { id: ReportType; label: string; group: string; visible: boolean }[] = [
    { id: 'attendance', label: 'Attendance', group: 'People', visible: canHrSelf },
    { id: 'leave', label: 'Leave utilisation', group: 'People', visible: canHrSelf },
    { id: 'payroll', label: 'Payroll summary', group: 'Finance', visible: canPayrollOwn },
    { id: 'expenses', label: 'Expenses', group: 'Finance', visible: canExpenseOwn },
  ];
  const groups = Array.from(new Set(availableTypes.filter((t) => t.visible).map((t) => t.group)));

  return (
    <div className="max-w-[1200px] mx-auto">
      <header>
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">HRMS</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">Reports</h1>
        <p className="text-13 text-neutral-500 mt-1">
          Every report is scoped at query time to what you're allowed to see.
        </p>
      </header>
      <div className="mt-6 grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6">
        <aside data-testid="reports-nav">
          {groups.map((g) => (
            <div key={g} className="mb-4">
              <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 mb-1">{g}</div>
              {availableTypes.filter((t) => t.group === g && t.visible).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActive(t.id)}
                  data-testid={`reports-nav-${t.id}`}
                  className={
                    'flex items-center h-8 pl-3 pr-2 text-13 w-full text-left border-l-2 ' +
                    (t.id === type
                      ? 'border-gold text-neutral-900 font-medium'
                      : 'border-transparent text-neutral-700 hover:text-neutral-900')
                  }
                >
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </aside>
        <main data-testid={`reports-panel-${type}`}>
          <FiltersBar type={type} filters={filters} onChange={setFilters} />
          {type === 'attendance' ? <AttendanceReportView filters={filters} /> : null}
          {type === 'leave' ? <LeaveReportView filters={filters} /> : null}
          {type === 'payroll' ? <PayrollReportView filters={filters} /> : null}
          {type === 'expenses' ? <ExpensesReportView filters={filters} /> : null}
        </main>
      </div>
    </div>
  );
}

function FiltersBar({ type, filters, onChange }: { type: ReportType; filters: FilterState; onChange: (f: FilterState) => void }) {
  const showDateRange = type === 'attendance' || type === 'expenses';
  const showRunId = type === 'payroll';
  return (
    <div className="mb-4 flex items-end gap-3 flex-wrap">
      {showDateRange ? (
        <>
          <Input label="From" type="date" value={filters.from} onChange={(e) => onChange({ ...filters, from: e.target.value })} data-testid="report-from" />
          <Input label="To" type="date" value={filters.to} onChange={(e) => onChange({ ...filters, to: e.target.value })} data-testid="report-to" />
        </>
      ) : null}
      {showRunId ? (
        <Input label="Payroll run id (optional)" value={filters.runId} onChange={(e) => onChange({ ...filters, runId: e.target.value })} />
      ) : null}
      <Input label="Department (optional)" value={filters.departmentId} onChange={(e) => onChange({ ...filters, departmentId: e.target.value })} />
    </div>
  );
}

// ── Attendance ────────────────────────────────────────────────────────────
function AttendanceReportView({ filters }: { filters: FilterState }) {
  const q = useQuery({
    queryKey: ['reports', 'attendance', filters],
    queryFn: () => reportsApi.attendance({ from: filters.from, to: filters.to, departmentId: filters.departmentId }),
    retry: false,
  });
  return (
    <Wrapper q={q} onExport={(data: AttendanceReport) => exportCsv('attendance', data.items, [
      'employee_code', 'full_name', 'department_id', 'days_recorded', 'present', 'late', 'half_day', 'wfh', 'absent', 'on_leave', 'missing_check_out', 'off_site_days', 'hours',
    ])}>
      {(data: AttendanceReport) => (
        <Table
          columns={['Code', 'Name', 'Dept', 'Days', 'Present', 'Late', 'Half', 'WFH', 'Absent', 'Leave', 'Missing', 'Off-site', 'Hours']}
          rows={data.items.map((r) => [
            r.employee_code, r.full_name, r.department_id, r.days_recorded, r.present, r.late, r.half_day, r.wfh, r.absent, r.on_leave, r.missing_check_out, r.off_site_days, r.hours,
          ])}
          testId="attendance-report"
        />
      )}
    </Wrapper>
  );
}

// ── Leave ────────────────────────────────────────────────────────────────
function LeaveReportView({ filters }: { filters: FilterState }) {
  const q = useQuery({
    queryKey: ['reports', 'leave', filters],
    queryFn: () => reportsApi.leave({ departmentId: filters.departmentId }),
    retry: false,
  });
  return (
    <Wrapper q={q} onExport={(data: LeaveReport) => {
      // Flatten per-type into one row per employee×type.
      const flat = data.items.flatMap((r) => r.by_type.map((bt) => ({
        employee_code: r.employee_code,
        full_name: r.full_name,
        type: bt.type_name,
        entitled: bt.entitled,
        availed: bt.availed,
        pending: bt.pending,
        available: bt.available,
      })));
      exportCsv('leave', flat, ['employee_code', 'full_name', 'type', 'entitled', 'availed', 'pending', 'available']);
    }}>
      {(data: LeaveReport) => (
        <div className="space-y-6">
          {data.items.map((r) => (
            <div key={r.employee_id} className="bg-white border border-neutral-200 rounded p-4">
              <div className="text-13 text-neutral-900 font-medium">{r.full_name}</div>
              <div className="text-11 text-neutral-500 mb-3">{r.employee_code} · {r.department_id}</div>
              <table className="w-full border-collapse tabular-nums">
                <thead>
                  <tr>
                    {['Type', 'Entitled', 'Availed', 'Pending', 'Available'].map((c) => (
                      <th key={c} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 py-1 border-b border-neutral-200 font-medium">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.by_type.map((bt) => (
                    <tr key={bt.type_code} className="border-b border-neutral-200 last:border-b-0">
                      <td className="py-1 text-13 text-neutral-900">{bt.type_name}</td>
                      <td className="py-1 text-13 text-neutral-900">{bt.entitled}</td>
                      <td className="py-1 text-13 text-neutral-900">{bt.availed}</td>
                      <td className={'py-1 text-13 ' + (bt.pending > 0 ? 'text-amber font-medium' : 'text-neutral-500')}>{bt.pending}</td>
                      <td className="py-1 text-13 text-neutral-900 font-medium">{bt.available}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </Wrapper>
  );
}

// ── Payroll ──────────────────────────────────────────────────────────────
function PayrollReportView({ filters }: { filters: FilterState }) {
  const q = useQuery({
    queryKey: ['reports', 'payroll', filters],
    queryFn: () => reportsApi.payroll({ runId: filters.runId, departmentId: filters.departmentId }),
    retry: false,
  });
  return (
    <Wrapper q={q} onExport={(data: PayrollReport) => exportCsv('payroll', data.items.map((r) => ({
      ...r,
      basic: r.basic_paise / 100,
      hra: r.hra_paise / 100,
      gross: r.gross_paise / 100,
      pf: r.pf_paise / 100,
      esi: r.esi_paise / 100,
      pt: r.pt_paise / 100,
      tds: r.tds_paise / 100,
      lop: r.lop_paise / 100,
      total_deductions: r.total_deductions_paise / 100,
      net: r.net_paise / 100,
    })), ['employee_code', 'full_name', 'payable_days', 'lop_days', 'basic', 'hra', 'gross', 'pf', 'esi', 'pt', 'tds', 'lop', 'total_deductions', 'net'])}>
      {(data: PayrollReport) => (
        <div className="space-y-4">
          <div className="bg-white border border-neutral-200 rounded p-4 flex items-baseline gap-6 flex-wrap tabular-nums">
            <div>
              <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Run</div>
              <div className="text-13 text-neutral-900 mt-1">{data.run.id}</div>
              <div className="text-11 text-neutral-500">{data.run.period_start} → {data.run.period_end}</div>
            </div>
            <div>
              <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Gross</div>
              <div className="text-16 text-neutral-900 mt-1">{inr(data.totals.gross_paise)}</div>
            </div>
            <div>
              <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Deductions</div>
              <div className="text-16 text-neutral-900 mt-1">{inr(data.totals.deductions_paise)}</div>
            </div>
            <div>
              <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Net</div>
              <div className="text-16 text-neutral-900 mt-1 font-semibold">{inr(data.totals.net_paise)}</div>
            </div>
          </div>
          <Table
            columns={['Code', 'Name', 'Days', 'LOP', 'Basic', 'HRA', 'Gross', 'PF', 'ESI', 'PT', 'TDS', 'LOP ₹', 'Ded', 'Net']}
            rows={data.items.map((r) => [
              r.employee_code, r.full_name, r.payable_days, r.lop_days,
              inr(r.basic_paise), inr(r.hra_paise), inr(r.gross_paise),
              inr(r.pf_paise), inr(r.esi_paise), inr(r.pt_paise), inr(r.tds_paise), inr(r.lop_paise),
              inr(r.total_deductions_paise), inr(r.net_paise),
            ])}
            testId="payroll-report"
          />
        </div>
      )}
    </Wrapper>
  );
}

// ── Expenses ─────────────────────────────────────────────────────────────
function ExpensesReportView({ filters }: { filters: FilterState }) {
  const q = useQuery({
    queryKey: ['reports', 'expenses', filters],
    queryFn: () => reportsApi.expenses({ from: filters.from, to: filters.to, departmentId: filters.departmentId }),
    retry: false,
  });
  return (
    <Wrapper q={q} onExport={(data: ExpenseReport) => exportCsv('expenses', data.items.map((r) => ({
      employee_code: r.employee_code,
      full_name: r.full_name,
      count: r.count,
      drafts: r.drafts,
      claimed: r.claimed_paise / 100,
      reimbursed: r.reimbursed_paise / 100,
    })), ['employee_code', 'full_name', 'count', 'drafts', 'claimed', 'reimbursed'])}>
      {(data: ExpenseReport) => (
        <div className="space-y-4">
          <div className="bg-white border border-neutral-200 rounded p-4 flex items-baseline gap-6 flex-wrap tabular-nums">
            <div>
              <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Count</div>
              <div className="text-16 text-neutral-900 mt-1">{data.totals.expense_count}</div>
            </div>
            <div>
              <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Claimed</div>
              <div className="text-16 text-neutral-900 mt-1">{inr(data.totals.claimed_paise)}</div>
            </div>
            <div>
              <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Reimbursed</div>
              <div className="text-16 text-neutral-900 mt-1 font-semibold">{inr(data.totals.reimbursed_paise)}</div>
            </div>
          </div>

          <div>
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">Per employee</div>
            <Table
              columns={['Code', 'Name', 'Count', 'Drafts', 'Claimed', 'Reimbursed']}
              rows={data.items.map((r) => [
                r.employee_code, r.full_name, r.count, r.drafts,
                inr(r.claimed_paise), inr(r.reimbursed_paise),
              ])}
              testId="expenses-report"
            />
          </div>

          <div>
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">By category</div>
            <Table
              columns={['Category', 'Count', 'Reimbursed']}
              rows={data.by_category.map((r) => [r.category_name, r.count, inr(r.reimbursed_paise)])}
              testId="expenses-by-category"
            />
          </div>
        </div>
      )}
    </Wrapper>
  );
}

// ── Shared shell ─────────────────────────────────────────────────────────
function Wrapper<T>({ q, children, onExport }: {
  q: { isLoading: boolean; isError: boolean; error: unknown; data: T | undefined };
  children: (data: T) => React.ReactNode;
  onExport: (data: T) => void;
}) {
  if (q.isLoading) return <div className="h-40 bg-neutral-100" />;
  if (q.isError) {
    const status = (q.error as { status?: number }).status;
    if (status === 403) {
      return (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500 border-l-2 border-l-neutral-400">
          You don't have access to this report.
        </div>
      );
    }
    return <div className="text-13 text-red">Could not load report.</div>;
  }
  if (!q.data) return null;
  return (
    <div className="space-y-3" data-testid="report-body">
      <div className="flex justify-end">
        <Button variant="secondary" onClick={() => onExport(q.data as T)} data-testid="report-export">
          Export CSV
        </Button>
      </div>
      {children(q.data)}
    </div>
  );
}

function Table({ columns, rows, testId }: { columns: string[]; rows: (string | number)[][]; testId?: string }) {
  if (rows.length === 0) {
    return <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">No rows.</div>;
  }
  return (
    <div className="bg-white border border-neutral-200 rounded overflow-x-auto" data-testid={testId}>
      <table className="w-full border-collapse tabular-nums">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-neutral-200 last:border-b-0">
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2 text-13 text-neutral-900">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function exportCsv(reportName: string, rows: object[], columns: string[]) {
  if (rows.length === 0) return;
  const header = columns.join(',');
  const body = rows
    .map((r) =>
      columns
        .map((c) => {
          const v = (r as Record<string, unknown>)[c] ?? '';
          const s = String(v).replace(/"/g, '""');
          return /[",\n]/.test(s) ? `"${s}"` : s;
        })
        .join(','),
    )
    .join('\n');
  const blob = new Blob([`${header}\n${body}`], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${reportName}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
