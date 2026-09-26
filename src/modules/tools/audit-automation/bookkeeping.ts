import { api } from '@/services/api';

/**
 * Tally API client (Slice 1: Foundation).
 * Mirror of the audit-automation api.ts shape. Everything JSON —
 * Tally uploads (import/export) don't ship in Slice 1.
 */

export interface BookkeepingCompany {
  id: string;
  name: string;
  mailing_name: string | null;
  address: string | null;
  country: string;
  state: string | null;
  pin: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  base_currency: string;
  gst_registration_type: string;
  gstin: string | null;
  pan: string | null;
  tan: string | null;
  fy_begin_month: number;
  books_begin_from: string;
  active: boolean;
  created_at: string;
}

export interface BookkeepingFinancialYear {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  closed: boolean;
  created_at: string;
}

export interface BookkeepingGroup {
  id: string;
  name: string;
  parent_group_id: string | null;
  nature: 'assets' | 'liabilities' | 'income' | 'expenses';
  affects_pl: boolean;
  is_primary: boolean;
}

export interface BookkeepingGroupTreeNode extends BookkeepingGroup {
  children: BookkeepingGroupTreeNode[];
}

export interface BookkeepingLedger {
  id: string;
  name: string;
  group_id: string;
  opening_balance_paise: number;
  opening_balance_type: 'dr' | 'cr';
  opening_balance_as_of_fy_id: string | null;
  address: string | null;
  contact: string | null;
  gstin: string | null;
  pan: string | null;
  state: string | null;
  gst_registration_type: string | null;
  credit_period_days: number | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  tax_config: unknown;
  active: boolean;
}

export interface CreateBookkeepingCompanyInput {
  name: string;
  mailing_name?: string;
  address?: string;
  state?: string;
  pin?: string;
  phone?: string;
  email?: string;
  website?: string;
  gst_registration_type?: 'regular' | 'composition' | 'unregistered' | 'sez' | 'overseas';
  gstin?: string;
  pan?: string;
  tan?: string;
  fy_begin_month?: number;
  books_begin_from: string;
}

export interface CreateBookkeepingLedgerInput {
  name: string;
  group_id: string;
  opening_balance_paise?: number;
  opening_balance_type?: 'dr' | 'cr';
  opening_balance_as_of_fy_id?: string | null;
  address?: string;
  contact?: string;
  gstin?: string;
  pan?: string;
  state?: string;
  gst_registration_type?: string;
  credit_period_days?: number;
  bank_account_name?: string;
  bank_account_number?: string;
  bank_ifsc?: string;
}

export const bookkeepingApi = {
  // Companies
  listCompanies: () => api.get<{ items: BookkeepingCompany[] }>('/api/tally/companies'),
  getCompany: (id: string) => api.get<BookkeepingCompany>(`/api/tally/companies/${id}`),
  createCompany: (input: CreateBookkeepingCompanyInput) => api.post<BookkeepingCompany>('/api/tally/companies', input),
  updateCompany: (id: string, patch: Partial<CreateBookkeepingCompanyInput> & { active?: boolean }) =>
    api.patch<BookkeepingCompany>(`/api/tally/companies/${id}`, patch),

  // Financial years
  listFinancialYears: (companyId: string) =>
    api.get<{ items: BookkeepingFinancialYear[] }>(`/api/tally/companies/${companyId}/financial-years`),
  createFinancialYear: (companyId: string, input: { label: string; start_date: string; end_date: string }) =>
    api.post<BookkeepingFinancialYear>(`/api/tally/companies/${companyId}/financial-years`, input),
  closeFinancialYear: (companyId: string, fyId: string) =>
    api.patch<BookkeepingFinancialYear>(`/api/tally/companies/${companyId}/financial-years/${fyId}/close`, {}),

  // Groups
  listGroups: (companyId: string) => api.get<{ items: BookkeepingGroup[] }>(`/api/tally/companies/${companyId}/groups`),
  groupTree: (companyId: string) =>
    api.get<{ tree: BookkeepingGroupTreeNode[] }>(`/api/tally/companies/${companyId}/groups?tree=1`),
  createGroup: (companyId: string, input: {
    name: string; parent_group_id?: string | null;
    nature?: 'assets' | 'liabilities' | 'income' | 'expenses'; affects_pl?: boolean;
  }) => api.post<BookkeepingGroup>(`/api/tally/companies/${companyId}/groups`, input),
  updateGroup: (companyId: string, groupId: string, patch: {
    name?: string; parent_group_id?: string | null; affects_pl?: boolean;
  }) => api.patch<BookkeepingGroup>(`/api/tally/companies/${companyId}/groups/${groupId}`, patch),
  deleteGroup: (companyId: string, groupId: string) =>
    api.delete<void>(`/api/tally/companies/${companyId}/groups/${groupId}`),

  // Ledgers
  listLedgers: (companyId: string, filter: { group_id?: string; q?: string } = {}) => {
    const sp = new URLSearchParams();
    if (filter.group_id) sp.set('group_id', filter.group_id);
    if (filter.q) sp.set('q', filter.q);
    const s = sp.toString();
    return api.get<{ items: BookkeepingLedger[] }>(`/api/tally/companies/${companyId}/ledgers${s ? `?${s}` : ''}`);
  },
  getLedger: (companyId: string, ledgerId: string) =>
    api.get<BookkeepingLedger>(`/api/tally/companies/${companyId}/ledgers/${ledgerId}`),
  createLedger: (companyId: string, input: CreateBookkeepingLedgerInput) =>
    api.post<BookkeepingLedger>(`/api/tally/companies/${companyId}/ledgers`, input),
  updateLedger: (companyId: string, ledgerId: string, patch: Partial<CreateBookkeepingLedgerInput> & { active?: boolean }) =>
    api.patch<BookkeepingLedger>(`/api/tally/companies/${companyId}/ledgers/${ledgerId}`, patch),
  deleteLedger: (companyId: string, ledgerId: string) =>
    api.delete<void>(`/api/tally/companies/${companyId}/ledgers/${ledgerId}`),
};

