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
import {
  CalendarCheck, CalendarDays, Download, Receipt, ShieldAlert, Wallet, type LucideIcon,
} from 'lucide-react';

/** Each report's icon and tint — the dashboard's tinted icon squares. */
const REPORT_META: Record<ReportType, { icon: LucideIcon; bg: string; fg: string; blurb: string }> = {
  attendance: { icon: CalendarCheck, bg: '#e9f9f1', fg: '#047857', blurb: 'Days present, late, on leave and hours, per employee.' },
  leave: { icon: CalendarDays, bg: '#e8eef8', fg: '#1a4b8c', blurb: 'Entitlement, availed and balance, by leave type.' },
  payroll: { icon: Wallet, bg: '#eff6ff', fg: '#1e40af', blurb: 'Earnings, deductions and net pay for a run.' },
  expenses: { icon: Receipt, bg: '#fff7e6', fg: '#b45309', blurb: 'Claims and reimbursements, per employee and category.' },
};

function IconSquare({ type, size = 36 }: { type: ReportType; size?: number }) {
  const m = REPORT_META[type];
  const Icon = m.icon;
  return (
    <span className="shrink-0 rounded-lg inline-flex items-center justify-center" style={{ width: size, height: size, background: m.bg, color: m.fg }} aria-hidden>
      <Icon size={size >= 36 ? 17 : 14} strokeWidth={1.9} />
    </span>
  );
}

