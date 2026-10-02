import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download } from 'lucide-react';
import { PageHeader, Card, Table, Row, Cell, FilterBar, Select, QueryState } from '@/modules/workstation/components';
import { tasksApi, formatMinutes } from '@/modules/workstation/tasks/api';
import { Variance } from '@/modules/workstation/tasks/ui';

/**
 * /workstation/tasks/reports — employee work time and the period reports.
 *
 * Each tab is one server-side aggregate. The browser sorts and exports what
 * it is given; it never recomputes a total.
 */
type Tab = 'employee' | 'client' | 'project' | 'estimate' | 'timesheet';

const TABS: [Tab, string][] = [
  ['employee', 'Employee-wise'],
  ['client', 'Client-wise'],
  ['project', 'Project-wise'],
  ['estimate', 'Estimated vs actual'],
  ['timesheet', 'Daily / weekly'],
];

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

export function TaskReportsPage() {
  const [tab, setTab] = useState<Tab>('employee');
  const [preset, setPreset] = useState('30');
  const range = preset === 'all' ? {} : { from: daysAgo(Number(preset)), to: today() };

  return (
    <div data-testid="task-reports">
      <Link to="/workstation/tasks" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900 mb-3">
        <ArrowLeft size={14} strokeWidth={1.75} /> Tasks
      </Link>
      <PageHeader
        title="Task reports"
        subtitle="Work time as recorded by the server, grouped the way you need to read it."
      />

      <FilterBar>
        <Select
          label="Period"
          value={preset}
          onChange={setPreset}
          options={[
            { value: '1', label: 'Today and yesterday' },
            { value: '7', label: 'Last 7 days' },
            { value: '30', label: 'Last 30 days' },
            { value: '90', label: 'Last 90 days' },
            { value: 'all', label: 'All time' },
          ]}
        />
        <Select label="Report" value={tab} onChange={(v) => setTab(v as Tab)} options={TABS.map(([v, l]) => ({ value: v, label: l }))} />
      </FilterBar>

      {tab === 'employee' ? <EmployeeReport range={range} /> : null}
      {tab === 'client' ? <DimensionReport kind="client" range={range} /> : null}
      {tab === 'project' ? <DimensionReport kind="project" range={range} /> : null}
      {tab === 'estimate' ? <EstimateReport range={range} /> : null}
      {tab === 'timesheet' ? <TimesheetReport range={range} /> : null}
    </div>
  );
}

function EmployeeReport({ range }: { range: { from?: string; to?: string } }) {
  const q = useQuery({ queryKey: ['tasks.byEmployee', range], queryFn: () => tasksApi.byEmployee(range) });
  return (
    <QueryState query={q} empty={<Empty />}>
      {(d) => (
        <Card
          title="Employee work time"
          right={<ExportButton filename="employee-work-time.csv" rows={d.items.map((r) => ({
            Employee: r.employee_name, Code: r.employee_code, Department: r.department ?? '',
            Tasks: r.total, Completed: r.completed, 'In progress': r.in_progress, Pending: r.pending,
            Overdue: r.overdue, 'Work minutes': r.work_minutes, 'Average minutes': r.average_task_minutes,
          }))} />}
        >
          <Table head={['Employee', 'Tasks', 'Completed', 'In progress', 'Pending', 'Overdue', 'Work time', 'Average / task']}>
            {d.items.map((r) => (
              <Row key={r.employee_id}>
                <Cell>
                  {r.employee_name}
                  {r.department ? <span className="block text-11 text-neutral-400">{r.department}</span> : null}
                </Cell>
                <Cell muted>{r.total}</Cell>
                <Cell muted>{r.completed}</Cell>
                <Cell muted>{r.in_progress}</Cell>
                <Cell muted>{r.pending}</Cell>
                <Cell className={r.overdue > 0 ? 'text-red' : ''}>{r.overdue}</Cell>
                <Cell><span className="tabular-nums">{formatMinutes(r.work_minutes)}</span></Cell>
                <Cell muted><span className="tabular-nums">{formatMinutes(r.average_task_minutes)}</span></Cell>
              </Row>
            ))}
          </Table>
        </Card>
      )}
    </QueryState>
  );
}