// ════════════════════════════════════════════════════════════════════
// Slices 2+ — vouchers, reports, inventory, banking, GST, payroll,
// audit, import/export, backup, settings, dashboard, search.
// ════════════════════════════════════════════════════════════════════

export interface BookkeepingVoucherType {
  id: string;
  name: string;
  code: string;
  numbering_method: 'auto' | 'manual';
  prefix: string | null;
  suffix: string | null;
  start_number: number;
  current_number: number;
  affects_accounts: boolean;
  affects_stock: boolean;
  is_order: boolean;
  is_default: boolean;
  active: boolean;
}

export interface BookkeepingBillAllocationInput {
  bill_ref: string;
  method?: 'new' | 'against' | 'advance' | 'on_account';
  amount_paise: number;
  due_date?: string | null;
}

export interface BookkeepingVoucherEntry {
  id: string;
  ledger_id: string;
  ledger_name: string;
  entry_type: 'dr' | 'cr';
  amount_paise: number;
  narration: string | null;
  is_party_ledger: boolean;
  cost_centre: string | null;
  bank_date: string | null;
  reconciled_at: string | null;
  bill_allocations: { bill_ref: string; method: string; amount_paise: number; due_date: string | null }[];
}

export interface BookkeepingVoucherItem {
  id: string;
  stock_item_id: string;
  stock_item_name: string;
  godown_id: string | null;
  godown_name: string | null;
  batch_id: string | null;
  direction: 'in' | 'out';
  qty_milli: number;
  rate_paise: number;
  discount_pct: number;
  discount_paise: number;
  amount_paise: number;
  hsn_code: string | null;
  gst_rate_bp: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  cess_paise: number;
  description: string | null;
}

export interface BookkeepingVoucher {
  id: string;
  voucher_type_id: string;
  voucher_type_code: string;
  voucher_type_name?: string;
  voucher_number: string;
  date: string;
  financial_year_id: string;
  reference_number: string | null;
  reference_date: string | null;
  narration: string | null;
  party_ledger_id: string | null;
  party_name: string | null;
  place_of_supply: string | null;
  status: string;
  total_debit_paise: number;
  total_credit_paise: number;
  taxable_value_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  cess_paise: number;
  round_off_paise: number;
  grand_total_paise: number;
  due_date: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  entries?: BookkeepingVoucherEntry[];
  items?: BookkeepingVoucherItem[];
}

export interface CreateVoucherInput {
  voucher_type_id?: string;
  voucher_type_code?: string;
  date: string;
  voucher_number?: string;
  reference_number?: string | null;
  narration?: string | null;
  party_ledger_id?: string | null;
  place_of_supply?: string | null;
  due_date?: string | null;
  round_off_paise?: number;
  entries?: {
    ledger_id: string;
    entry_type: 'dr' | 'cr';
    amount_paise: number;
    narration?: string | null;
    is_party_ledger?: boolean;
    bill_allocations?: BookkeepingBillAllocationInput[];
  }[];
  items?: {
    stock_item_id: string;
    godown_id?: string | null;
    direction: 'in' | 'out';
    qty_milli: number;
    rate_paise?: number;
    discount_pct?: number;
    amount_paise?: number;
    hsn_code?: string | null;
    gst_rate_bp?: number;
    cgst_paise?: number;
    sgst_paise?: number;
    igst_paise?: number;
    description?: string | null;
  }[];
}

