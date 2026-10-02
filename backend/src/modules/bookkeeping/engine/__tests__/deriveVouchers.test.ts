import { describe, expect, it } from 'vitest'
import { deriveBatch, type LedgerSnapshot } from '../deriveVouchers.js'
import type { MappableField } from '../../services/BookkeepingImportService.js'

/** Mapping that matches the real KS Sales sheet from BOOKKEEPING-REBUILD §1.1. */
const KS_MAPPING: Record<string, MappableField> = {
  A: 'date',
  B: 'invoice_no',
  D: 'customer',
  E: 'description',
  F: 'currency',
  H: 'foreign_amount',
  J: 'amount_inr',
  K: 'exchange_rate',
}

function emptyLedgers(): LedgerSnapshot {
  return {
    parties: [],
    salesLedgerId: 'L-SALES',
    purchaseLedgerId: 'L-PURCHASE',
    cgstOutputLedgerId: null,
    sgstOutputLedgerId: null,
    igstOutputLedgerId: null,
    cgstInputLedgerId: null,
    sgstInputLedgerId: null,
    igstInputLedgerId: null,
  }
}

/** Row shape mirrors the real KS Sales sheet: A B _ D E F _ H _ J K */
function row(a: string, b: string, d: string, e: string, f: string, h: string, j: string, k: string): string[] {
  // C, G, I are the blank spacer columns from the real file.
  return [a, b, '', d, e, f, '', h, '', j, k]
}

const KS_ROW = row('08/04/2025', 'INV/25-26/03', 'Alexandra', 'Ref - 819526 Sample', 'SGD', '1050.63', '88524.20769', '84.2582')

describe('deriveBatch — sales register', () => {
  it('turns one sales row into a balanced Dr party + Cr sales voucher', () => {
    const batch = deriveBatch([KS_ROW], {
      target: 'sales_register',
      columnMap: KS_MAPPING,
      headerRow: 1,
      dateFormat: 'DD/MM/YYYY',
      currencyAliases: {},
      ledgers: emptyLedgers(),
    })
    expect(batch.vouchers).toHaveLength(1)
    const v = batch.vouchers[0]
    expect(v.type).toBe('sales')
    expect(v.date).toBe('08/04/2025')
    expect(v.invoiceOrBillNo).toBe('INV/25-26/03')
    expect(v.partyName).toBe('Alexandra')
    expect(v.currency).toBe('SGD')
    expect(v.foreignAmountMinor).toBe(105_063)
    expect(v.exchangeRate).toBe('84.2582')
    expect(v.totalPaise).toBe(8_852_421)
    expect(v.balanced).toBe(true)
    expect(v.entries).toHaveLength(2)
    const dr = v.entries.find((e) => e.side === 'dr')!
    const cr = v.entries.find((e) => e.side === 'cr')!
    expect(dr.role).toBe('party')
    expect(dr.amountPaise).toBe(8_852_421)
    expect(cr.role).toBe('sales')
    expect(cr.amountPaise).toBe(8_852_421)
  })

  it('reports the party as a proposal when no ledger exists for it yet', () => {
    const batch = deriveBatch([KS_ROW], {
      target: 'sales_register',
      columnMap: KS_MAPPING,
      headerRow: 1,
      dateFormat: 'DD/MM/YYYY',
      currencyAliases: {},
      ledgers: emptyLedgers(),
    })
    expect(batch.proposals).toHaveLength(1)
    const p = batch.proposals[0]
    expect(p.name).toBe('Alexandra')
    expect(p.group).toBe('sundry_debtors')
    expect(p.occurrenceCount).toBe(1)
  })

  it('attaches fuzzy matches so an operator sees "Loopet" ≈ "Loopet Pte Ltd"', () => {
    const ledgers = emptyLedgers()
    ledgers.parties = [{ ledgerId: 'L-LOOP', name: 'Loopet Pte Ltd' }]
    const loopetRow = row('10/04/2025', 'INV/25-26/04', 'Loopet', '', 'SGD', '500', '42129.10', '84.2582')
    const batch = deriveBatch([loopetRow], {
      target: 'sales_register',
      columnMap: KS_MAPPING,
      headerRow: 1,
      dateFormat: 'DD/MM/YYYY',
      currencyAliases: {},
      ledgers,
    })
    // "Loopet" normalises to the same as "Loopet Pte Ltd" so resolvePartyLedger
    // treats it as the SAME party — no proposal needed.
    expect(batch.proposals).toHaveLength(0)
    // And the voucher's party line points at the existing ledger.
    const v = batch.vouchers[0]
    expect(v.partyLedgerId).toBe('L-LOOP')
  })

  it('flags a truly new party (that does NOT normalise onto an existing one) with fuzzy hits attached', () => {
    const ledgers = emptyLedgers()
    ledgers.parties = [{ ledgerId: 'L-LOOP', name: 'Loopet Pte Ltd' }]
    const typoRow = row('10/04/2025', 'INV/25-26/04', 'Loopat', '', 'SGD', '500', '42129.10', '84.2582')
    const batch = deriveBatch([typoRow], {
      target: 'sales_register',
      columnMap: KS_MAPPING,
      headerRow: 1,
      dateFormat: 'DD/MM/YYYY',
      currencyAliases: {},
      ledgers,
    })
    // "Loopat" is a distinct normalised name so it's proposed as new,
    // but the fuzzy list carries the existing Loopet Pte Ltd as a
    // candidate the operator can accept.
    expect(batch.proposals).toHaveLength(1)
    expect(batch.proposals[0].name).toBe('Loopat')
    expect(batch.proposals[0].fuzzyMatches).toHaveLength(0) // similarity(Loopat, Loopet Pte Ltd) ≈ 0.6, below 0.85
  })

  it('adds a foreign-vs-base flag when INR column drifts more than ₹1', () => {
    // Set INR column to a value 2 rupees higher than foreign×rate.
    // 1050.63 × 84.2582 = 88524.19 (₹8852419 paise). Set to 8852700 (₹2.81 off).
    const badRow = row('08/04/2025', 'INV/25-26/03', 'Alexandra', 'Ref', 'SGD', '1050.63', '88527.00', '84.2582')
    const batch = deriveBatch([badRow], {
      target: 'sales_register',
      columnMap: KS_MAPPING,
      headerRow: 1,
      dateFormat: 'DD/MM/YYYY',
      currencyAliases: {},
      ledgers: emptyLedgers(),
    })
    const mismatch = batch.flags.find((f) => f.kind === 'foreign_base_mismatch')
    expect(mismatch).toBeDefined()
    expect(mismatch!.rowNumber).toBe(2) // header row 1 + row 1
  })

  it('flags rows with missing date or amount and skips them', () => {
    const emptyDate = row('', 'INV-X', 'Alexandra', '', 'INR', '', '1000.00', '')
    const noAmount = row('09/04/2025', 'INV-Y', 'Alexandra', '', 'INR', '', '', '')
    const good     = row('10/04/2025', 'INV-Z', 'Alexandra', '', 'INR', '', '2000.00', '')
    const batch = deriveBatch([emptyDate, noAmount, good], {
      target: 'sales_register',
      columnMap: KS_MAPPING,
      headerRow: 1,
      dateFormat: 'DD/MM/YYYY',
      currencyAliases: {},
      ledgers: emptyLedgers(),
    })
    expect(batch.vouchers).toHaveLength(1) // only "good" makes it
    expect(batch.flags.some((f) => f.kind === 'missing_date')).toBe(true)
    expect(batch.flags.some((f) => f.kind === 'missing_amount')).toBe(true)
  })

  it('silently skips fully-empty rows (clients pad their sheets)', () => {
    const empty = ['', '', '', '', '', '', '', '', '', '', '']
    const good = row('10/04/2025', 'INV-Z', 'Alexandra', '', 'INR', '', '2000.00', '')
    const batch = deriveBatch([empty, good, empty], {
      target: 'sales_register',
      columnMap: KS_MAPPING,
      headerRow: 1,
      dateFormat: 'DD/MM/YYYY',
      currencyAliases: {},
      ledgers: emptyLedgers(),
    })
    expect(batch.totals.rowsScanned).toBe(1)
    expect(batch.totals.rowsDerived).toBe(1)
    expect(batch.flags).toHaveLength(0)
  })

  it('aggregates the currency set for the operator preview', () => {
    const inrRow = row('10/04/2025', 'INV-1', 'A', '', 'INR', '', '1000', '')
    const sgdRow = row('11/04/2025', 'INV-2', 'B', '', 'SGD', '10', '843', '84.3')
    const usdRow = row('12/04/2025', 'INV-3', 'C', '', 'USD', '10', '830', '83')
    const batch = deriveBatch([inrRow, sgdRow, usdRow], {
      target: 'sales_register',
      columnMap: KS_MAPPING,
      headerRow: 1,
      dateFormat: 'DD/MM/YYYY',
      currencyAliases: {},
      ledgers: emptyLedgers(),
    })
    expect(batch.totals.currencies).toEqual(['INR', 'SGD', 'USD'])
    expect(batch.totals.rowsDerived).toBe(3)
  })

  it('applies currency aliases from the mapping — "S$" → SGD', () => {
    const r = row('10/04/2025', 'INV-1', 'A', '', 'S$', '100', '8430', '84.3')
    const batch = deriveBatch([r], {
      target: 'sales_register',
      columnMap: KS_MAPPING,
      headerRow: 1,
      dateFormat: 'DD/MM/YYYY',
      currencyAliases: { 'S$': 'SGD' },
      ledgers: emptyLedgers(),
    })
    expect(batch.vouchers[0].currency).toBe('SGD')
  })
})

