/**
 * Normalized entry shape shared by every GSTR-2B and Purchase Register
 * parser. This is the seam the matching engine sees — parsers change,
 * matcher doesn't.
 *
 * Amounts are integer PAISE (INR minor units) for exact arithmetic —
 * same convention as the rest of the schema.
 */
export interface NormalizedEntry {
  /** GSTR-2B section (b2b | cdnr | isd | impg | imps | b2ba | cdnra | isda). Not set for PR. */
  section?: string
  supplierGstin: string
  supplierName?: string
  invoiceNumber: string
  /** YYYY-MM-DD. */
  invoiceDate: string
  taxableValue: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  /** GSTN's own "ITC Available" flag. Only on 2B entries. */
  itcAvailable?: boolean
  /** Ledger / GL code from the client's register. Only on PR entries. */
  glCode?: string
  /** JSON string of the source row, kept for debugging / re-parse. */
  rawJson?: string
}

export interface ParsedFiling2B {
  gstin?: string
  generatedAt?: string
  entries: NormalizedEntry[]
}

export interface ParsedPurchaseRegister {
  entries: NormalizedEntry[]
}

/**
 * Column map for Purchase Register Excel files. Keys are the target
 * field names; values are Excel column letters (A, B, ..., AA...).
 * The auditor picks which spreadsheet column feeds each target field
 * on the upload wizard.
 */
export interface PurchaseRegisterColumnMap {
  supplierGstin: string
  supplierName?: string
  invoiceNumber: string
  invoiceDate: string
  taxableValue: string
  igst?: string
  cgst?: string
  sgst?: string
  cess?: string
  glCode?: string
  /** Row number (1-based) where the data starts. Default 2 (row 1 is headers). */
  dataStartRow?: number
}

/** Convert a rupees decimal string / number to paise (Int). */
export function toPaise(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[₹,\s]/g, ''))
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100)
}

/**
 * Normalize an invoice number for matching. Strip whitespace, upper-case,
 * strip leading zeros in the numeric tail. This makes `INV/2024/0007`
 * and `inv / 2024 / 7` match.
 */
export function normalizeInvoiceNumber(s: string): string {
  const trimmed = (s ?? '').replace(/\s+/g, '').toUpperCase()
  return trimmed.replace(/(\D)0+(\d)/g, '$1$2')
}

/** GSTIN — strip whitespace, upper-case. */
export function normalizeGstin(s: string): string {
  return (s ?? '').replace(/\s+/g, '').toUpperCase()
}

/**
 * Parse a date-ish value into YYYY-MM-DD. Accepts:
 *   - '2026-04-15' (already ISO)
 *   - '15-04-2026' / '15/04/2026' (Indian DD-MM-YYYY, DD/MM/YYYY)
 *   - Excel serial numbers (days since 1899-12-30)
 *   - JS Date objects
 * Returns '' if it can't parse.
 */
export function toIsoDate(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Excel serial → JS Date. 25569 is 1970-01-01.
    const ms = Math.round((v - 25569) * 86400 * 1000)
    return new Date(ms).toISOString().slice(0, 10)
  }
  const s = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = /^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/.exec(s)
  if (m) {
    const d = m[1].padStart(2, '0')
    const mo = m[2].padStart(2, '0')
    let y = m[3]
    if (y.length === 2) y = (Number(y) >= 70 ? '19' : '20') + y
    return `${y}-${mo}-${d}`
  }
  const parsed = new Date(s)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)
  return ''
}
