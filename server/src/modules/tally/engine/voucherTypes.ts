/**
 * The default voucher types seeded per company (spec §5). `code` is the
 * engine's contract — every posting rule keys off it, never off the
 * user-editable `name`, so renaming "Sales" to "Tax Invoice" is safe.
 *
 * affectsAccounts: posts double-entry lines (debit must equal credit).
 * affectsStock:    moves inventory.
 * isOrder:         a commitment only — no accounting, no stock, until
 *                  it is converted into an invoice / delivery note.
 */
export interface VoucherTypeSeed {
  name: string
  code: string
  affectsAccounts: boolean
  affectsStock: boolean
  isOrder: boolean
  prefix?: string
}

export const VOUCHER_TYPE_SEEDS: VoucherTypeSeed[] = [
  { name: 'Payment',        code: 'payment',        affectsAccounts: true,  affectsStock: false, isOrder: false, prefix: 'PAY-' },
  { name: 'Receipt',        code: 'receipt',        affectsAccounts: true,  affectsStock: false, isOrder: false, prefix: 'RCT-' },
  { name: 'Contra',         code: 'contra',         affectsAccounts: true,  affectsStock: false, isOrder: false, prefix: 'CTR-' },
  { name: 'Journal',        code: 'journal',        affectsAccounts: true,  affectsStock: false, isOrder: false, prefix: 'JNL-' },
  { name: 'Sales',          code: 'sales',          affectsAccounts: true,  affectsStock: true,  isOrder: false, prefix: 'INV-' },
  { name: 'Purchase',       code: 'purchase',       affectsAccounts: true,  affectsStock: true,  isOrder: false, prefix: 'PUR-' },
  { name: 'Debit Note',     code: 'debit_note',     affectsAccounts: true,  affectsStock: true,  isOrder: false, prefix: 'DN-' },
  { name: 'Credit Note',    code: 'credit_note',    affectsAccounts: true,  affectsStock: true,  isOrder: false, prefix: 'CN-' },
  { name: 'Quotation',      code: 'quotation',      affectsAccounts: false, affectsStock: false, isOrder: true,  prefix: 'QTN-' },
  { name: 'Sales Order',    code: 'sales_order',    affectsAccounts: false, affectsStock: false, isOrder: true,  prefix: 'SO-' },
  { name: 'Purchase Order', code: 'purchase_order', affectsAccounts: false, affectsStock: false, isOrder: true,  prefix: 'PO-' },
  { name: 'Delivery Note',  code: 'delivery_note',  affectsAccounts: false, affectsStock: true,  isOrder: false, prefix: 'DC-' },
  { name: 'Receipt Note',   code: 'receipt_note',   affectsAccounts: false, affectsStock: true,  isOrder: false, prefix: 'GRN-' },
  { name: 'Stock Journal',  code: 'stock_journal',  affectsAccounts: false, affectsStock: true,  isOrder: false, prefix: 'STJ-' },
  { name: 'Physical Stock', code: 'physical_stock', affectsAccounts: false, affectsStock: true,  isOrder: false, prefix: 'PHY-' },
  { name: 'Rejections In',  code: 'rejections_in',  affectsAccounts: false, affectsStock: true,  isOrder: false, prefix: 'RJI-' },
  { name: 'Rejections Out', code: 'rejections_out', affectsAccounts: false, affectsStock: true,  isOrder: false, prefix: 'RJO-' },
  { name: 'Payroll',        code: 'payroll',        affectsAccounts: true,  affectsStock: false, isOrder: false, prefix: 'PR-' },
]

export const VOUCHER_TYPE_CODES = VOUCHER_TYPE_SEEDS.map((v) => v.code)

/** Registers in the Reports module map 1:1 onto these codes. */
export const REGISTER_CODES = {
  sales: ['sales'],
  purchase: ['purchase'],
  payment: ['payment'],
  receipt: ['receipt'],
  journal: ['journal'],
  contra: ['contra'],
  debit_note: ['debit_note'],
  credit_note: ['credit_note'],
} as const

/**
 * Default GST ledger scaffolding. Created alongside the Duties & Taxes
 * group so a fresh company can raise a taxable invoice without the user
 * hand-building six ledgers. `taxConfigJson.gst_component` is what the
 * engine and the GST reports key off — never the ledger name.
 */
export interface GstLedgerSeed {
  name: string
  component: 'cgst' | 'sgst' | 'igst' | 'cess'
  direction: 'input' | 'output'
}

export const GST_LEDGER_SEEDS: GstLedgerSeed[] = [
  { name: 'Input CGST',  component: 'cgst', direction: 'input'  },
  { name: 'Input SGST',  component: 'sgst', direction: 'input'  },
  { name: 'Input IGST',  component: 'igst', direction: 'input'  },
  { name: 'Output CGST', component: 'cgst', direction: 'output' },
  { name: 'Output SGST', component: 'sgst', direction: 'output' },
  { name: 'Output IGST', component: 'igst', direction: 'output' },
]
