/**
 * Shapes emitted by server/src/modules/books/serialize.ts. Money is an
 * integer number of paise; the UI formats with `inr()` from format.ts.
 */
export type Minor = number
export type RootCategory = 'asset' | 'liability' | 'equity' | 'income' | 'expense'
export type MembershipRole = 'admin' | 'staff' | 'viewer'
export type DocKind = 'estimate' | 'sales_order' | 'invoice' | 'retainer_invoice' | 'credit_note' | 'purchase_order' | 'bill' | 'vendor_credit'
export type DocStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'posted' | 'partially_paid' | 'paid' | 'closed' | 'void'

export interface BooksOrg {
  id: string; name: string; legal_name: string | null; gstin: string | null; pan: string | null;
  state_code: string | null; state_name: string | null; base_currency: string; fiscal_year_start_month: number;
  tds_enabled: boolean; is_active: boolean; client_id: string | null; address_line1: string | null; city: string | null; pincode: string | null;
  my_role?: MembershipRole | null; member_count?: number;
  areas?: { settings: boolean; reports: boolean; accountant: boolean };
  counts?: { contacts: number; invoices: number; bills: number };
}

export interface BooksListResponse { items: BooksOrg[]; can_manage: boolean; states: Record<string, string> }

export interface Contact {
  id: string; type: 'customer' | 'vendor' | 'both'; display_name: string; company_name: string | null; email: string | null; phone: string | null;
  gstin: string | null; gst_treatment: string; pan: string | null; place_of_supply_state: string | null; currency: string;
  payment_terms_days: number; credit_limit: Minor; tds_section: string | null; notes: string | null; is_active: boolean;
  persons?: { id: string; name: string; email: string | null; phone: string | null; designation: string | null; is_primary: boolean }[];
  addresses?: { id: string; kind: string; line1: string | null; city: string | null; state_code: string | null; state_name: string | null; pincode: string | null }[];
}

export interface Item {
  id: string; name: string; sku: string | null; unit: string; item_type: string; product_type: string;
  sell_rate: Minor; purchase_rate: Minor; tax_rate_id: string | null; hsn_sac: string | null; is_active: boolean; description: string | null;
}

export interface TaxRate { id: string; name: string; type: 'gst' | 'tds' | 'tcs' | 'other'; percentage_bp: number; no_pan_percentage_bp: number | null; section: string | null; is_active: boolean }

export interface AccountGroup { id: string; name: string; root_category: RootCategory; tally_group: string; parent_group_id: string | null; is_system: boolean; sort_order: number }

export interface Ledger {
  id: string; name: string; alias: string | null; group_id: string; root_category: RootCategory; tally_group: string;
  system_key: string | null; opening_balance: Minor; opening_balance_type: 'debit' | 'credit'; currency: string;
  bill_wise: boolean; is_bank: boolean; is_cash: boolean; is_system: boolean; is_active: boolean; description: string | null;
  bank_name: string | null; bank_account_no: string | null; bank_ifsc: string | null; tds_section: string | null;
  group?: AccountGroup; balance?: Minor;
}

export interface DocLine {
  id: string; line_no: number; item_id: string | null; description: string; hsn_sac: string | null; quantity: number;
  rate: Minor; discount_percent_bp: number; discount_amount: Minor; tax_rate_id: string | null; tax_percent_bp: number;
  taxable: Minor; cgst: Minor; sgst: Minor; igst: Minor; tax: Minor; line_total: Minor; ledger_id: string;
}

export interface BooksDocument {
  id: string; kind: DocKind; number: string; contact_id: string; date: string; due_date: string | null; expiry_date: string | null;
  reference_no: string | null; status: DocStatus; currency: string; exchange_rate: number; place_of_supply: string | null;
  is_inter_state: boolean; tax_inclusive: boolean; discount_percent_bp: number; discount_amount: Minor;
  subtotal: Minor; discount_total: Minor; taxable_total: Minor; cgst_total: Minor; sgst_total: Minor; igst_total: Minor; tax_total: Minor;
  tds_rate_id: string | null; tds_total: Minor; round_off: Minor; total: Minor; base_total: Minor; balance_due: Minor; credits_remaining: Minor;
  journal_id: string | null; source_document_id: string | null; notes: string | null; terms: string | null; void_reason: string | null;
  lines: DocLine[]; created_at: string;
}

export interface JournalLine {
  id: string; line_no: number; ledger_id: string; side: 'debit' | 'credit'; amount: Minor; fx_currency: string; fx_amount: Minor;
  exchange_rate: number; party_ledger_id: string | null; description: string | null; reconciled_at: string | null;
  ledger?: { name: string }; journal?: Journal;
}

export interface Journal {
  id: string; date: string; number: string; voucher_type: string; source_module: string | null; source_id: string | null;
  narration: string | null; status: 'draft' | 'posted' | 'void'; currency: string; exchange_rate: number;
  total_debit: Minor; total_credit: Minor; posted_at: string | null; reverses_journal_id: string | null; voided_by_journal_id: string | null;
  lines?: JournalLine[]; allocations?: BillAllocation[]; created_at: string;
}

export interface Bill {
  id: string; ledger_id: string; contact_id: string | null; bill_no: string; bill_type: string; source_type: string; source_id: string;
  date: string; due_date: string | null; side: 'debit' | 'credit'; currency: string; fx_amount: Minor; amount: Minor; fx_balance: Minor; balance: Minor; status: string;
  document?: Pick<BooksDocument, 'id' | 'kind' | 'number' | 'date' | 'due_date' | 'total' | 'balance_due' | 'currency' | 'contact_id'> | null;
}

