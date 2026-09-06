/**
 * /me/payslips — the caller's own published payslips.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { payrollApi } from '@/modules/payroll/api';
import { inr } from '@/lib/format';
import { useAuth } from '@/platform/auth/AuthContext';

export function MyPayslipsPage() {
  const { session } = useAuth();
  const employeeId = session?.employee?.id;
  const q = useQuery({
    queryKey: ['payroll', 'payslips', 'mine'],
    queryFn: () => payrollApi.payslips.list({ employeeId }),
    enabled: !!employeeId,
  });
  const items = q.data?.items ?? [];

  return (
    <div className="max-w-[840px] mx-auto space-y-6">
      <header>
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Me</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">My payslips</h1>
      </header>
      <div className="bg-white border border-neutral-200 rounded overflow-hidden" data-testid="my-payslips">
        {q.isLoading ? (
          <div className="h-40 bg-neutral-100" />
        ) : items.length === 0 ? (
          <div className="p-6 text-13 text-neutral-500">No payslips published yet.</div>
        ) : (
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                {['Period', 'Gross', 'Net', 'Published', ''].map((c) => (
                  <th key={c} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id} className="border-b border-neutral-200" data-testid={`my-payslip-${p.id}`}>
                  <td className="px-3 py-2 text-13 text-neutral-900">{p.period_start} → {p.period_end}</td>
                  <td className="px-3 py-2 text-13 text-neutral-900">{inr(p.gross_paise)}</td>
                  <td className="px-3 py-2 text-13 text-neutral-900 font-medium">{inr(p.net_paise)}</td>
                  <td className="px-3 py-2 text-13 text-neutral-500">{p.published_at.slice(0, 10)}</td>
                  <td className="px-3 py-2">
                    <Link to={`/me/payslips/${p.id}`} className="text-13 text-gold hover:text-gold-hover">Open →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
