/**
 * Activity tab — recent audit log entries for an employee.
 * Auth: caller with audit.read.hr/all OR the subject themself (self view).
 */
import { useQuery } from '@tanstack/react-query';
import { employeeApi } from './api';
import { fmtDateTime } from '@/lib/format';

export function ActivityTab({ employeeId }: { employeeId: string }) {
  const q = useQuery({
    queryKey: ['employee', employeeId, 'activity'],
    queryFn: () => employeeApi.activity(employeeId),
    retry: false,
  });

  if (q.isLoading) return <div className="h-40 bg-neutral-100" aria-label="Loading activity" />;
  if (q.isError) {
    return (
      <div className="p-4 text-13 text-neutral-500 border-l-2 border-neutral-400 pl-3">
        Audit access required.
      </div>
    );
  }
  const rows = q.data?.items ?? [];
  if (!rows.length) {
    return <div className="p-4 text-13 text-neutral-500">No activity yet.</div>;
  }

  return (
    <div className="bg-white border border-neutral-200 rounded overflow-hidden">
      <table className="w-full border-collapse tabular-nums">
        <thead>
          <tr>
            {['When', 'Actor', 'Action', 'Entity'].map((c) => (
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
            <tr key={r.id} className="border-b border-neutral-200">
              <td className="px-3 py-2 text-13 text-neutral-900">{fmtDateTime(r.created_at)}</td>
              <td className="px-3 py-2 text-13 text-neutral-500">{r.actor_user_id ?? '—'}</td>
              <td className="px-3 py-2 text-13 text-neutral-900">{r.action}</td>
              <td className="px-3 py-2 text-13 text-neutral-500">
                {r.entity_type} · {r.entity_id}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