export interface BookkeepingPeriod { from?: string; to?: string; [k: string]: string | number | boolean | undefined }

export interface DayBookRow {
  voucher_id: string; date: string; voucher_type_code: string; voucher_type_name: string;
  voucher_number: string; party_name: string | null; narration: string | null;
  debit_paise: number; credit_paise: number; status: string; ledgers: string[];
}

export interface TrialBalanceRow {
  ledgerId: string; ledgerName: string; groupId: string; groupName: string;
  primaryGroupId: string; primaryGroupName: string; nature: string; affectsPL: boolean;
  openingPaise: number; debitPaise: number; creditPaise: number; closingPaise: number;
  closingDebitPaise: number; closingCreditPaise: number;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totals: {
    openingDebitPaise: number; openingCreditPaise: number;
    debitPaise: number; creditPaise: number;
    closingDebitPaise: number; closingCreditPaise: number;
    balanced: boolean; differencePaise: number;
  };
}

export interface ProfitAndLoss {
  income: { label: string; rows: { ledgerId: string; ledgerName: string; groupName: string; amountPaise: number }[]; totalPaise: number };
  expenses: { label: string; rows: { ledgerId: string; ledgerName: string; groupName: string; amountPaise: number }[]; totalPaise: number };
  netProfitPaise: number; grossProfitPaise: number; from: string | null; to: string | null;
}

export interface BalanceSheetGroup {
  groupId: string; groupName: string; amountPaise: number;
  ledgers: { ledgerId: string; ledgerName: string; amountPaise: number }[];
}

export interface BalanceSheet {
  assets: { groups: BalanceSheetGroup[]; totalPaise: number };
  liabilities: { groups: BalanceSheetGroup[]; totalPaise: number };
  netProfitPaise: number; differencePaise: number; balanced: boolean; asOf: string | null;
}

export interface LedgerStatement {
  ledger: { id: string; name: string; group_id: string; group_name: string };
  openingPaise: number; closingPaise: number; debitPaise: number; creditPaise: number;
  rows: {
    voucher_id: string; date: string; voucher_number: string; voucher_type_code: string;
    particulars: string; narration: string | null;
    debit_paise: number; credit_paise: number; running_balance_paise: number;
  }[];
}

export interface OutstandingBill {
  bill_ref: string; date: string; due_date: string | null; voucher_id: string;
  amount_paise: number; settled_paise: number; pending_paise: number;
  days_overdue: number; ageing_bucket: string;
}

export interface Outstandings {
  side: 'receivable' | 'payable';
  as_of: string;
  totalPaise: number;
  parties: {
    ledger_id: string; ledger_name: string; total_paise: number;
    bill_total_paise: number; on_account_paise: number; bills: OutstandingBill[];
  }[];
  ageing: { key: string; label: string; amount_paise: number }[];
}

export interface RegisterReport {
  type_code: string;
  items: {
    voucher_id: string; date: string; voucher_number: string; reference_number: string | null;
    party_id: string | null; party_name: string | null; party_gstin: string | null; narration: string | null;
    taxable_value_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number;
    cess_paise: number; grand_total_paise: number;
  }[];
  totals: { count: number; taxableValuePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; grandTotalPaise: number };
}

export interface StockSummary {
  items: {
    stock_item_id: string; stock_item_name: string; stock_group_name: string | null;
    unit_name: string | null; hsn_code: string | null;
    opening_qty_milli: number; opening_value_paise: number;
    inward_qty_milli: number; inward_value_paise: number;
    outward_qty_milli: number; outward_value_paise: number;
    closing_qty_milli: number; closing_value_paise: number; avg_rate_paise: number;
    reorder_level_milli: number; below_reorder: boolean; negative: boolean;
  }[];
  totals: { closing_value_paise: number; negative_count: number; below_reorder_count: number };
}

export interface BookkeepingStockItem {
  id: string; name: string; stock_group_id: string | null; stock_group_name: string | null;
  category_id: string | null; unit_id: string | null; unit_name: string | null;
  hsn_code: string | null; gst_rate_bp: number; reorder_level_milli: number;
  standard_cost_paise: number; standard_price_paise: number; valuation_method: string;
  batch_tracking: boolean; active: boolean; opening_qty_milli: number; opening_value_paise: number;
}

export interface BankAccount {
  ledger_id: string; ledger_name: string; account_name: string | null;
  account_number: string | null; ifsc: string | null;
  book_balance_paise: number; unmatched_statement_lines: number;
}

