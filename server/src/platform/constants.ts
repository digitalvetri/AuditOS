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
] as const
export type LedgerType = (typeof LEDGER_TYPES)[number]

export const INTERNAL_NAMESPACE = 'INTERNAL'

/** Simulated payments only — the UI says so in as many words. */
export const MOCK_PAYMENT_NOTICE = 'Simulated payment — no bank integration.'
