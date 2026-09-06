/**
 * Dashboard widgets for attendance (§6.2).
 *
 * Hero (employee): today's card — subsumes the Dashboard greeting.
 * Primary (dept-manager / hr / md): KPI row for the org / dept.
 *
 * This module's registration is imported once at App boot; no wiring in
 * Dashboard.tsx or Sidebar.tsx.
 */
import { useQuery } from '@tanstack/react-query';
import { registerWidget } from '@/platform/dashboard/registry';
import { TodayCard } from './TodayCard';
import { attendanceApi } from './api';

function KpiRowWidget() {
  const q = useQuery({
    queryKey: ['attendance', 'today'],
    queryFn: attendanceApi.today,
  });
  if (q.isLoading) return <div className="h-16 bg-neutral-100" aria-label="Loading KPIs" />;
  if (q.isError || !q.data?.counts) {
    return <div className="text-13 text-neutral-500">KPIs unavailable.</div>;
  }
  const c = q.data.counts;
  const items: Array<[label: string, value: number, emphasis?: boolean]> = [
    ['Total', c.total],
    ['Present', c.present],
    ['Late', c.late, c.late > 0],
    ['Absent', c.absent, c.absent > 0],
    ['On leave', c.on_leave],
    ['Missing check-out', c.missing_check_out, c.missing_check_out > 0],
  ];
  return (
    <div>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">
        Today's attendance
      </div>
      <div className="mt-3 grid grid-cols-3 md:grid-cols-6 gap-3 tabular-nums" data-testid="kpi-row">
        {items.map(([label, value, emph]) => (
          <div key={label}>
            <div className={'text-20 ' + (emph ? 'text-neutral-900 font-semibold' : 'text-neutral-900')}>
              {value}
            </div>
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mt-1">
              {label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

registerWidget({
  id: 'hrms.attendance-today',
  slot: 'hero',
  // Everyone with a self-scope check-in permission sees the today card.
  roles: ['employee', 'dept_manager', 'hr_admin', 'finance_admin', 'md'],
  scope: 'self',
  component: TodayCard,
  order: 10,
});

registerWidget({
  id: 'hrms.attendance-kpis',
  slot: 'primary',
  roles: ['dept_manager', 'hr_admin', 'md'],
  scope: 'organisation',
  component: KpiRowWidget,
  order: 10,
});
