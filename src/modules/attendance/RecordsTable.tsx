/**
 * Attendance records table per §8.2.
 *
 * Columns: Employee | Date | Check-in | Check-out | Hours | Location | Type | Status
 *
 * Filters: date range, employee, department, status, location type.
 * All filtering happens server-side — this component only shapes the query.
 *
 * §7 design: row height 40px, no zebra, sticky header, hover neutral-50 only.
 * Status via left-border encoding on the leftmost cell.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { attendanceApi, type AttendanceWithEmployee } from './api';
import { fmtDate, fmtTime, fmtDuration } from '@/lib/format';
import { addDays, istToday } from '@/lib/dates';
import { styleForStatus } from './statusStyle';
import type { AttendanceStatus, LocationType } from '@/data/models';

const STATUS_OPTIONS: { value: AttendanceStatus | ''; label: string }[] = [
  { value: '', label: 'Any status' },
  { value: 'present', label: 'Present' },
  { value: 'late', label: 'Late' },
  { value: 'absent', label: 'Absent' },
  { value: 'half_day', label: 'Half Day' },
  { value: 'wfh', label: 'Work From Home' },
  { value: 'on_leave', label: 'On Leave' },
  { value: 'missing_check_in', label: 'Missing Check-in' },
  { value: 'missing_check_out', label: 'Missing Check-out' },
];

const LOCATION_OPTIONS: { value: LocationType | ''; label: string }[] = [
  { value: '', label: 'Any location' },
  { value: 'office', label: 'Office' },
  { value: 'client_site', label: 'Client site' },
  { value: 'remote', label: 'Remote' },
  { value: 'field', label: 'Field' },
];

interface Filters {
  from: string;
  to: string;
  status: AttendanceStatus | '';
  locationType: LocationType | '';
  employeeId?: string;
}

interface RecordsTableProps {
  scopeHint?: 'self' | 'department' | 'organisation';
  /** Pin the table to one employee (used by EmployeeDetail's Attendance tab). */
  defaultEmployeeId?: string;
}

export function RecordsTable({ scopeHint, defaultEmployeeId }: RecordsTableProps) {
  const today = istToday();
  const [filters, setFilters] = useState<Filters>({
    from: addDays(today, -30),
    to: today,
    status: '',
    locationType: '',
    employeeId: defaultEmployeeId,
  });

  const query = useQuery({
    queryKey: ['attendance', 'list', filters],
    queryFn: () => attendanceApi.list(filters),
  });

  const scope = query.data?.scope ?? scopeHint ?? 'self';
  const showEmployee = scope !== 'self';

  return (
    <section data-testid="attendance-records">
      <FiltersBar
        filters={filters}
        onChange={setFilters}
        onReset={() =>
          setFilters({
            from: addDays(today, -30),
            to: today,
            status: '',
            locationType: '',
          })
        }
      />
      <div className="mt-4 bg-white border border-neutral-200 rounded overflow-hidden">
        {query.isLoading ? (
          <div className="h-40 bg-neutral-100" aria-label="Loading records" />
        ) : query.isError ? (
          <div className="p-4 text-13 text-red">Could not load records.</div>
        ) : (query.data?.items.length ?? 0) === 0 ? (
          <Empty />
        ) : (
          <Table rows={query.data!.items} showEmployee={showEmployee} />
        )}
      </div>
    </section>
  );
}

function FiltersBar({
  filters,
  onChange,
  onReset,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  onReset: () => void;
}) {
  return (
    <div className="flex items-end gap-3 flex-wrap">
      <FilterInput
        label="From"
        type="date"
        value={filters.from}
        onChange={(v) => onChange({ ...filters, from: v })}
      />
      <FilterInput
        label="To"
        type="date"
        value={filters.to}
        onChange={(v) => onChange({ ...filters, to: v })}
      />
      <FilterSelect
        label="Status"
        value={filters.status}
        onChange={(v) => onChange({ ...filters, status: v as AttendanceStatus | '' })}
        options={STATUS_OPTIONS}
      />
      <FilterSelect
        label="Location"
        value={filters.locationType}
        onChange={(v) => onChange({ ...filters, locationType: v as LocationType | '' })}
        options={LOCATION_OPTIONS}
      />
      <button
        type="button"
        onClick={onReset}
        className="h-8 px-3 text-13 text-neutral-500 hover:text-neutral-900"
      >
        Reset
      </button>
    </div>
  );
}

