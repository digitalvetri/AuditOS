/**
 * Finance MIS — /api/reports/finance/:report (org-scope `reports.finance` or
 * `reports.all`). JSON for the on-screen table; `format=csv|xlsx` streams a
 * file, fetched with the session cookie and handed to the browser as a blob.
 */
import { api } from '@/services/api';
import { downloadFile } from '@/modules/workstation/invoices/download';

export type FinanceReportKey =
  | 'revenue-by-month'
  | 'revenue-by-service'
  | 'revenue-by-client'
  | 'unbilled'
  | 'dso'
  | 'collections'
  | 'profitability-client'
  | 'profitability-engagement'
  | 'utilisation'
  | 'tds-receivable';

export interface FinanceCatalogueItem {
  key: string;
  title: string;
  description: string;
}

export type FinanceColumnType = 'text' | 'money' | 'number' | 'percent' | 'hours' | 'boolean';

export interface FinanceColumn {
  key: string;
  label: string;
  type: FinanceColumnType;
}

export interface FinanceReport {
  report: string;
  title: string;
  from: string;
  to: string;
  columns: FinanceColumn[];
  rows: Record<string, unknown>[];
  totals: Record<string, unknown> | null;
  notes: string[];
}

/** Used when the catalogue endpoint is unavailable. */
export const FALLBACK_CATALOGUE: FinanceCatalogueItem[] = [
  { key: 'revenue-by-month', title: 'Revenue by month', description: 'Invoiced, credited and collected, month by month.' },
  { key: 'revenue-by-service', title: 'Revenue by service', description: 'Billing split by service line.' },
  { key: 'revenue-by-client', title: 'Revenue by client', description: 'Billing and collections per client.' },
  { key: 'unbilled', title: 'Unbilled work', description: 'Work done that has not been invoiced yet.' },
  { key: 'dso', title: 'Days sales outstanding', description: 'How long clients take to pay.' },
  { key: 'collections', title: 'Receipts register', description: 'Cash and TDS received in the period, by mode and client, net of refunds.' },
  { key: 'profitability-client', title: 'Profitability by client', description: 'Fees against staff cost per client.' },
  { key: 'profitability-engagement', title: 'Profitability by engagement', description: 'Fees against staff cost per engagement.' },
  { key: 'utilisation', title: 'Staff utilisation', description: 'Logged and chargeable hours per person.' },
  { key: 'tds-receivable', title: 'TDS receivable', description: 'TDS deducted by clients and certificates pending, for a financial year.' },
];

export interface FinanceQuery {
  from?: string;
  to?: string;
  fy?: string;
}

function qs(q: FinanceQuery & { format?: string }): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const financeReportsApi = {
  catalogue: () => api.get<{ items: FinanceCatalogueItem[] }>('/api/reports/finance'),
  run: (key: string, q: FinanceQuery) =>
    api.get<FinanceReport>(`/api/reports/finance/${encodeURIComponent(key)}${qs(q)}`),
  /** Download the report as a CSV or Excel file, authenticated by the session cookie. */
  download: async (key: string, q: FinanceQuery, format: 'csv' | 'xlsx'): Promise<void> => {
    const res = await fetch(`/api/reports/finance/${encodeURIComponent(key)}${qs({ ...q, format })}`, {
      credentials: 'include',
    });
    if (!res.ok) {
      let msg = `Export failed (HTTP ${res.status}).`;
      try {
        const j = await res.json();
        if (j?.error?.message) msg = j.error.message;
      } catch { /* body was not JSON */ }
      throw new Error(msg);
    }
    const disp = res.headers.get('content-disposition') ?? '';
    const name = /filename="?([^";]+)"?/.exec(disp)?.[1]
      ?? `${key}-${q.fy ?? `${q.from ?? ''}_${q.to ?? ''}`}.${format}`;
    const url = URL.createObjectURL(await res.blob());
    downloadFile(url, name);
    // Give the browser a moment to start the download before the URL goes.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};

/** Current Indian financial year (Apr 1 – Mar 31) containing `today` ('YYYY-MM-DD'). */
export function currentFy(today: string): { from: string; to: string; label: string } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return { from: `${start}-04-01`, to: `${start + 1}-03-31`, label: fyLabel(start) };
}

/** 2026 → '2026-27' */
export function fyLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}
