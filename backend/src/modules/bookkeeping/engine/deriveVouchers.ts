/**
 * Voucher derivation from a mapped register (BOOKKEEPING-REBUILD §3.2).
 *
 * Take one flat row from the client's Sales or Purchase register, plus
 * the saved column mapping, and produce a balanced voucher shape that
 * the existing posting engine can consume in Step 3. Nothing here writes
 * to the ledger — this is a pure function over the row data and a
 * snapshot of the company's ledgers, so it can be run for the preview
 * screen without side effects.
 *
 * The output has three parts, each with a different downstream owner:
 *   • vouchers  — the derived debit/credit lines, one row = one voucher
 *   • proposals — party names seen in the file that aren't matched to
 *                 an existing ledger, with any fuzzy candidates attached
 *   • flags     — per-row issues the preview screen surfaces
 *                 (foreign×rate mismatch, missing date, etc.)
 *
 * Empty rows are silently skipped — clients pad their sheets.
 */
import { Prisma } from '@prisma/client'
import { foreignMatchesBase } from './currency.js'
import {
  findFuzzyMatches,
  normalizeParty,
  type FuzzyMatch,
  type MatchCandidate,
} from './partyMatch.js'
import { colLetterToIndex, type MappableField } from '../services/BookkeepingImportService.js'

const FUZZY_THRESHOLD = 0.85

export type DerivedVoucherType = 'sales' | 'purchase'

export interface DerivedEntry {
  side: 'dr' | 'cr'
  role:
    | 'party'
    | 'sales'
    | 'purchase'
    | 'cgst_output'
    | 'sgst_output'
    | 'igst_output'
    | 'cgst_input'
    | 'sgst_input'
    | 'igst_input'
    | 'cess'
  /**
   * The ledger this line will post to. `null` when the party ledger is a
   * proposal that has not yet been created — the preview UI shows the
   * party name and the operator resolves it before commit.
   */
  ledgerId: string | null
  /** Fallback label the UI shows when `ledgerId` is null. */
  displayLabel: string
  amountPaise: number
}

export interface DerivedVoucher {
  /** 1-based row number in the source sheet, for the "which row?" link in the UI. */
  rowNumber: number
  type: DerivedVoucherType
  date: string | null
  invoiceOrBillNo: string | null
  partyName: string
  partyLedgerId: string | null
  currency: string
  foreignAmountMinor: number | null
  exchangeRate: string | null
  totalPaise: number
  balanced: boolean
  entries: DerivedEntry[]
}

export type FlagKind =
  | 'foreign_base_mismatch'
  | 'missing_date'
  | 'missing_party'
  | 'missing_amount'
  | 'unbalanced'
  | 'no_sales_ledger'
  | 'no_purchase_ledger'

export interface RowFlag {
  rowNumber: number
  kind: FlagKind
  message: string
}

export interface PartyProposal {
  name: string
  normalizedName: string
  group: 'sundry_debtors' | 'sundry_creditors'
  occurrenceCount: number
  fuzzyMatches: FuzzyMatch[]
}

export interface DerivedBatch {
  vouchers: DerivedVoucher[]
  proposals: PartyProposal[]
  flags: RowFlag[]
  totals: {
    rowsScanned: number
    rowsDerived: number
    totalPaise: number
    currencies: string[]
  }
}

// --- Ledger snapshot ---------------------------------------------------

/**
 * The subset of the company's ledger book the deriver needs. Passed in
 * so this file has no Prisma dependency and can be unit-tested against
 * a hand-written snapshot.
 */
export interface LedgerSnapshot {
  parties: MatchCandidate[] // Sundry Debtors / Creditors — anything party-shaped
  salesLedgerId: string | null
  purchaseLedgerId: string | null
  cgstOutputLedgerId: string | null
  sgstOutputLedgerId: string | null
  igstOutputLedgerId: string | null
  cgstInputLedgerId: string | null
  sgstInputLedgerId: string | null
  igstInputLedgerId: string | null
}

// --- Row shape ---------------------------------------------------------

export interface DeriveOptions {
  target: 'sales_register' | 'purchase_register' | 'receipt_register' | 'payment_register'
  columnMap: Record<string, MappableField>
  headerRow: number
  dateFormat: string
  currencyAliases: Record<string, string>
  ledgers: LedgerSnapshot
}