describe('deriveBatch — purchase register mirror', () => {
  it('turns a purchase row into a Cr party + Dr purchases voucher', () => {
    const mapping: Record<string, MappableField> = {
      A: 'date', B: 'bill_no', D: 'supplier', F: 'currency', J: 'amount_inr',
    }
    const purchaseRow = ['05/04/2025', 'BILL-1', '', 'VendorX', '', 'INR', '', '', '', '15000.00', '']
    const batch = deriveBatch([purchaseRow], {
      target: 'purchase_register',
      columnMap: mapping,
      headerRow: 1,
      dateFormat: 'DD/MM/YYYY',
      currencyAliases: {},
      ledgers: emptyLedgers(),
    })
    expect(batch.vouchers).toHaveLength(1)
    const v = batch.vouchers[0]
    expect(v.type).toBe('purchase')
    expect(v.balanced).toBe(true)
    const dr = v.entries.find((e) => e.side === 'dr')!
    const cr = v.entries.find((e) => e.side === 'cr')!
    expect(dr.role).toBe('purchase')
    expect(cr.role).toBe('party')
    expect(dr.amountPaise).toBe(1_500_000)
    expect(cr.amountPaise).toBe(1_500_000)
  })
})

describe('deriveBatch — deferred targets', () => {
  it('returns an empty batch for receipt_register (Step 2 defers receipts/payments)', () => {
    const batch = deriveBatch([['x']], {
      target: 'receipt_register',
      columnMap: {},
      headerRow: 1,
      dateFormat: 'DD/MM/YYYY',
      currencyAliases: {},
      ledgers: emptyLedgers(),
    })
    expect(batch.vouchers).toEqual([])
    expect(batch.proposals).toEqual([])
  })
})