export interface BillAllocation { id: string; journal_id: string; bill_id: string; type: string; currency: string; fx_amount: Minor; amount: Minor; journal?: Journal; bill?: Bill }

export interface Payment {
  id: string; kind: 'received' | 'made'; number: string; contact_id: string; date: string; currency: string; exchange_rate: number;
  fx_amount: Minor; amount: Minor; deposit_ledger_id: string; bank_charges: Minor; tds_amount: Minor; mode: string;
  reference: string | null; notes: string | null; journal_id: string | null; status: string;
}

export interface AuditEvent { id: string; actor_user_id: string | null; entity_type: string; entity_id: string; action: string; before_json: string | null; after_json: string | null; created_at: string }

export interface Dashboard {
  receivables: { total: Minor; count: number; overdue: Minor };
  payables: { total: Minor; count: number };
  cash: { id: string; name: string; balance: Minor }[];
  month: { from: string; to: string; income: Minor; expense: Minor; net: Minor };
  recent: Journal[];
}

export interface TrialBalanceRow { ledger_id: string; name: string; root: RootCategory; tally_group: string; debit: Minor; credit: Minor; net: Minor; closing_debit: Minor; closing_credit: Minor }
export interface TrialBalance { as_of: string; rows: TrialBalanceRow[]; totals: { debit: Minor; credit: Minor; closing_debit: Minor; closing_credit: Minor } }

export interface PLRow { ledger_id: string; name: string; tally_group: string; amount: Minor }
export interface ProfitAndLoss { from: string; to: string; income: PLRow[]; expense: PLRow[]; income_by_group: { tally_group: string; amount: Minor }[]; expense_by_group: { tally_group: string; amount: Minor }[]; total_income: Minor; total_expense: Minor; net_profit: Minor }

export interface BalanceSheet {
  as_of: string; assets: PLRow[]; liabilities: PLRow[]; equity: PLRow[];
  current_year_earnings: Minor; prior_years_earnings: Minor; total_assets: Minor; total_liabilities: Minor; total_equity: Minor; difference: Minor;
}

export interface CashFlow { from: string; to: string; operating: Minor; investing: Minor; financing: Minor; net_change: Minor; opening_cash: Minor; closing_cash: Minor; detail: { journal: string; date: string; narration: string | null; amount: Minor; category: string }[] }

export interface GeneralLedger { ledger: Ledger; from: string; to: string; opening: Minor; closing: Minor; total_debit: Minor; total_credit: Minor; rows: (JournalLine & { running: Minor })[] }

export interface AgeingRow { contact_id: string | null; contact: string; current: Minor; d1_30: Minor; d31_60: Minor; d61_90: Minor; d90_plus: Minor; total: Minor; items: { bill_no: string; date: string; due_date: string | null; days_overdue: number; balance: Minor; currency: string; fx_balance: Minor }[] }
export interface Ageing { kind: string; as_of: string; rows: AgeingRow[]; totals: Omit<AgeingRow, 'contact_id' | 'contact' | 'items'> }

export interface Gstr1Row { number: string; date: string; contact: string; gstin: string | null; place_of_supply: string | null; inter_state: boolean; value: Minor; taxable: Minor; cgst: Minor; sgst: Minor; igst: Minor; rates: { rate_bp: number; taxable: Minor; cgst: Minor; sgst: Minor; igst: Minor }[] }
export interface Gstr1 { period: { from: string; to: string }; gstin: string | null; b2b: Gstr1Row[]; b2c: Gstr1Row[]; cdnr: Gstr1Row[]; cdnur: Gstr1Row[]; hsn: { hsn_sac: string; description: string; quantity: number; taxable: Minor; cgst: Minor; sgst: Minor; igst: Minor }[]; summary: Record<string, { count: number; taxable: Minor; cgst: Minor; sgst: Minor; igst: Minor; value: Minor }> }

export interface Gstr3b { period: { from: string; to: string }; '3_1_outward_supplies': { taxable: Minor; igst: Minor; cgst: Minor; sgst: Minor }; '4_eligible_itc': { taxable: Minor; igst: Minor; cgst: Minor; sgst: Minor }; net_payable: { igst: Minor; cgst: Minor; sgst: Minor } }

export interface Reconciliation {
  ledger: Ledger;
  journal_lines: (JournalLine & { journal: Journal })[];
  statement_lines: { id: string; date: string; description: string; amount: Minor; reference: string | null; matched_journal_line_id: string | null }[];
  summary: { ledger_balance: Minor; reconciled_balance: Minor; unreconciled: Minor; statement_balance: Minor; unmatched_statement: number };
}

export interface RecurringProfile { id: string; kind: string; name: string; contact_id: string; frequency: string; start_date: string; end_date: string | null; next_run_date: string; last_run_date: string | null; status: string }
export interface ExchangeRate { id: string; currency: string; date: string; rate: number }
export interface Revaluation { id: string; date: string; currency: string; rate: number; delta: Minor; journal_id: string | null; detail_json: string }
export interface BankTransfer { id: string; date: string; number: string; from_ledger_id: string; to_ledger_id: string; amount: Minor; reference: string | null; status: string }