/**
 * `rows[0]` is the FIRST data row (i.e. the caller has already dropped
 * the header). The `rowNumber` we surface in flags starts at
 * `headerRow + 1` so it matches what the operator sees in Excel.
 */
export function deriveBatch(rows: string[][], opts: DeriveOptions): DerivedBatch {
  const vouchers: DerivedVoucher[] = []
  const flags: RowFlag[] = []
  const partyCounts = new Map<string, { name: string; count: number }>()
  const currencies = new Set<string>()
  let totalPaise = 0

  const indexByField = buildIndexByField(opts.columnMap)
  const type: DerivedVoucherType | null =
    opts.target === 'sales_register' ? 'sales' :
    opts.target === 'purchase_register' ? 'purchase' :
    null

  // Receipts / payments come later — spec §3.2 defers them to the
  // Tally-export split logic reuse. Return an empty batch so the caller
  // can display "not derived yet" for those targets.
  if (!type) {
    return { vouchers: [], proposals: [], flags: [], totals: { rowsScanned: rows.length, rowsDerived: 0, totalPaise: 0, currencies: [] } }
  }

  let rowsScanned = 0
  let rowsDerived = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.every((c) => !c || c.trim() === '')) continue // empty
    rowsScanned++
    const rowNumber = opts.headerRow + 1 + i

    const raw = extractRow(row, indexByField)
    const rowFlags = validateRow(rowNumber, raw, type, opts.ledgers)
    if (rowFlags.some((f) => f.kind === 'missing_amount' || f.kind === 'missing_date')) {
      flags.push(...rowFlags)
      continue // cannot derive a voucher without date + amount
    }
    flags.push(...rowFlags)

    const currency = resolveCurrency(raw.currency, opts.currencyAliases)
    currencies.add(currency)

    const foreignBaseFlag = checkForeignVsBase(rowNumber, raw, currency)
    if (foreignBaseFlag) flags.push(foreignBaseFlag)

    const amountPaise = raw.amountInrPaise ?? raw.totalPaise ?? 0
    const taxableValue = raw.taxableValuePaise ?? amountPaise - sumTaxes(raw)

    const partyName = (type === 'sales' ? raw.customer : raw.supplier) ?? ''
    if (partyName) {
      const key = normalizeParty(partyName)
      const existing = partyCounts.get(key)
      if (existing) existing.count++
      else partyCounts.set(key, { name: partyName, count: 1 })
    }

    const partyLedgerId = resolvePartyLedger(partyName, opts.ledgers.parties)

    const entries = buildEntries(type, raw, amountPaise, taxableValue, partyLedgerId, partyName, opts.ledgers)
    const balanced = isBalanced(entries)
    if (!balanced) {
      flags.push({ rowNumber, kind: 'unbalanced',
        message: `Row ${rowNumber}: entries do not balance (Dr ≠ Cr). Check the amount/tax columns.` })
    }

    vouchers.push({
      rowNumber,
      type,
      date: raw.date,
      invoiceOrBillNo: raw.invoiceNo ?? raw.billNo ?? null,
      partyName,
      partyLedgerId,
      currency,
      foreignAmountMinor: raw.foreignAmountMinor ?? null,
      exchangeRate: raw.exchangeRate ?? null,
      totalPaise: amountPaise,
      balanced,
      entries,
    })
    rowsDerived++
    totalPaise += amountPaise
  }

  // Compile party proposals — every party seen in the file that did NOT
  // resolve to an existing ledger. Fuzzy candidates attached per §3.3.
  const proposals: PartyProposal[] = []
  const group: PartyProposal['group'] = type === 'sales' ? 'sundry_debtors' : 'sundry_creditors'
  for (const [normalized, { name, count }] of partyCounts) {
    const partyLedgerId = resolvePartyLedger(name, opts.ledgers.parties)
    if (partyLedgerId) continue // already an exact match, no proposal needed
    const fuzzyMatches = findFuzzyMatches(name, opts.ledgers.parties, { threshold: FUZZY_THRESHOLD })
    proposals.push({ name, normalizedName: normalized, group, occurrenceCount: count, fuzzyMatches })
  }

  return {
    vouchers,
    proposals,
    flags,
    totals: {
      rowsScanned,
      rowsDerived,
      totalPaise,
      currencies: [...currencies].sort(),
    },
  }
}

// --- Helpers -----------------------------------------------------------