function FilterInput({
  label,
  ...rest
}: { label: string; value: string; onChange: (v: string) => void; type: string }) {
  return (
    <label className="block">
      <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">
        {label}
      </span>
      <input
        type={rest.type}
        value={rest.value}
        onChange={(e) => rest.onChange(e.target.value)}
        className="h-8 px-3 text-13 bg-white border border-neutral-300 rounded"
      />
    </label>
  );
}

function FilterSelect<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <label className="block">
      <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Empty() {
  return (
    <div className="p-6">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">No records</div>
      <p className="text-13 text-neutral-500 mt-1">Adjust the filters to see attendance rows.</p>
    </div>
  );
}

function Table({ rows, showEmployee }: { rows: AttendanceWithEmployee[]; showEmployee: boolean }) {
  const cols = useMemo(() => {
    const base = [
      showEmployee ? 'Employee' : null,
      'Date',
      'Check-in',
      'Check-out',
      'Hours',
      'Location',
      'Type',
      'Status',
    ].filter(Boolean) as string[];
    return base;
  }, [showEmployee]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse tabular-nums">
        <thead className="sticky top-0 bg-white">
          <tr>
            {cols.map((c) => (
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
          {rows.map((r) => (
            <Row key={r.id} row={r} showEmployee={showEmployee} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ row, showEmployee }: { row: AttendanceWithEmployee; showEmployee: boolean }) {
  const s = styleForStatus(row.status);
  const border =
    s.variant === 'problem'
      ? 'border-red'
      : s.variant === 'pending'
        ? 'border-amber'
        : s.variant === 'awaiting'
          ? 'border-neutral-400'
          : 'border-transparent';
  const pendingCorrection = row.correction_status === 'requested';

  return (
    <tr className="h-10 hover:bg-neutral-50 border-b border-neutral-200" data-testid={`att-row-${row.date}`}>
      {showEmployee ? (
        <td className="px-3 border-l-2 border-transparent">
          <div className="text-13 text-neutral-900">{row.employee?.full_name ?? '—'}</div>
          <div className="text-11 text-neutral-500">{row.employee?.employee_code ?? ''}</div>
        </td>
      ) : null}
      <td className={`px-3 border-l-2 ${border}`}>
        <span className="text-13 text-neutral-900">{fmtDate(row.date + 'T00:00:00Z')}</span>
        {pendingCorrection ? (
          <span className="ml-2 text-11 text-amber" title="Correction pending review">
            · correction pending
          </span>
        ) : null}
      </td>
      <td className="px-3 text-13 text-neutral-900">
        {row.check_in_at ? fmtTime(row.check_in_at) : <span className="text-neutral-400">—</span>}
      </td>
      <td className="px-3 text-13 text-neutral-900">
        {row.check_out_at ? fmtTime(row.check_out_at) : <span className="text-neutral-400">—</span>}
      </td>
      <td className="px-3 text-13 text-neutral-900">
        {row.worked_minutes != null ? fmtDuration(row.worked_minutes) : <span className="text-neutral-400">—</span>}
      </td>
      <td className="px-3 text-13 text-neutral-500">
        {row.check_in_location_id ?? (row.location_type === 'remote' ? 'Remote' : row.location_type === 'field' ? 'Field' : row.location_type === 'client_site' ? 'Client site' : '—')}
      </td>
      <td className="px-3 text-13 text-neutral-500">
        {row.location_type ? row.location_type.replace('_', ' ') : '—'}
      </td>
      <td className={`px-3 text-13 ${s.variant === 'ok' ? 'text-neutral-500 font-normal' : 'text-neutral-900 font-medium'}`}>
        {s.label}
      </td>
    </tr>
  );
}
