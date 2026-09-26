/**
 * Tally Export API client — docs/tally-export/README.md.
 *
 * Talks to /api/tally-export/*. Types mirror server/src/modules/tally-export
 * /types.ts so a shape change on either side reads as a compile error at
 * the boundary instead of a runtime surprise on the mapping-review screen.
 */
import { api } from '@/services/api';

export type MatchType = 'contains' | 'regex' | 'exact';
export const MATCH_TYPES: readonly MatchType[] = ['contains', 'regex', 'exact'];

export type VoucherType = 'payment' | 'receipt' | 'contra' | 'journal';
export const VOUCHER_TYPES: readonly VoucherType[] = ['payment', 'receipt', 'contra', 'journal'];

export interface Rule {
  id: string;
  company_id: string | null;
  match_type: MatchType;
  pattern: string;
  ledger_name: string;
  voucher_type: VoucherType | null;
  priority: number;
  hit_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RuleInput {
  company_id: string | null;
  match_type: MatchType;
  pattern: string;
  ledger_name: string;
  voucher_type?: VoucherType | null;
  priority?: number;
}

export interface PreviewRow {
  statement_line_id: string;
  date: string;
  description: string;
  ref_number: string | null;
  debit_paise: number;
  credit_paise: number;
  direction: 'withdrawal' | 'deposit';
  matched_rule_id: string | null;
  ledger_name: string | null;
  voucher_type: VoucherType | null;
  voucher_number: string;
  new_ledger: boolean;
}

export interface Preview {
  rows: PreviewRow[];
  bankLedgerName: string;
}

export interface PreflightReport {
  company_id: string;
  bank_ledger_id: string;
  period_from: string;
  period_to: string;
  totals: {
    rows: number;
    mapped: number;
    unmapped: number;
    contra: number;
    vouchers: number;
    balance_mismatches: number;
  };
  ledgers: { ledger_name: string; voucher_count: number; new_ledger: boolean }[];
  errors: {
    kind: 'unmapped_row' | 'balance_mismatch' | 'date_out_of_range' | 'voucher_number_collision';
    statement_line_id?: string;
    voucher_number?: string;
    message: string;
  }[];
  warnings: { kind: 'new_ledger' | 'previously_exported'; message: string }[];
  rows: PreviewRow[];
}

export interface ExportHistoryRow {
  id: string;
  company_id: string;
  bank_ledger_id: string;
  period_from: string;
  period_to: string;
  kind: string;
  row_count: number;
  voucher_count: number;
  checksum: string | null;
  generated_by: string | null;
  generated_at: string;
}

export interface Scope {
  companyId: string;
  bankLedgerId: string;
  periodFrom: string;
  periodTo: string;
}

function toBody(s: Scope): Record<string, string> {
  return {
    company_id: s.companyId,
    bank_ledger_id: s.bankLedgerId,
    period_from: s.periodFrom,
    period_to: s.periodTo,
  };
}

export const tallyExportApi = {
  listRules: (companyId?: string) =>
    api.get<{ items: Rule[] }>(
      `/api/tally-export/rules${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ''}`,
    ),
  createRule: (input: RuleInput) =>
    api.post<Rule>('/api/tally-export/rules', input),
  updateRule: (id: string, patch: Partial<RuleInput>) =>
    api.patch<Rule>(`/api/tally-export/rules/${id}`, patch),
  deleteRule: (id: string) =>
    api.delete<{ ok: true }>(`/api/tally-export/rules/${id}`),

  preview: (scope: Scope) =>
    api.post<Preview>('/api/tally-export/preview', toBody(scope)),
  preflight: (scope: Scope) =>
    api.post<PreflightReport>('/api/tally-export/preflight', toBody(scope)),

  /**
   * XML: streams the Tally-XML envelope as a file download. Uses `fetch`
   * directly instead of the `api` helper so the browser sees the response
   * as `application/xml` bytes and not JSON.
   *
   * XLSX: still stubbed on the server until the §11 fixture arrives.
   */
  generateXml: async (scope: Scope): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch('/api/tally-export/generate', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...toBody(scope), format: 'xml' }),
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
    const filename = /filename="([^"]+)"/.exec(disp)?.[1] ?? `tally-vouchers-${scope.periodFrom}_${scope.periodTo}.xml`;
    return { blob: await res.blob(), filename };
  },

  history: (companyId: string, bankLedgerId?: string) =>
    api.get<{ items: ExportHistoryRow[] }>(
      `/api/tally-export/history?companyId=${encodeURIComponent(companyId)}`
      + (bankLedgerId ? `&bankLedgerId=${encodeURIComponent(bankLedgerId)}` : ''),
    ),
};