/**
 * The column → field map is stored as `{ A: "date", B: "invoice_no", ... }`
 * but derivation needs the inverse: field → column index (0-based).
 * A field that isn't mapped is not present in the returned record.
 */
function buildIndexByField(map: Record<string, MappableField>): Partial<Record<MappableField, number>> {
  const out: Partial<Record<MappableField, number>> = {}
  for (const [letter, field] of Object.entries(map)) {
    if (field === 'ignore') continue
    out[field] = colLetterToIndex(letter) - 1
  }
  return out
}

interface RawRow {
  date: string | null
  invoiceNo: string | null
  billNo: string | null
  customer: string | null
  supplier: string | null
  currency: string
  foreignAmountMinor: number | null
  exchangeRate: string | null
  amountInrPaise: number | null
  taxableValuePaise: number | null
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  cessPaise: number
  totalPaise: number | null
}

function extractRow(row: string[], idx: Partial<Record<MappableField, number>>): RawRow {
  const cell = (f: MappableField): string => {
    const i = idx[f]
    if (i === undefined) return ''
    return (row[i] ?? '').trim()
  }
  return {
    date: cell('date') || null,
    invoiceNo: cell('invoice_no') || null,
    billNo: cell('bill_no') || null,
    customer: cell('customer') || null,
    supplier: cell('supplier') || null,
    currency: cell('currency') || 'INR',
    foreignAmountMinor: toMinorUnits(cell('foreign_amount')),
    exchangeRate: cell('exchange_rate') || null,
    amountInrPaise: toPaise(cell('amount_inr')),
    taxableValuePaise: toPaise(cell('taxable_value')),
    cgstPaise: toPaise(cell('cgst')) ?? 0,
    sgstPaise: toPaise(cell('sgst')) ?? 0,
    igstPaise: toPaise(cell('igst')) ?? 0,
    cessPaise: toPaise(cell('cess')) ?? 0,
    totalPaise: toPaise(cell('total')),
  }
}

/**
 * Parse a currency-amount cell into integer minor units.
 * `"1050.63"` → 105063.
 * Empty string → null (so a missing column doesn't get treated as zero).
 * Anything unparseable → null.
 */
function toMinorUnits(v: string): number | null {
  if (!v || v.trim() === '') return null
  // Excel exports often carry stray currency symbols or spaces.
  const cleaned = v.replace(/[^\d.\-]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return null
  // Round to 2 decimals then to integer minor units. `88524.20769`
  // → 8852420.769 → 8852421.
  return Math.round(n * 100)
}

/** paise = minor units of INR. Alias for readability. */
function toPaise(v: string): number | null {
  return toMinorUnits(v)
}

function resolveCurrency(raw: string, aliases: Record<string, string>): string {
  const s = (raw ?? '').trim()
  if (!s) return 'INR'
  if (aliases[s]) return aliases[s]
  const upper = s.toUpperCase()
  if (/^[A-Z]{3}$/.test(upper)) return upper
  return upper
}

function sumTaxes(r: RawRow): number {
  return r.cgstPaise + r.sgstPaise + r.igstPaise + r.cessPaise
}

/**
 * Try to find the party ledger by exact name (case-insensitive) or by
 * normalised name. Fuzzy matches are deliberately NOT auto-resolved —
 * the operator decides on the proposals screen (§3.3).
 */
function resolvePartyLedger(name: string, parties: MatchCandidate[]): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  for (const p of parties) {
    if (p.name.trim().toLowerCase() === lower) return p.ledgerId
  }
  const target = normalizeParty(trimmed)
  for (const p of parties) {
    if (normalizeParty(p.name) === target) return p.ledgerId
  }
  return null
}

function checkForeignVsBase(rowNumber: number, r: RawRow, currency: string): RowFlag | null {
  const baseAmountPaise = r.amountInrPaise ?? r.totalPaise
  if (currency === 'INR' || !r.foreignAmountMinor || !r.exchangeRate || !baseAmountPaise) return null
  const ok = foreignMatchesBase({
    foreignAmountMinor: r.foreignAmountMinor,
    exchangeRate: r.exchangeRate,
    amountPaise: baseAmountPaise,
  })
  if (ok) return null
  const expected = new Prisma.Decimal(r.foreignAmountMinor).times(new Prisma.Decimal(r.exchangeRate)).round().toNumber()
  return {
    rowNumber,
    kind: 'foreign_base_mismatch',
    message: `Row ${rowNumber}: foreign × rate = ${expected} paise but the INR column shows ${baseAmountPaise} paise (> ₹1 off).`,
  }
}