export interface BankBook {
  ledger: { id: string; name: string };
  opening_paise: number; closing_paise: number;
  reconciled_paise: number; unreconciled_paise: number;
  rows: {
    entry_id: string; voucher_id: string; date: string; voucher_number: string; voucher_type_code: string;
    particulars: string; deposit_paise: number; withdrawal_paise: number; running_balance_paise: number;
    bank_date: string | null; reconciled: boolean; statement_line_id: string | null;
  }[];
}

export interface StatementLine {
  id: string; date: string; description: string; ref_number: string | null;
  debit_paise: number; credit_paise: number; balance_paise: number | null;
  status: string; matched_entry_id: string | null; matched_voucher_id: string | null; matched_voucher_number: string | null;
}

export interface GstSummary {
  from: string | null; to: string | null;
  input: { cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number; totalPaise: number };
  output: { cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number; totalPaise: number };
  net: { cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number; totalPaise: number };
  ledgers: { ledgerId: string; ledgerName: string; component: string; direction: string; debitPaise: number; creditPaise: number; closingPaise: number }[];
  outwardTaxableValuePaise: number; inwardTaxableValuePaise: number;
}

export interface DashboardTile { key: string; label: string; amount_paise: number; drill: string }

export interface BookkeepingDashboard {
  company_id: string;
  period: { from: string | null; to: string | null; financial_year_label: string | null };
  voucher_count: number;
  tiles: DashboardTile[];
  recent_vouchers: DayBookRow[];
  top_receivables: Outstandings['parties'];
  top_payables: Outstandings['parties'];
  receivable_ageing: { key: string; label: string; amount_paise: number }[];
  payable_ageing: { key: string; label: string; amount_paise: number }[];
  alerts: { key: string; label: string; severity: string; count: number; detail: string }[];
  gst: { output_paise: number; input_paise: number; net_paise: number };
  profit_and_loss: { income_paise: number; expense_paise: number; gross_profit_paise: number; net_profit_paise: number };
}

export interface AuditTrailRow {
  id: string; voucher_id: string; voucher_number: string; voucher_type_code: string;
  voucher_date: string; voucher_status: string; version: number; action: string;
  actor_user_id: string | null; actor_label: string; note: string | null; at: string;
  has_before: boolean; has_after: boolean;
}

export interface ImportPreview {
  entity: string; total_rows: number; valid_rows: number; invalid_rows: number; duplicate_rows: number;
  issues: { row: number; field?: string; message: string; severity: 'error' | 'warning' }[];
  sample: unknown[];
}

export interface PayrollRun {
  id: string; period: string; status: string;
  gross_paise: number; deductions_paise: number; net_paise: number;
  voucher_id: string | null; created_at?: string;
  payslips?: {
    employee_id: string; employee_name: string;
    earnings: { name: string; amount_paise: number }[];
    deductions: { name: string; amount_paise: number }[];
    gross_paise: number; deductions_paise: number; net_paise: number;
  }[];
}

type QsParams = Record<string, string | number | boolean | undefined | null>;

function qs(params: QsParams | object): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params as QsParams)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const base = (companyId: string) => `/api/tally/companies/${companyId}`;

