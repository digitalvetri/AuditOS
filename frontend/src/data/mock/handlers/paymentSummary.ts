/**
 * Payment summary (mock mode only) — a small, fixed sample so the dashboard's
 * billing tiles and cash-flow chart have something to draw when running with
 * VITE_MOCK_MODE=true. The real API derives all of this from invoices.
 *
 *   GET /api/payment-summary
 *   GET /api/payment-summary/monthly?months=6
 */
import { http } from 'msw';
import { ok, withAuth } from '../middleware';

/** ₹1 lakh in paise. */
const L = 1_00_000 * 100;

/** 'YYYY-MM' for the `count` months ending this month, oldest first. */
function window(count: number): string[] {
  const now = new Date();
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (count - 1 - i), 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

const BILLED = [11.4, 12.6, 10.6, 13.8, 14.6, 16.5, 12.2, 13.1, 11.9, 15.2, 14.1, 16.0];
const COLLECTED = [9.8, 11.0, 10.2, 11.8, 13.4, 10.6, 11.1, 12.0, 10.4, 13.8, 12.9, 13.2];

const CLIENTS = [
  { client_id: 'mock-kaveri', client_name: 'Kaveri Exports Pvt Ltd', client_code: 'CLI-1001', invoiced: 4.26, paid: 3.08, overdue: 1.18 },
  { client_id: 'mock-velan', client_name: 'Velan Motors', client_code: 'CLI-1005', invoiced: 2.1, paid: 1.24, overdue: 0.86 },
  { client_id: 'mock-annai', client_name: 'Annai Textiles', client_code: 'CLI-1003', invoiced: 1.6, paid: 1.355, overdue: 0 },
  { client_id: 'mock-nila', client_name: 'Nila Pharma LLP', client_code: 'CLI-1010', invoiced: 3.4, paid: 2.78, overdue: 0 },
];

export const paymentSummaryHandlers = [
  http.get('/api/payment-summary/monthly', withAuth(async ({ request }) => {
    const n = Math.max(1, Math.min(12, Number(new URL(request.url).searchParams.get('months') ?? '6')));
    const months = window(n).map((month, i) => ({
      month,
      billed_paise: Math.round(BILLED[i] * L),
      collected_paise: Math.round(COLLECTED[i] * L),
      invoices: 8 + i,
      payments: 6 + i,
    }));
    return ok({ months, avg_days_to_collect: 23 });
  })),

  http.get('/api/payment-summary', withAuth(async () => {
    const clients = CLIENTS.map((c) => {
      const invoiced = Math.round(c.invoiced * L);
      const paid = Math.round(c.paid * L);
      const overdue = Math.round(c.overdue * L);
      return {
        client_id: c.client_id, client_name: c.client_name, client_code: c.client_code,
        contact_number: null, email: null, invoices: 6, open_invoices: invoiced > paid ? 2 : 0,
        invoiced_paise: invoiced, paid_paise: paid, pending_paise: invoiced - paid, overdue_paise: overdue,
        oldest_due_date: overdue ? '2026-09-21' : null, last_payment_on: '2026-09-28',
        status: overdue ? 'overdue' : invoiced > paid ? 'partial' : 'paid',
      };
    });
    const sum = (k: 'invoiced_paise' | 'paid_paise' | 'pending_paise' | 'overdue_paise') => clients.reduce((s, c) => s + c[k], 0);
    return ok({
      totals: {
        invoiced_paise: sum('invoiced_paise'), paid_paise: sum('paid_paise'), pending_paise: sum('pending_paise'),
        overdue_paise: sum('overdue_paise'), collected_this_month_paise: Math.round(10.6 * L),
        collection_rate: Math.round((sum('paid_paise') / sum('invoiced_paise')) * 100) / 100,
        invoices: 24, clients: clients.length, clients_with_dues: clients.filter((c) => c.pending_paise > 0).length,
      },
      ageing: { current: Math.round(0.9 * L), d1_30: Math.round(0.86 * L), d31_60: Math.round(1.18 * L), d61_90: 0, d90_plus: 0 },
      clients,
      recent_payments: [],
    });
  })),
];