function DimensionReport({ kind, range }: { kind: 'client' | 'project'; range: { from?: string; to?: string } }) {
  const q = useQuery({
    queryKey: ['tasks.byDimension', kind, range],
    queryFn: () => (kind === 'client' ? tasksApi.byClient(range) : tasksApi.byProject(range)),
  });
  return (
    <QueryState query={q} empty={<Empty />}>
      {(d) => (
        <Card
          title={kind === 'client' ? 'Client-wise' : 'Project-wise'}
          right={<ExportButton filename={`${kind}-work-time.csv`} rows={d.items.map((r) => ({
            [kind === 'client' ? 'Client' : 'Project']: r.label, Tasks: r.total, Completed: r.completed,
            'Work minutes': r.work_minutes, 'Estimated minutes': r.estimated_minutes,
          }))} />}
        >
          <Table head={[kind === 'client' ? 'Client' : 'Project', 'Tasks', 'Completed', 'Estimated', 'Work time']}>
            {d.items.map((r) => (
              <Row key={r.id ?? 'none'}>
                <Cell>{r.label}</Cell>
                <Cell muted>{r.total}</Cell>
                <Cell muted>{r.completed}</Cell>
                <Cell muted><span className="tabular-nums">{r.estimated_minutes ? formatMinutes(r.estimated_minutes) : '—'}</span></Cell>
                <Cell><span className="tabular-nums">{formatMinutes(r.work_minutes)}</span></Cell>
              </Row>
            ))}
          </Table>
        </Card>
      )}
    </QueryState>
  );
}

function EstimateReport({ range }: { range: { from?: string; to?: string } }) {
  const q = useQuery({ queryKey: ['tasks.estimate', range], queryFn: () => tasksApi.estimatedVsActual(range) });
  return (
    <QueryState query={q} empty={<Empty />}>
      {(d) => (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3">
            <Box label="Completed with an estimate" text={String(d.totals.count)} />
            <Box label="Estimated" text={formatMinutes(d.totals.estimated_minutes)} />
            <Box label="Actual" text={formatMinutes(d.totals.actual_minutes)} />
            <Box label="Under estimate" text={String(d.totals.under)} />
            <Box label="Over estimate" text={String(d.totals.over)} />
          </div>
          <Card
            title="Estimated vs actual"
            right={<ExportButton filename="estimated-vs-actual.csv" rows={d.items.map((r) => ({
              Task: r.title, Employee: r.employee_name, Priority: r.priority,
              'Estimated minutes': r.estimated_minutes, 'Actual minutes': r.actual_minutes,
              'Variance minutes': r.variance_minutes, Completed: r.completed_at ?? '',
            }))} />}
          >
            <Table head={['Task', 'Employee', 'Estimated', 'Actual', 'Difference', 'Completed']}>
              {d.items.map((r) => (
                <Row key={r.task_id}>
                  <Cell>{r.title}</Cell>
                  <Cell muted>{r.employee_name}</Cell>
                  <Cell muted><span className="tabular-nums">{formatMinutes(r.estimated_minutes)}</span></Cell>
                  <Cell><span className="tabular-nums">{formatMinutes(r.actual_minutes)}</span></Cell>
                  <Cell><Variance minutes={r.variance_minutes} /></Cell>
                  <Cell muted>{r.completed_at ? new Date(r.completed_at).toLocaleDateString('en-IN') : '—'}</Cell>
                </Row>
              ))}
            </Table>
          </Card>
          <p className="text-12 text-neutral-500 mt-2">{d.note}</p>
        </>
      )}
    </QueryState>
  );
}

function TimesheetReport({ range }: { range: { from?: string; to?: string } }) {
  const q = useQuery({ queryKey: ['tasks.timesheet', range], queryFn: () => tasksApi.timesheet(range) });
  return (
    <QueryState query={q} empty={<Empty />}>
      {(d) => (
        <Card
          title={`Work logged — ${formatMinutes(d.total_minutes)} total`}
          right={<ExportButton filename="daily-work.csv" rows={d.days.map((r) => ({ Date: r.date, Minutes: r.minutes, Sessions: r.sessions, Employees: r.employees }))} />}
        >
          <Table head={['Date', 'Work time', 'Sessions', 'Employees']}>
            {d.days.map((r) => (
              <Row key={r.date}>
                <Cell>{r.date}</Cell>
                <Cell><span className="tabular-nums">{formatMinutes(r.minutes)}</span></Cell>
                <Cell muted>{r.sessions}</Cell>
                <Cell muted>{r.employees}</Cell>
              </Row>
            ))}
          </Table>
        </Card>
      )}
    </QueryState>
  );
}

function Box({ label, text }: { label: string; text: string }) {
  return (
    <div className="bg-white border border-neutral-200 rounded p-3">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
      <div className="text-16 font-semibold text-neutral-900 mt-0.5">{text}</div>
    </div>
  );
}

function Empty() {
  return <div className="px-4 py-6 text-13 text-neutral-500">No work recorded in this period.</div>;
}

/** CSV of exactly the rows on screen. */
function ExportButton({ filename, rows }: { filename: string; rows: Record<string, string | number>[] }) {
  function download() {
    if (!rows.length) return;
    const cols = Object.keys(rows[0]);
    const esc = (v: unknown) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }
  return (
    <button type="button" onClick={download} disabled={!rows.length} className="h-7 px-2 inline-flex items-center gap-1 text-12 rounded border border-neutral-300 bg-white hover:bg-neutral-50 disabled:opacity-40">
      <Download size={12} strokeWidth={1.75} /> CSV
    </button>
  );
}
