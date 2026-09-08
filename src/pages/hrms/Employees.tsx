/**
 * /hrms/employees — list per §8.1.
 *
 * Columns visible to Finance are constrained to the 6-field projection the
 * server returns. The UI mirrors what the server sent — never adds fields.
 *
 * Filters: q, department, designation, type, status, manager, joining date range.
 * Row click → /hrms/employees/:id.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { employeeApi, isFullEmployee, type EmployeeFilters, type EmployeeRow } from '@/modules/employees/api';
import { EmployeeCreateModal } from '@/modules/employees/EmployeeCreateModal';
import { fmtDate } from '@/lib/format';
import { StatusLabel, type StatusVariant } from '@/components/StatusRow';
import { Button } from '@/components/Button';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { styleForStatus as attendanceStyleForStatus } from '@/modules/attendance/statusStyle';

export function EmployeesPage() {
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'employee.manage', 'organisation');
  const navigate = useNavigate();

  const [filters, setFilters] = useState<EmployeeFilters>({ q: '' });
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: ['employees', 'list', filters],
    queryFn: () => employeeApi.list(filters),
  });

  const isFinanceView = query.data?.scope === 'finance';

  const columns = useMemo(() => {
    // Finance sees a strict subset. Server enforces; UI mirrors.
    if (isFinanceView) {
      return ['Code', 'Name', 'Department', 'Designation', 'Bank', 'Status'];
    }
    return [
      'Code',
      'Name',
      'Type',
      'Department',
      'Designation',
      'Email',
      'Joining date',
      'Manager',
      'Today',
      'Status',
    ];
  }, [isFinanceView]);

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">HRMS</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">Employees</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => exportCsv(query.data?.items ?? [], columns)}
            disabled={!query.data?.items.length}
            data-testid="employees-export"
          >
            Export CSV
          </Button>
          {canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)} data-testid="employees-add">
              Add employee
            </Button>
          ) : null}
        </div>
      </header>

      <FiltersBar filters={filters} onChange={setFilters} canManage={canManage} />
      <EmployeeCreateModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => { setCreating(false); navigate(`/hrms/employees/${id}`); }}
      />

      <div className="bg-white border border-neutral-200 rounded overflow-hidden" data-testid="employees-list">
        {query.isLoading ? (
          <div className="h-40 bg-neutral-100" aria-label="Loading employees" />
        ) : query.isError ? (
          <div className="p-4 text-13 text-red">Could not load employees.</div>
        ) : (query.data?.items.length ?? 0) === 0 ? (
          <Empty />
        ) : (
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c}
                    className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {query.data!.items.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  isFinanceView={isFinanceView}
                  onOpen={() => navigate(`/hrms/employees/${row.id}`)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="p-6">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">No employees</div>
      <p className="text-13 text-neutral-500 mt-1">
        Adjust filters, or add one from the top-right (HR only).
      </p>
    </div>
  );
}

function statusToVariant(s: string): { variant: StatusVariant; label: string } {
  switch (s) {
    case 'active':
      return { variant: 'ok', label: 'Active' };
    case 'on_leave':
      return { variant: 'awaiting', label: 'On Leave' };
    case 'probation':
      return { variant: 'pending', label: 'Probation' };
    case 'notice_period':
      return { variant: 'pending', label: 'Notice Period' };
    case 'inactive':
      return { variant: 'problem', label: 'Inactive' };
    default:
      return { variant: 'awaiting', label: s };
  }
}

function Row({
  row,
  isFinanceView,
  onOpen,
}: {
  row: EmployeeRow;
  isFinanceView: boolean;
  onOpen: () => void;
}) {
  const s = statusToVariant(row.status);
  const border =
    s.variant === 'problem'
      ? 'border-red'
      : s.variant === 'pending'
        ? 'border-amber'
        : s.variant === 'awaiting'
          ? 'border-neutral-400'
          : 'border-transparent';

  const cells: React.ReactNode[] = [];
  cells.push(<span className="text-13 text-neutral-500">{row.employee_code}</span>);
  cells.push(
    <div>
      <div className="text-13 text-neutral-900">{row.full_name}</div>
      {isFullEmployee(row) ? (
        <div className="text-11 text-neutral-500">{row.email}</div>
      ) : null}
    </div>,
  );

  if (isFinanceView) {
    cells.push(<span className="text-13 text-neutral-500">{row.department_id}</span>);
    cells.push(<span className="text-13 text-neutral-500">{row.designation_id}</span>);
    cells.push(
      <span className="text-13 text-neutral-900">{row.bank_account_masked ?? '—'}</span>,
    );
    cells.push(<StatusLabel variant={s.variant} label={s.label} />);
  } else if (isFullEmployee(row)) {
    cells.push(<span className="text-13 text-neutral-700 capitalize">{row.type.replace('_', ' ')}</span>);
    cells.push(<span className="text-13 text-neutral-500">{row.department_id}</span>);
    cells.push(<span className="text-13 text-neutral-500">{row.designation_id}</span>);
    cells.push(<span className="text-13 text-neutral-900">{row.email}</span>);
    cells.push(<span className="text-13 text-neutral-900">{fmtDate(row.joining_date + 'T00:00:00Z')}</span>);
    cells.push(<span className="text-13 text-neutral-500">{row.manager_id ?? '—'}</span>);
    cells.push(<TodayCell row={row} />);
    cells.push(<StatusLabel variant={s.variant} label={s.label} />);
  }

  return (
    <tr
      className="h-10 hover:bg-neutral-50 cursor-pointer border-b border-neutral-200"
      onClick={onOpen}
      data-testid={`employee-row-${row.id}`}
    >
      {cells.map((cell, i) => (
        <td key={i} className={i === 0 ? `px-3 border-l-2 ${border}` : 'px-3'}>
          {cell}
        </td>
      ))}
    </tr>
  );
}

function TodayCell({ row }: { row: EmployeeRow }) {
  const att = row.today_attendance;
  if (!att) return <span className="text-neutral-400 text-13">—</span>;
  const s = attendanceStyleForStatus(att.status as never);
  return <StatusLabel variant={s.variant} label={s.label} />;
}

function FiltersBar({
  filters,
  onChange,
  canManage,
}: {
  filters: EmployeeFilters;
  onChange: (f: EmployeeFilters) => void;
  canManage: boolean;
}) {
  return (
    <div className="flex items-end gap-3 flex-wrap">
      <label className="block">
        <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">
          Search
        </span>
        <input
          type="text"
          value={filters.q ?? ''}
          onChange={(e) => onChange({ ...filters, q: e.target.value })}
          placeholder="Name, code, email"
          className="h-8 px-3 text-13 bg-white border border-neutral-300 rounded w-[220px]"
          data-testid="employees-search"
        />
      </label>
      <Select
        label="Type"
        value={filters.type ?? ''}
        onChange={(v) => onChange({ ...filters, type: v || undefined })}
        options={[
          ['', 'Any type'],
          ['partner', 'Partner'],
          ['manager', 'Manager'],
          ['executive', 'Executive'],
          ['articled', 'Articled Assistant'],
          ['support', 'Support'],
        ]}
      />
      <Select
        label="Status"
        value={filters.status ?? ''}
        onChange={(v) => onChange({ ...filters, status: v || undefined })}
        options={[
          ['', 'Any status'],
          ['active', 'Active'],
          ['on_leave', 'On Leave'],
          ['probation', 'Probation'],
          ['notice_period', 'Notice Period'],
          ...(canManage ? ([['inactive', 'Inactive']] as const) : []),
        ]}
      />
      {canManage ? (
        <label className="flex items-center gap-2 text-13 text-neutral-700 h-8">
          <input
            type="checkbox"
            checked={!!filters.includeInactive}
            onChange={(e) => onChange({ ...filters, includeInactive: e.target.checked })}
          />
          Include inactive
        </label>
      ) : null}
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: (readonly [string, string])[];
}) {
  return (
    <label className="block">
      <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function exportCsv(rows: EmployeeRow[], columns: string[]) {
  if (!rows.length) return;
  const header = columns.join(',');
  const body = rows
    .map((r) =>
      columns
        .map((c) => {
          const map: Record<string, string | number | null | undefined> = {
            Code: r.employee_code,
            Name: r.full_name,
            Type: isFullEmployee(r) ? r.type : '',
            Department: r.department_id,
            Designation: r.designation_id,
            Email: isFullEmployee(r) ? r.email : '',
            'Joining date': isFullEmployee(r) ? r.joining_date : '',
            Manager: isFullEmployee(r) ? r.manager_id ?? '' : '',
            Today: r.today_attendance?.status ?? '',
            Status: r.status,
            Bank: r.bank_account_masked ?? '',
          };
          const v = map[c] ?? '';
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
  a.download = `employees-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