export const bookkeepingAccountingApi = {
  // ── Voucher types ──────────────────────────────────────────────────
  listVoucherTypes: (c: string) => api.get<{ items: BookkeepingVoucherType[] }>(`${base(c)}/voucher-types`),
  updateVoucherType: (c: string, typeId: string, patch: Partial<Pick<BookkeepingVoucherType, 'name' | 'prefix' | 'suffix' | 'start_number' | 'active'>> & { numbering_method?: 'auto' | 'manual' }) =>
    api.patch<{ id: string; name: string }>(`${base(c)}/voucher-types/${typeId}`, patch),

  // ── Vouchers ───────────────────────────────────────────────────────
  listVouchers: (c: string, f: BookkeepingPeriod & { type_codes?: string; ledger_id?: string; party_ledger_id?: string; status?: string; q?: string; limit?: number; offset?: number } = {}) =>
    api.get<{ items: BookkeepingVoucher[]; total: number; limit: number; offset: number }>(`${base(c)}/vouchers${qs(f)}`),
  getVoucher: (c: string, id: string) => api.get<BookkeepingVoucher>(`${base(c)}/vouchers/${id}`),
  createVoucher: (c: string, input: CreateVoucherInput) => api.post<BookkeepingVoucher>(`${base(c)}/vouchers`, input),
  updateVoucher: (c: string, id: string, input: CreateVoucherInput) => api.patch<BookkeepingVoucher>(`${base(c)}/vouchers/${id}`, input),
  cancelVoucher: (c: string, id: string, reason?: string) => api.post<BookkeepingVoucher>(`${base(c)}/vouchers/${id}/cancel`, { reason: reason ?? null }),
  restoreVoucher: (c: string, id: string) => api.post<BookkeepingVoucher>(`${base(c)}/vouchers/${id}/restore`, {}),
  duplicateVoucher: (c: string, id: string, date?: string) => api.post<BookkeepingVoucher>(`${base(c)}/vouchers/${id}/duplicate`, date ? { date } : {}),

  // ── Reports ────────────────────────────────────────────────────────
  dayBook: (c: string, f: BookkeepingPeriod & { type_codes?: string; limit?: number; include_cancelled?: boolean } = {}) =>
    api.get<{ items: DayBookRow[]; totals: { debit_paise: number; credit_paise: number; count: number } }>(`${base(c)}/reports/day-book${qs(f)}`),
  ledgerStatement: (c: string, ledgerId: string, f: BookkeepingPeriod = {}) =>
    api.get<LedgerStatement>(`${base(c)}/reports/ledger/${ledgerId}${qs(f)}`),
  trialBalance: (c: string, f: BookkeepingPeriod = {}) => api.get<TrialBalance>(`${base(c)}/reports/trial-balance${qs(f)}`),
  profitAndLoss: (c: string, f: BookkeepingPeriod = {}) => api.get<ProfitAndLoss>(`${base(c)}/reports/profit-and-loss${qs(f)}`),
  balanceSheet: (c: string, f: BookkeepingPeriod = {}) => api.get<BalanceSheet>(`${base(c)}/reports/balance-sheet${qs(f)}`),
  groupSummary: (c: string, f: BookkeepingPeriod = {}) =>
    api.get<{ items: { groupId: string; groupName: string; nature: string; affectsPL: boolean; parentGroupId: string | null; openingPaise: number; debitPaise: number; creditPaise: number; closingPaise: number; ledgerCount: number }[] }>(`${base(c)}/reports/group-summary${qs(f)}`),
  register: (c: string, typeCode: string, f: BookkeepingPeriod = {}) => api.get<RegisterReport>(`${base(c)}/reports/register/${typeCode}${qs(f)}`),
  outstandings: (c: string, side: 'receivable' | 'payable', f: { as_of?: string; ledger_id?: string } = {}) =>
    api.get<Outstandings>(`${base(c)}/reports/outstandings${qs({ side, ...f })}`),
  book: (c: string, kind: 'cash' | 'bank', f: BookkeepingPeriod = {}) =>
    api.get<{ kind: string; ledgers: { ledger_id: string; ledger_name: string; opening_paise: number; debit_paise: number; credit_paise: number; closing_paise: number }[]; totals: { opening_paise: number; debit_paise: number; credit_paise: number; closing_paise: number } }>(`${base(c)}/reports/book/${kind}${qs(f)}`),
  cashFlow: (c: string, f: BookkeepingPeriod = {}) =>
    api.get<{ opening_paise: number; closing_paise: number; net_change_paise: number; inflows: { label: string; amount_paise: number }[]; outflows: { label: string; amount_paise: number }[] }>(`${base(c)}/reports/cash-flow${qs(f)}`),
  ratios: (c: string, f: BookkeepingPeriod = {}) =>
    api.get<{ as_of: string | null; working_capital_paise: number; current_ratio: number | null; quick_ratio: number | null; debt_equity_ratio: number | null; gross_profit_pct: number | null; net_profit_pct: number | null; net_profit_paise: number; total_assets_paise: number }>(`${base(c)}/reports/ratios${qs(f)}`),

  // ── Inventory ──────────────────────────────────────────────────────
  listStockItems: (c: string, f: { q?: string; stock_group_id?: string } = {}) =>
    api.get<{ items: BookkeepingStockItem[] }>(`${base(c)}/inventory/items${qs(f)}`),
  createStockItem: (c: string, input: Record<string, unknown>) => api.post<{ id: string; name: string }>(`${base(c)}/inventory/items`, input),
  updateStockItem: (c: string, itemId: string, patch: Record<string, unknown>) => api.patch<{ id: string; name: string }>(`${base(c)}/inventory/items/${itemId}`, patch),
  setOpeningStock: (c: string, itemId: string, input: { qty_milli: number; rate_paise: number; godown_id?: string | null }) =>
    api.put<{ stock_item_id: string; qty_milli: number; value_paise: number }>(`${base(c)}/inventory/items/${itemId}/opening`, input),
  listUnits: (c: string) => api.get<{ items: { id: string; name: string; decimals: number }[] }>(`${base(c)}/inventory/units`),
  createUnit: (c: string, input: { name: string; decimals?: number }) => api.post<{ id: string; name: string }>(`${base(c)}/inventory/units`, input),
  listGodowns: (c: string) => api.get<{ items: { id: string; name: string; address: string | null; parent_id: string | null }[] }>(`${base(c)}/inventory/godowns`),
  createGodown: (c: string, input: { name: string; address?: string | null }) => api.post<{ id: string; name: string }>(`${base(c)}/inventory/godowns`, input),
  listStockGroups: (c: string) => api.get<{ items: { id: string; name: string; parent_id: string | null }[] }>(`${base(c)}/inventory/stock-groups`),
  createStockGroup: (c: string, input: { name: string; parent_id?: string | null }) => api.post<{ id: string; name: string }>(`${base(c)}/inventory/stock-groups`, input),
  stockSummary: (c: string, f: BookkeepingPeriod & { godown_id?: string } = {}) => api.get<StockSummary>(`${base(c)}/inventory/summary${qs(f)}`),
  stockMovement: (c: string, itemId: string, f: BookkeepingPeriod & { godown_id?: string } = {}) =>
    api.get<{ rows: { voucher_id: string; voucher_number: string; voucher_type_code: string; date: string; direction: string; godown_name: string | null; batch_name: string | null; qty_milli: number; rate_paise: number; amount_paise: number; party_name: string | null }[] }>(`${base(c)}/inventory/items/${itemId}/movement${qs(f)}`),
  godownSummary: (c: string, f: BookkeepingPeriod = {}) =>
    api.get<{ rows: { godown_id: string | null; godown_name: string; stock_item_id: string; stock_item_name: string; closing_qty_milli: number }[] }>(`${base(c)}/inventory/godown-summary${qs(f)}`),

  // ── Banking ────────────────────────────────────────────────────────
  bankAccounts: (c: string, as_of?: string) => api.get<{ items: BankAccount[] }>(`${base(c)}/banking/accounts${qs({ as_of })}`),
  bankBook: (c: string, ledgerId: string, f: BookkeepingPeriod = {}) => api.get<BankBook>(`${base(c)}/banking/accounts/${ledgerId}/book${qs(f)}`),
  importStatement: (c: string, ledgerId: string, rows: { date: string; description: string; ref_number?: string | null; debit_paise?: number; credit_paise?: number; balance_paise?: number | null }[]) =>
    api.post<{ imported: number; duplicates_skipped: number; import_batch: string }>(`${base(c)}/banking/accounts/${ledgerId}/statement`, { rows }),
  statementLines: (c: string, ledgerId: string, f: { status?: string } & BookkeepingPeriod = {}) =>
    api.get<{ items: StatementLine[] }>(`${base(c)}/banking/accounts/${ledgerId}/statement-lines${qs(f)}`),
  matchSuggestions: (c: string, lineId: string) =>
    api.get<{ items: { entry_id: string; voucher_id: string; voucher_number: string; date: string; party_name: string | null; narration: string | null; amount_paise: number; day_gap: number }[] }>(`${base(c)}/banking/statement-lines/${lineId}/suggestions`),
  matchLine: (c: string, lineId: string, entryId: string) => api.post<{ status: string }>(`${base(c)}/banking/statement-lines/${lineId}/match`, { entry_id: entryId }),
  unmatchLine: (c: string, lineId: string) => api.post<{ status: string }>(`${base(c)}/banking/statement-lines/${lineId}/unmatch`, {}),
  reconciliation: (c: string, ledgerId: string, statementDate: string) =>
    api.get<{ ledger: { id: string; name: string }; statement_date: string; book_balance_paise: number; statement_balance_paise: number; difference_paise: number; matched_count: number; unmatched_statement_count: number; unmatched_book_count: number; unmatched_book: BankBook['rows']; unmatched_statement: { id: string; date: string; description: string; debit_paise: number; credit_paise: number }[] }>(`${base(c)}/banking/accounts/${ledgerId}/reconciliation${qs({ statement_date: statementDate })}`),
  saveReconciliation: (c: string, ledgerId: string, statementDate: string, notes?: string) =>
    api.post<{ id: string; difference_paise: number }>(`${base(c)}/banking/accounts/${ledgerId}/reconciliation`, { statement_date: statementDate, notes: notes ?? null }),
  listReconciliations: (c: string, ledgerId?: string) =>
    api.get<{ items: { id: string; bank_ledger_id: string; bank_ledger_name: string; statement_date: string; book_balance_paise: number; statement_balance_paise: number; difference_paise: number; matched_count: number; unmatched_count: number; notes: string | null; created_at: string }[] }>(`${base(c)}/banking/reconciliations${qs({ ledger_id: ledgerId })}`),

  // ── GST ────────────────────────────────────────────────────────────
  gstSummary: (c: string, f: BookkeepingPeriod = {}) => api.get<GstSummary>(`${base(c)}/gst/summary${qs(f)}`),
  gstr1: (c: string, from: string, to: string) => api.get<Record<string, unknown>>(`${base(c)}/gst/gstr1${qs({ from, to })}`),
  gstr3b: (c: string, from: string, to: string) => api.get<Record<string, unknown>>(`${base(c)}/gst/gstr3b${qs({ from, to })}`),
  gstExceptions: (c: string, from: string, to: string) =>
    api.get<{ period: { from: string; to: string }; groups: { issue: string; vouchers: { voucher_id: string; voucher_number: string }[] }[]; total: number }>(`${base(c)}/gst/exceptions${qs({ from, to })}`),
  listTaxRates: (c: string, taxType?: string) =>
    api.get<{ items: { id: string; tax_type: string; name: string; hsn_code: string | null; sac_code: string | null; section: string | null; rate_bp: number; rate_pct: number; cess_bp: number; threshold_paise: number | null; effective_from: string | null; active: boolean }[] }>(`${base(c)}/gst/tax-rates${qs({ tax_type: taxType })}`),
  createTaxRate: (c: string, input: Record<string, unknown>) => api.post<{ id: string; name: string }>(`${base(c)}/gst/tax-rates`, input),
  statutorySummary: (c: string, taxType: 'tds' | 'tcs', f: BookkeepingPeriod = {}) =>
    api.get<{ tax_type: string; rows: { ledger_id: string; ledger_name: string; section: string | null; deducted_paise: number; paid_paise: number; payable_paise: number }[]; totals: { deducted_paise: number; paid_paise: number; payable_paise: number }; configured_rates: { id: string; name: string; section: string | null; rate_pct: number; threshold_paise: number | null }[]; note: string }>(`${base(c)}/gst/statutory/${taxType}${qs(f)}`),
  eInvoicePayload: (c: string, voucherId: string) =>
    api.get<{ status: string; transmitted: boolean; irn: string | null; blockers: string[]; note: string; payload: Record<string, unknown> }>(`${base(c)}/gst/e-invoice/${voucherId}`),
  eWayBillPayload: (c: string, voucherId: string, transport: Record<string, unknown> = {}) =>
    api.post<{ status: string; transmitted: boolean; ewb_number: string | null; blockers: string[]; note: string; payload: Record<string, unknown> }>(`${base(c)}/gst/e-way-bill/${voucherId}`, transport),

  // ── Payroll ────────────────────────────────────────────────────────
  listEmployees: (c: string) =>
    api.get<{ items: { id: string; name: string; code: string | null; employee_group: string | null; designation: string | null; date_of_joining: string | null; active: boolean; structure: { pay_head_id: string; pay_head_name: string; head_type: string; value_paise: number; percent_bp: number }[] }[] }>(`${base(c)}/payroll/employees`),
  createEmployee: (c: string, input: Record<string, unknown>) => api.post<{ id: string; name: string }>(`${base(c)}/payroll/employees`, input),
  listPayHeads: (c: string) =>
    api.get<{ items: { id: string; name: string; head_type: string; calc_type: string; value_paise: number; percent_bp: number; statutory: string | null; ledger_id: string | null; ledger_name: string | null; active: boolean }[] }>(`${base(c)}/payroll/pay-heads`),
  createPayHead: (c: string, input: Record<string, unknown>) => api.post<{ id: string; name: string }>(`${base(c)}/payroll/pay-heads`, input),
  setStructure: (c: string, employeeId: string, lines: { pay_head_id: string; value_paise?: number; percent_bp?: number }[]) =>
    api.put<{ employee_id: string; lines: number }>(`${base(c)}/payroll/employees/${employeeId}/structure`, { lines }),
  getAttendance: (c: string, period: string) =>
    api.get<{ items: { employee_id: string; employee_name: string; period: string; payable_days: number; present_days: number; lop_days: number }[] }>(`${base(c)}/payroll/attendance${qs({ period })}`),
  setAttendance: (c: string, period: string, rows: { employee_id: string; payable_days: number; present_days: number }[]) =>
    api.put<{ period: string; employees: number }>(`${base(c)}/payroll/attendance`, { period, rows }),
  listPayrollRuns: (c: string) => api.get<{ items: PayrollRun[] }>(`${base(c)}/payroll/runs`),
  getPayrollRun: (c: string, runId: string) => api.get<PayrollRun>(`${base(c)}/payroll/runs/${runId}`),
  processPayroll: (c: string, period: string) => api.post<PayrollRun>(`${base(c)}/payroll/runs`, { period }),
  postPayroll: (c: string, runId: string, input: { date: string; payment_ledger_id: string; default_expense_ledger_id?: string }) =>
    api.post<PayrollRun>(`${base(c)}/payroll/runs/${runId}/post`, input),

  // ── Audit ──────────────────────────────────────────────────────────
  auditTrail: (c: string, f: { action?: string; voucher_id?: string; limit?: number } & BookkeepingPeriod = {}) =>
    api.get<{ items: AuditTrailRow[] }>(`${base(c)}/audit/trail${qs(f)}`),
  auditRevision: (c: string, revisionId: string) =>
    api.get<{ id: string; voucher_id: string; version: number; action: string; at: string; before: unknown; after: unknown }>(`${base(c)}/audit/revisions/${revisionId}`),
  alteredVouchers: (c: string, f: BookkeepingPeriod = {}) =>
    api.get<{ items: { voucher_id: string; voucher_number: string; voucher_type_code: string; date: string; status: string; version: number; revision_count: number; party_name: string | null; grand_total_paise: number; last_modified_at: string }[] }>(`${base(c)}/audit/altered${qs(f)}`),
  cancelledVouchers: (c: string, f: BookkeepingPeriod = {}) =>
    api.get<{ items: { voucher_id: string; voucher_number: string; voucher_type_code: string; date: string; grand_total_paise: number; party_name: string | null; cancelled_at: string | null; reason: string | null }[] }>(`${base(c)}/audit/cancelled${qs(f)}`),
  userActivity: (c: string, limit?: number) =>
    api.get<{ items: { id: string; action: string; entity_type: string; entity_id: string; actor_label: string; ip: string | null; at: string }[] }>(`${base(c)}/audit/activity${qs({ limit })}`),
  auditExceptions: (c: string, f: BookkeepingPeriod = {}) =>
    api.get<{ period: { from: string | null; to: string | null }; voucher_count: number; items: { key: string; label: string; severity: string; count: number; detail: string }[] }>(`${base(c)}/audit/exceptions${qs(f)}`),

  // ── Data ───────────────────────────────────────────────────────────
  validateImport: (c: string, entity: string, rows: Record<string, unknown>[]) =>
    api.post<ImportPreview>(`${base(c)}/data/import/validate`, { entity, rows }),
  commitImport: (c: string, entity: string, rows: Record<string, unknown>[], skipInvalid = false) =>
    api.post<Record<string, unknown>>(`${base(c)}/data/import/commit`, { entity, rows, skip_invalid: skipInvalid }),
  exportJsonUrl: (c: string) => `${base(c)}/data/export/json`,
  exportXmlUrl: (c: string, f: BookkeepingPeriod = {}) => `${base(c)}/data/export/xml${qs(f)}`,
  listBackups: (c: string) =>
    api.get<{ items: { id: string; label: string; size_bytes: number; voucher_count: number; ledger_count: number; created_at: string }[] }>(`${base(c)}/data/backups`),
  createBackup: (c: string, label?: string) =>
    api.post<{ id: string; label: string; size_bytes: number; voucher_count: number; created_at: string }>(`${base(c)}/data/backups`, label ? { label } : {}),
  backupDownloadUrl: (c: string, backupId: string) => `${base(c)}/data/backups/${backupId}`,
  restoreBackup: (c: string, backupId: string, newCompanyName: string) =>
    api.post<{ restored_company_id: string; restored_company_name: string; groups: number; ledgers: number; vouchers_restored: number; voucher_failures: string[] }>(`${base(c)}/data/backups/${backupId}/restore`, { new_company_name: newCompanyName, confirm: true }),
  verifyRestore: (c: string, restoredCompanyId: string) =>
    api.get<{ source_total_debit_paise: number; restored_total_debit_paise: number; matches: boolean; mismatches: { ledger: string; source_paise: number; restored_paise: number | null }[] }>(`${base(c)}/data/verify-restore/${restoredCompanyId}`),

  // ── Settings / dashboard / search ──────────────────────────────────
  getSettings: (c: string) => api.get<Record<string, Record<string, unknown>>>(`${base(c)}/settings`),
  updateSettings: (c: string, group: string, patch: Record<string, unknown>) =>
    api.patch<{ group: string; values: Record<string, unknown> }>(`${base(c)}/settings/${group}`, patch),
  dashboard: (c: string, f: BookkeepingPeriod & { fy_id?: string } = {}) => api.get<BookkeepingDashboard>(`${base(c)}/dashboard${qs(f)}`),
  search: (c: string, q: string) =>
    api.get<{ query: string; hits: { type: string; id: string; label: string; sublabel: string | null; route: string }[] }>(`${base(c)}/search${qs({ q })}`),
};
