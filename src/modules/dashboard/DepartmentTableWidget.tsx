/**
 * Department table (§6.2): Department | Headcount | Present | Absent | Leave.
 */
import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from './api';

export function DepartmentTableWidget() {
  const q = useQuery({
    queryKey: ['dashboard', 'departments'],
    queryFn: dashboardApi.departments,
  });

  if (q.isLoading) return <div className="h-40 bg-neutral-100" aria-label="Loading" />;
  if (q.isError) return <div className="text-13 text-neutral-500">Departments unavailable.</div>;
  const rows = q.data?.items ?? [];
  if (rows.length === 0)
    return <div className="text-13 text-neutral-500">No departments in scope.</div>;

  return (
    <div data-testid="department-table">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Departments</div>
      <table className="w-full mt-3 border-collapse tabular-nums">
        <thead>
          <tr>
            {['Department', 'Headcount', 'Present', 'Absent', 'Leave'].map((c) => (
              <th
                key={c}
                className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 py-2 border-b border-neutral-200 font-medium"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-neutral-200 last:border-b-0">
              <td className="py-2 text-13 text-neutral-900">{r.name}</td>
              <td className="py-2 text-13 text-neutral-900">{r.headcount}</td>
              <td className="py-2 text-13 text-neutral-900">{r.present}</td>
              <td className={'py-2 text-13 ' + (r.absent > 0 ? 'text-neutral-900 font-medium' : 'text-neutral-500')}>
                {r.absent}
              </td>
              <td className="py-2 text-13 text-neutral-700">{r.on_leave}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
