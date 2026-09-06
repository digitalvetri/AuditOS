/**
 * Attendance breakdown donut — HR/MD primary slot.
 *
 * §7 chart rules: neutral ramp + single gold for the highlighted series
 * (Present). Flat fills only, square bar caps, no drop shadows.
 */
import { useQuery } from '@tanstack/react-query';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { attendanceApi } from '@/modules/attendance/api';

const COLORS = {
  present: '#b8892b', // gold — the "healthy" highlight
  late: '#c07a1a', // amber
  absent: '#a8321a', // red
  wfh: '#a8a196', // neutral-400
  on_leave: '#585249', // neutral-600
};

export function AttendanceBreakdownWidget() {
  const q = useQuery({
    queryKey: ['attendance', 'today'],
    queryFn: attendanceApi.today,
  });

  if (q.isLoading) return <div className="h-40 bg-neutral-100" aria-label="Loading" />;
  if (!q.data?.counts) return <div className="text-13 text-neutral-500">Breakdown unavailable.</div>;
  const c = q.data.counts;
  const data = [
    { key: 'present', name: 'Present', value: c.present },
    { key: 'late', name: 'Late', value: c.late },
    { key: 'absent', name: 'Absent', value: c.absent },
    { key: 'wfh', name: 'WFH', value: c.wfh },
    { key: 'on_leave', name: 'On Leave', value: c.on_leave },
  ].filter((d) => d.value > 0);

  return (
    <div data-testid="attendance-breakdown">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">
        Attendance breakdown
      </div>
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 items-center gap-4">
        <div style={{ height: 180 }}>
          {data.length === 0 ? (
            <div className="text-13 text-neutral-500">No attendance data yet today.</div>
          ) : (
            <ResponsiveContainer>
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  cx="50%"
                  cy="50%"
                  innerRadius={44}
                  outerRadius={72}
                  strokeWidth={0}
                  isAnimationActive={false}
                >
                  {data.map((d) => (
                    <Cell key={d.key} fill={(COLORS as Record<string, string>)[d.key] ?? '#a8a196'} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: '#ffffff',
                    border: '1px solid #d0cabf',
                    borderRadius: 4,
                    fontSize: 12,
                    color: '#171512',
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
        <ul className="text-13 space-y-1 tabular-nums">
          {data.map((d) => (
            <li key={d.key} className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span
                  className="inline-block w-2 h-2"
                  style={{ background: (COLORS as Record<string, string>)[d.key] ?? '#a8a196' }}
                  aria-hidden
                />
                <span className="text-neutral-700">{d.name}</span>
              </span>
              <span className="text-neutral-900">{d.value}</span>
            </li>
          ))}
          {data.length === 0 ? <li className="text-neutral-500">—</li> : null}
        </ul>
      </div>
    </div>
  );
}
