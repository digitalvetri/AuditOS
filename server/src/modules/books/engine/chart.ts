/**
 * DEFAULT CHART OF ACCOUNTS — seeded into every new set of books.
 *
 * Groups carry the root category and the Tally primary-group name so a
 * later Tally export is a straight mapping. Ledgers the engine posts to are
 * identified by `systemKey`, never by their (editable) display name.
 */
export type RootCategory = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

export interface GroupSeed { name: string; rootCategory: RootCategory; tallyGroup: string; parent?: string; sortOrder: number }
export interface LedgerSeed {
  name: string; group: string; systemKey?: SystemKey; billWise?: boolean; isBank?: boolean; isCash?: boolean; description?: string
}

export type SystemKey =
  | 'accounts_receivable' | 'accounts_payable' | 'cash' | 'undeposited_funds' | 'sales' | 'other_income'
  | 'purchases' | 'cogs' | 'general_expense' | 'bank_charges' | 'round_off' | 'fx_gain_loss' | 'discount'
  | 'cgst_output' | 'sgst_output' | 'igst_output' | 'cgst_input' | 'sgst_input' | 'igst_input'
  | 'tds_payable' | 'tcs_payable' | 'tds_receivable' | 'unearned_revenue' | 'opening_balance_equity'
  | 'retained_earnings' | 'owner_capital' | 'advance_to_vendors' | 'advance_from_customers'

export const DEFAULT_GROUPS: GroupSeed[] = [
  { name: 'Current Assets',        rootCategory: 'asset',     tallyGroup: 'Current Assets',        sortOrder: 10 },
  { name: 'Bank Accounts',         rootCategory: 'asset',     tallyGroup: 'Bank Accounts',         parent: 'Current Assets', sortOrder: 11 },
  { name: 'Cash-in-Hand',          rootCategory: 'asset',     tallyGroup: 'Cash-in-Hand',          parent: 'Current Assets', sortOrder: 12 },
  { name: 'Sundry Debtors',        rootCategory: 'asset',     tallyGroup: 'Sundry Debtors',        parent: 'Current Assets', sortOrder: 13 },
  { name: 'Stock-in-Hand',         rootCategory: 'asset',     tallyGroup: 'Stock-in-Hand',         parent: 'Current Assets', sortOrder: 14 },
  { name: 'Loans & Advances (Asset)', rootCategory: 'asset',  tallyGroup: 'Loans & Advances (Asset)', parent: 'Current Assets', sortOrder: 15 },
  { name: 'Deposits (Asset)',      rootCategory: 'asset',     tallyGroup: 'Deposits (Asset)',      parent: 'Current Assets', sortOrder: 16 },
  { name: 'Fixed Assets',          rootCategory: 'asset',     tallyGroup: 'Fixed Assets',          sortOrder: 20 },
  { name: 'Current Liabilities',   rootCategory: 'liability', tallyGroup: 'Current Liabilities',   sortOrder: 30 },
  { name: 'Sundry Creditors',      rootCategory: 'liability', tallyGroup: 'Sundry Creditors',      parent: 'Current Liabilities', sortOrder: 31 },
  { name: 'Duties & Taxes',        rootCategory: 'liability', tallyGroup: 'Duties & Taxes',        parent: 'Current Liabilities', sortOrder: 32 },
  { name: 'Provisions',            rootCategory: 'liability', tallyGroup: 'Provisions',            parent: 'Current Liabilities', sortOrder: 33 },
  { name: 'Loans (Liability)',     rootCategory: 'liability', tallyGroup: 'Loans (Liability)',     sortOrder: 34 },
  { name: 'Capital Account',       rootCategory: 'equity',    tallyGroup: 'Capital Account',       sortOrder: 40 },
  { name: 'Reserves & Surplus',    rootCategory: 'equity',    tallyGroup: 'Reserves & Surplus',    parent: 'Capital Account', sortOrder: 41 },
  { name: 'Sales Accounts',        rootCategory: 'income',    tallyGroup: 'Sales Accounts',        sortOrder: 50 },
  { name: 'Direct Incomes',        rootCategory: 'income',    tallyGroup: 'Direct Incomes',        sortOrder: 51 },
  { name: 'Indirect Incomes',      rootCategory: 'income',    tallyGroup: 'Indirect Incomes',      sortOrder: 52 },
  { name: 'Purchase Accounts',     rootCategory: 'expense',   tallyGroup: 'Purchase Accounts',     sortOrder: 60 },
  { name: 'Direct Expenses',       rootCategory: 'expense',   tallyGroup: 'Direct Expenses',       sortOrder: 61 },
  { name: 'Indirect Expenses',     rootCategory: 'expense',   tallyGroup: 'Indirect Expenses',     sortOrder: 62 },
]