function validateRow(rowNumber: number, r: RawRow, type: DerivedVoucherType, ledgers: LedgerSnapshot): RowFlag[] {
  const flags: RowFlag[] = []
  if (!r.date) {
    flags.push({ rowNumber, kind: 'missing_date',
      message: `Row ${rowNumber}: date column is empty.` })
  }
  if (r.amountInrPaise === null && r.totalPaise === null) {
    flags.push({ rowNumber, kind: 'missing_amount',
      message: `Row ${rowNumber}: neither the Amount (INR) nor Total column has a value.` })
  }
  const partyName = type === 'sales' ? r.customer : r.supplier
  if (!partyName) {
    flags.push({ rowNumber, kind: 'missing_party',
      message: `Row ${rowNumber}: the ${type === 'sales' ? 'Customer' : 'Supplier'} column is empty.` })
  }
  if (type === 'sales' && !ledgers.salesLedgerId) {
    flags.push({ rowNumber, kind: 'no_sales_ledger',
      message: `No Sales ledger is configured on this company — create one under Sales Accounts before importing.` })
  }
  if (type === 'purchase' && !ledgers.purchaseLedgerId) {
    flags.push({ rowNumber, kind: 'no_purchase_ledger',
      message: `No Purchases ledger is configured on this company — create one under Purchase Accounts before importing.` })
  }
  return flags
}

function buildEntries(
  type: DerivedVoucherType,
  r: RawRow,
  totalPaise: number,
  taxableValue: number,
  partyLedgerId: string | null,
  partyName: string,
  ledgers: LedgerSnapshot,
): DerivedEntry[] {
  const entries: DerivedEntry[] = []
  if (type === 'sales') {
    entries.push({
      side: 'dr',
      role: 'party',
      ledgerId: partyLedgerId,
      displayLabel: partyName || '(missing customer)',
      amountPaise: totalPaise,
    })
    entries.push({
      side: 'cr',
      role: 'sales',
      ledgerId: ledgers.salesLedgerId,
      displayLabel: 'Sales',
      amountPaise: taxableValue,
    })
    if (r.cgstPaise) entries.push(taxLine('cr', 'cgst_output', ledgers.cgstOutputLedgerId, 'Output CGST', r.cgstPaise))
    if (r.sgstPaise) entries.push(taxLine('cr', 'sgst_output', ledgers.sgstOutputLedgerId, 'Output SGST', r.sgstPaise))
    if (r.igstPaise) entries.push(taxLine('cr', 'igst_output', ledgers.igstOutputLedgerId, 'Output IGST', r.igstPaise))
    if (r.cessPaise) entries.push(taxLine('cr', 'cess', null, 'Output Cess', r.cessPaise))
  } else {
    entries.push({
      side: 'dr',
      role: 'purchase',
      ledgerId: ledgers.purchaseLedgerId,
      displayLabel: 'Purchases',
      amountPaise: taxableValue,
    })
    if (r.cgstPaise) entries.push(taxLine('dr', 'cgst_input', ledgers.cgstInputLedgerId, 'Input CGST', r.cgstPaise))
    if (r.sgstPaise) entries.push(taxLine('dr', 'sgst_input', ledgers.sgstInputLedgerId, 'Input SGST', r.sgstPaise))
    if (r.igstPaise) entries.push(taxLine('dr', 'igst_input', ledgers.igstInputLedgerId, 'Input IGST', r.igstPaise))
    if (r.cessPaise) entries.push(taxLine('dr', 'cess', null, 'Input Cess', r.cessPaise))
    entries.push({
      side: 'cr',
      role: 'party',
      ledgerId: partyLedgerId,
      displayLabel: partyName || '(missing supplier)',
      amountPaise: totalPaise,
    })
  }
  return entries
}

function taxLine(side: 'dr' | 'cr', role: DerivedEntry['role'], ledgerId: string | null, label: string, amount: number): DerivedEntry {
  return { side, role, ledgerId, displayLabel: label, amountPaise: amount }
}

function isBalanced(entries: DerivedEntry[]): boolean {
  let dr = 0, cr = 0
  for (const e of entries) {
    if (e.side === 'dr') dr += e.amountPaise
    else cr += e.amountPaise
  }
  return dr === cr
}