/** A summary figure, as on the dashboard tiles. */
function Stat({ label, value, strong }: { label: string; value: string | number; strong?: boolean }) {
  return (
    <div className="dash-card px-5 py-4">
      <div className="text-12 font-medium text-neutral-500">{label}</div>
      <div className={`num-display text-[22px] leading-tight mt-1 ${strong ? 'text-primary' : 'text-neutral-900'}`}>{value}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-15 font-semibold text-neutral-900 mb-3">{children}</h3>;
}

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

  // Which reports this caller may actually run. Declared BEFORE the initial
  // type is chosen: a role without `reports.hr` (Finance, for one) must not
  // land on Attendance and fire a request the API answers with 403.
  const availableTypes: { id: ReportType; label: string; group: string; visible: boolean }[] = [
    { id: 'attendance', label: 'Attendance', group: 'People', visible: canHrSelf },
    { id: 'leave', label: 'Leave utilisation', group: 'People', visible: canHrSelf },
    { id: 'payroll', label: 'Payroll summary', group: 'Finance', visible: canPayrollOwn },
    { id: 'expenses', label: 'Expenses', group: 'Finance', visible: canExpenseOwn },
  ];
  const visibleTypes = availableTypes.filter((t) => t.visible);
  const groups = Array.from(new Set(visibleTypes.map((t) => t.group)));

  // A ?type= the caller cannot see is ignored rather than honoured, so a
  // shared link opens the first report they do have instead of an error.
  // null = this role has no reports at all; the panel says so and asks for
  // nothing. ProtectedRoute guarantees a session here, so these grants are
  // already settled on first render.
  const requestedType = params.get('type') as ReportType | null;
  const [type, setType] = useState<ReportType | null>(() =>
    requestedType && visibleTypes.some((t) => t.id === requestedType)
      ? requestedType
      : visibleTypes[0]?.id ?? null,
  );

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

  return (
    <div className="m-page">
      <header>
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-neutral-900">Reports</h1>
        <p className="text-13 text-neutral-500 mt-1">
          Every report is scoped at query time to what you're allowed to see.
        </p>
      </header>
      {/* Mobile: one scrolling rail of every report the caller may run. The
          desktop rail below is untouched and simply hidden here. */}
      <div className="md:hidden m-rail" data-testid="reports-nav-mobile" role="tablist">
        {visibleTypes.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            onClick={() => setActive(t.id)}
            data-testid={`reports-nav-m-${t.id}`}
            data-active={t.id === type}
            aria-selected={t.id === type}
            className="m-chip"
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-0 md:mt-6 grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6">
        <aside data-testid="reports-nav" className="hidden md:block dash-card p-3 self-start">
          {groups.map((g) => (
            <div key={g} className="mb-3 last:mb-0">
              <div className="text-12 font-semibold text-neutral-500 px-3 mb-1 mt-1">{g}</div>
              {visibleTypes.filter((t) => t.group === g).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActive(t.id)}
                  data-testid={`reports-nav-${t.id}`}
                  className={
                    'flex items-center gap-3 h-10 px-2 text-13 w-full text-left rounded-lg transition-colors ' +
                    (t.id === type
                      ? 'bg-[#eaf0f8] text-primary font-medium'
                      : 'text-neutral-700 hover:bg-neutral-50 hover:text-neutral-900')
                  }
                >
                  <IconSquare type={t.id} size={28} />
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </aside>
        {/* min-w-0: a wide report table scrolls inside its own box instead of
            stretching the grid column past the page edge. */}
        <main className="min-w-0" data-testid={type ? `reports-panel-${type}` : 'reports-panel-none'}>
          {type === null ? (
            <div className="dash-card p-6 text-13 text-neutral-500">
              No reports are available to your role.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 mb-4">
                <IconSquare type={type} />
                <div className="min-w-0">
                  <h2 className="text-18 font-semibold text-neutral-900 leading-tight">
                    {availableTypes.find((t) => t.id === type)?.label}
                  </h2>
                  <p className="text-12 text-neutral-500">{REPORT_META[type].blurb}</p>
                </div>
              </div>
              <FiltersBar type={type} filters={filters} onChange={setFilters} />
              {type === 'attendance' ? <AttendanceReportView filters={filters} /> : null}
              {type === 'leave' ? <LeaveReportView filters={filters} /> : null}
              {type === 'payroll' ? <PayrollReportView filters={filters} /> : null}
              {type === 'expenses' ? <ExpensesReportView filters={filters} /> : null}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function FiltersBar({ type, filters, onChange }: { type: ReportType; filters: FilterState; onChange: (f: FilterState) => void }) {
  const showDateRange = type === 'attendance' || type === 'expenses';
  const showRunId = type === 'payroll';
  return (
    <div className="m-form dash-card px-5 py-4 mb-5 grid grid-cols-1 md:flex md:items-end gap-3 md:flex-wrap">
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
            <div key={r.employee_id} className="dash-card p-5">
              <div className="flex items-center gap-3 mb-3">
                <span className="h-9 w-9 shrink-0 rounded-full inline-flex items-center justify-center text-12 font-semibold text-white"
                  style={{ background: 'linear-gradient(180deg, #1c3d6e, #12305a)' }} aria-hidden>
                  {r.full_name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="text-14 text-neutral-900 font-semibold">{r.full_name}</div>
                  <div className="text-12 text-neutral-500">{r.employee_code} · {r.department_id}</div>
                </div>
              </div>
              {/* Wrapped, so the floating table does not strip this card's frame. */}
              <div>
              <table className="hr-float m-cards w-full border-collapse tabular-nums">
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
                      <td data-label="Type" className="py-1 text-13 text-neutral-900">{bt.type_name}</td>
                      <td data-label="Entitled" className="py-1 text-13 text-neutral-900">{bt.entitled}</td>
                      <td data-label="Availed" className="py-1 text-13 text-neutral-900">{bt.availed}</td>
                      <td data-label="Pending" className={'py-1 text-13 ' + (bt.pending > 0 ? 'text-amber font-medium' : 'text-neutral-500')}>{bt.pending}</td>
                      <td data-label="Available" className="py-1 num-display text-14 text-primary">{bt.available}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="dash-card px-5 py-4 min-w-0">
              <div className="text-12 font-medium text-neutral-500">Run</div>
              <div className="text-13 font-semibold text-neutral-900 mt-1 truncate" title={data.run.id}>{data.run.id}</div>
              <div className="text-12 text-neutral-500">{data.run.period_start} → {data.run.period_end}</div>
            </div>
            <Stat label="Gross" value={inr(data.totals.gross_paise)} />
            <Stat label="Deductions" value={inr(data.totals.deductions_paise)} />
            <Stat label="Net" value={inr(data.totals.net_paise)} strong />
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
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Stat label="Count" value={data.totals.expense_count} />
            <Stat label="Claimed" value={inr(data.totals.claimed_paise)} />
            <Stat label="Reimbursed" value={inr(data.totals.reimbursed_paise)} strong />
          </div>

          <div>
            <SectionTitle>Per employee</SectionTitle>
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
            <SectionTitle>By category</SectionTitle>
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
  if (q.isLoading) return <div className="h-40 rounded-lg bg-neutral-100" aria-label="Loading" />;
  if (q.isError) {
    const status = (q.error as { status?: number }).status;
    if (status === 403) {
      return (
        <div className="dash-card p-6 flex items-center gap-3 text-13 text-neutral-600">
          <span className="h-9 w-9 shrink-0 rounded-lg inline-flex items-center justify-center bg-[#f1f5f9] text-neutral-500" aria-hidden>
            <ShieldAlert size={16} strokeWidth={1.9} />
          </span>
          You don't have access to this report.
        </div>
      );
    }
    return <div className="dash-card p-6 text-13 text-red">Could not load report.</div>;
  }
  if (!q.data) return null;
  return (
    <div className="space-y-3" data-testid="report-body">
      <div className="flex justify-stretch md:justify-end">
        <Button
          variant="secondary"
          onClick={() => onExport(q.data as T)}
          data-testid="report-export"
          className="w-full min-h-[44px] md:w-auto md:min-h-0"
        >
          <Download size={15} strokeWidth={1.9} className="mr-2" />Export CSV
        </Button>
      </div>
      {children(q.data)}
    </div>
  );
}

function Table({ columns, rows, testId }: { columns: string[]; rows: (string | number)[][]; testId?: string }) {
  if (rows.length === 0) {
    return <div className="dash-card p-6 text-13 text-neutral-500">No rows.</div>;
  }
  return (
    // `m-cards` (≤767px) flips this same table to a stack of labelled rows —
    // a 14-column payroll table cannot be made to fit 320px by scrolling
    // alone. Above 768px the class is inert and the table renders as before.
    <div
      className="m-cards md:overflow-x-auto"
      data-testid={testId}
    >
      <table className="hr-float w-full border-collapse tabular-nums">
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
                <td key={j} data-label={columns[j] ?? ''} className="px-3 py-2 text-13 text-neutral-900">{cell}</td>
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