export const DEFAULT_LEDGERS: LedgerSeed[] = [
  { name: 'Accounts Receivable', group: 'Sundry Debtors', systemKey: 'accounts_receivable', billWise: true, description: 'Control account for customer invoices' },
  { name: 'Advance from Customers', group: 'Current Liabilities', systemKey: 'advance_from_customers', billWise: true },
  { name: 'Accounts Payable', group: 'Sundry Creditors', systemKey: 'accounts_payable', billWise: true, description: 'Control account for vendor bills' },
  { name: 'Advance to Vendors', group: 'Loans & Advances (Asset)', systemKey: 'advance_to_vendors', billWise: true },
  { name: 'Cash', group: 'Cash-in-Hand', systemKey: 'cash', isCash: true },
  { name: 'Petty Cash', group: 'Cash-in-Hand', isCash: true },
  { name: 'Undeposited Funds', group: 'Current Assets', systemKey: 'undeposited_funds' },
  { name: 'TDS Receivable', group: 'Current Assets', systemKey: 'tds_receivable', description: 'TDS deducted by customers on our receipts' },
  { name: 'Furniture & Equipment', group: 'Fixed Assets' },
  { name: 'Computers & Software', group: 'Fixed Assets' },
  { name: 'CGST Output', group: 'Duties & Taxes', systemKey: 'cgst_output' },
  { name: 'SGST Output', group: 'Duties & Taxes', systemKey: 'sgst_output' },
  { name: 'IGST Output', group: 'Duties & Taxes', systemKey: 'igst_output' },
  { name: 'CGST Input', group: 'Duties & Taxes', systemKey: 'cgst_input' },
  { name: 'SGST Input', group: 'Duties & Taxes', systemKey: 'sgst_input' },
  { name: 'IGST Input', group: 'Duties & Taxes', systemKey: 'igst_input' },
  { name: 'TDS Payable', group: 'Duties & Taxes', systemKey: 'tds_payable', description: 'TDS deducted on vendor bills, payable to the government' },
  { name: 'TCS Payable', group: 'Duties & Taxes', systemKey: 'tcs_payable' },
  { name: 'Unearned Revenue', group: 'Current Liabilities', systemKey: 'unearned_revenue', billWise: true, description: 'Retainer / advance invoices until revenue is recognised' },
  { name: 'Opening Balance Equity', group: 'Capital Account', systemKey: 'opening_balance_equity' },
  { name: "Owner's Capital", group: 'Capital Account', systemKey: 'owner_capital' },
  { name: 'Retained Earnings', group: 'Reserves & Surplus', systemKey: 'retained_earnings' },
  { name: 'Sales', group: 'Sales Accounts', systemKey: 'sales' },
  { name: 'Service Income', group: 'Sales Accounts' },
  { name: 'Discount Allowed', group: 'Indirect Expenses', systemKey: 'discount' },
  { name: 'Other Income', group: 'Indirect Incomes', systemKey: 'other_income' },
  { name: 'Interest Income', group: 'Indirect Incomes' },
  { name: 'Exchange Gain / Loss', group: 'Indirect Expenses', systemKey: 'fx_gain_loss', description: 'Realised and unrealised foreign-exchange differences' },
  { name: 'Round Off', group: 'Indirect Expenses', systemKey: 'round_off', description: 'Invoice / bill rounding differences — never absorbed into a real line' },
  { name: 'Purchases', group: 'Purchase Accounts', systemKey: 'purchases' },
  { name: 'Cost of Goods Sold', group: 'Direct Expenses', systemKey: 'cogs' },
  { name: 'General Expenses', group: 'Indirect Expenses', systemKey: 'general_expense' },
  { name: 'Bank Charges', group: 'Indirect Expenses', systemKey: 'bank_charges' },
  { name: 'Rent', group: 'Indirect Expenses' },
  { name: 'Salaries', group: 'Indirect Expenses' },
  { name: 'Professional Fees', group: 'Indirect Expenses' },
  { name: 'Telephone & Internet', group: 'Indirect Expenses' },
  { name: 'Travel & Conveyance', group: 'Indirect Expenses' },
  { name: 'Office Supplies', group: 'Indirect Expenses' },
  { name: 'Depreciation', group: 'Indirect Expenses' },
]

/** type gst | tds | tcs, percentages in basis points. */
export const DEFAULT_TAX_RATES = [
  { name: 'GST 0%',  type: 'gst', percentageBp: 0 },
  { name: 'GST 5%',  type: 'gst', percentageBp: 500 },
  { name: 'GST 12%', type: 'gst', percentageBp: 1200 },
  { name: 'GST 18%', type: 'gst', percentageBp: 1800 },
  { name: 'GST 28%', type: 'gst', percentageBp: 2800 },
  // TDS section rates as they stand before the Income-tax Act 2025 codes are
  // finalised — see docs/accounting-module/README.md open items.
  { name: 'TDS 194C Contractor (Ind/HUF) 1%', type: 'tds', percentageBp: 100, noPanPercentageBp: 2000, section: '194C' },
  { name: 'TDS 194C Contractor (Others) 2%',  type: 'tds', percentageBp: 200, noPanPercentageBp: 2000, section: '194C' },
  { name: 'TDS 194H Commission 5%',          type: 'tds', percentageBp: 500, noPanPercentageBp: 2000, section: '194H' },
  { name: 'TDS 194I Rent (Land/Building) 10%', type: 'tds', percentageBp: 1000, noPanPercentageBp: 2000, section: '194I' },
  { name: 'TDS 194J Professional Fees 10%',  type: 'tds', percentageBp: 1000, noPanPercentageBp: 2000, section: '194J' },
  { name: 'TDS 194J Technical Services 2%',  type: 'tds', percentageBp: 200, noPanPercentageBp: 2000, section: '194J' },
  { name: 'TDS 194Q Purchase of Goods 0.1%', type: 'tds', percentageBp: 10, noPanPercentageBp: 500, section: '194Q' },
  { name: 'TCS 206C(1H) Sale of Goods 0.1%', type: 'tcs', percentageBp: 10, noPanPercentageBp: 100, section: '206C(1H)' },
] as const

/** Indian state codes for place-of-supply. */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland',
  '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory', '96': 'Foreign Country',
}
