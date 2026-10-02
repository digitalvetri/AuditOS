/** Global constants (§3). Organisation-level values live in the DB. */
export const ORG_DEFAULTS = {
  name: 'Audit OS',
  legalName: 'Audit OS Advisory LLP',
  timezone: 'Asia/Kolkata',
  currency: 'INR',
  currencySymbol: '₹',
  fiscalYearStartMonth: 4,
}

export const LEDGER_TYPES = [
  'Payroll',
  'Expense Reimbursement',
  'Office Expense',
  'Employee Advance',
  'Advance Recovery',
  'Payment',
  'Liability Remittance',
] as const
export type LedgerType = (typeof LEDGER_TYPES)[number]

export const INTERNAL_NAMESPACE = 'INTERNAL'

/**
 * Chart of accounts: the `category` column on LedgerTransaction. Every leg
 * of a journal names the account it moves — Dr Salaries / Cr Bank / etc. —
 * so the Overview dashboard can `groupBy(category)` to answer "how much PF
 * are we holding?" without inferring from row-type strings.
 */
export const CATEGORIES = {
  SALARIES: 'Salaries',
  REIMBURSEMENT: 'Reimbursement',
  OFFICE_EXPENSE: 'Office Expense',
  EMPLOYEE_ADVANCE: 'Employee Advance',
  BANK: 'Bank',
  PF_PAYABLE: 'PF Payable',
  ESI_PAYABLE: 'ESI Payable',
  PT_PAYABLE: 'Professional Tax Payable',
  TDS_PAYABLE: 'TDS Payable',
  OTHER_DEDUCTION: 'Other Deduction',
} as const
export type Category = (typeof CATEGORIES)[keyof typeof CATEGORIES]

/**
 * Statutory withholdings the firm is holding from staff and owes to the
 * government. The Overview tab's "Held, not yet remitted" panel is a
 * groupBy over these three; a remittance discharges the balance by posting
 * Dr <Liability> / Cr Bank.
 */
export const LIABILITY_CATEGORIES = [
  CATEGORIES.PF_PAYABLE,
  CATEGORIES.ESI_PAYABLE,
  CATEGORIES.PT_PAYABLE,
  CATEGORIES.TDS_PAYABLE,
] as const
export type LiabilityCategory = (typeof LIABILITY_CATEGORIES)[number]

/** Simulated payments only — the UI says so in as many words. */
export const MOCK_PAYMENT_NOTICE = 'Simulated payment — no bank integration.'

/**
 * Gross monthly threshold (paise) above which a zero TDS plan is a
 * Process blocker (§2.6). Set roughly at the point where either regime
 * starts to deduct — an employee earning ~₹1L/month × 12 = ₹12L annually
 * will cross the taxable threshold under the new regime. Kept as a
 * single constant here; lift to a Setting only when the firm asks.
 */
export const TDS_PLAN_GROSS_THRESHOLD_PAISE = 100_000_00
