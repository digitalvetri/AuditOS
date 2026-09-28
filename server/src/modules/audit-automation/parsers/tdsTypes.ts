import { toPaise, toIsoDate } from './types.js'

/**
 * Normalized TDS entry shape shared by every 26AS and Books parser.
 * Same seam pattern as NormalizedEntry (GST): parsers change, matcher
 * doesn't.
 */
export interface NormalizedTdsEntry {
  /** 26AS: part_a | part_a1 | part_a2 | part_b | part_c. Not set for Books. */
  part?: string
  /** Bare TDS section code, e.g. "194C", "192". */
  section: string
  /** 10-char TAN, upper-case, no whitespace. */
  deductorTan: string
  deductorName?: string
  /** Q1 | Q2 | Q3 | Q4 */
  quarter: string
  /** Amount paid / credited to deductee — paise. */
  amountPaid: number
  /** TDS deducted — paise. */
  tdsAmount: number
  /** Date TDS was deducted / booked (YYYY-MM-DD). */
  tdsDate: string
  /** TRACES status of booking: F | P | U | O | Z | M. */
  status?: string
  /** 26AS: date the deductor's statement was booked (YYYY-MM-DD). */
  bookingDate?: string
  /** 26AS: TDS deposited by the deductor — paise. */
  tdsDeposited?: number
  remarks?: string
  glCode?: string
  /** Books: voucher / invoice number. */
  reference?: string
  /** Books: voucher type (Receipt, Sales, Journal…). */
  voucherType?: string
  rawJson?: string
}

export interface ParsedTds26AS {
  pan?: string
  /** First year of the AY: AY 2027-28 → 2027 (covers FY 2026-27). */
  assessmentYear?: number
  /** As printed: "2026-27". */
  financialYear?: string
  assesseeName?: string
  generatedAt?: string
  entries: NormalizedTdsEntry[]
}

export interface ParsedTdsBooks {
  entries: NormalizedTdsEntry[]
}

export interface TdsBooksColumnMap {
  /** TAN or name (or both) must be mapped. */
  deductorTan?: string
  deductorName?: string
  section?: string
  reference?: string
  quarter?: string
  amountPaid: string
  tdsAmount: string
  tdsDate: string
  glCode?: string
  /** Row number (1-based) where the data starts. Default 2. */
  dataStartRow?: number
}

/** TAN normalization: strip whitespace, upper-case. */
export function normalizeTan(s: string): string {
  return (s ?? '').replace(/\s+/g, '').toUpperCase()
}

/**
 * TDS / TCS section normalization. `Sec 194C`, `194 C`, `sec.194c`,
 * `Under section 194C(1)`, `TDS on Contract 194C @2%` → `194C`.
 * Multi-letter sections stay whole: 194IA (property) is not 194I (rent),
 * 194LBC is not 194L. A sub-clause in brackets is dropped: 194I(b) → 194I,
 * 194J(a) → 194J. TCS: 206C(1H) → 206C1H. Income-tax Act 2025 codes
 * (393, 394…) are kept as written, without spaces.
 */
export function normalizeSection(s: string): string {
  if (!s) return ''
  const up = String(s).toUpperCase().replace(/(\d)[\s-]+(?=[A-Z](?![A-Z]{3}))/g, '$1')
  // TCS: 206C(1H) as the Act writes it, 206CL / 206CE as TRACES does.
  const tcs = /\b206\s*C\s*(?:\(\s*([0-9A-Z]{1,3})\s*\)|([0-9A-Z]{1,3})(?![A-Z0-9]))?/.exec(up)
  if (tcs) return `206C${tcs[1] ?? tcs[2] ?? ''}`
  const m = /(?:^|[^0-9A-Z])(19[2-6][A-Z]{0,3})(?![A-Z0-9])/.exec(up) ?? /(19[2-6][A-Z]{0,3})(?![A-Z0-9])/.exec(up)
  if (m) return m[1]
  const act25 = /\b(39[2-9](?:\(\s*\w+\s*\))*)/.exec(up)
  if (act25) return act25[1].replace(/\s+/g, '')
  // No recognisable code ("TDS on Rent"): unknown, so matching ignores the section.
  return /\d/.test(up) ? up.replace(/[^0-9A-Z]/g, '') : ''
}

/** Deductor name for matching: upper-case, no punctuation, no company-form suffixes. */
export function normalizeDeductorName(s: string | null | undefined): string {
  return (s ?? '').toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\b(M S|MESSRS|THE)\b/g, ' ')
    .replace(/\b(PRIVATE|PVT|LIMITED|LTD|LLP|CO|COMPANY|CORPN|CORPORATION|INDIA|INC)\b/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

export const TAN_RE = /^[A-Z]{4}\d{5}[A-Z]$/
export const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/

/**
 * Dates as TRACES and Tally write them — 15-Jun-2026, 15/06/2026,
 * 2026-06-15, 20260615, an Excel serial or a Date — to YYYY-MM-DD, without
 * a time-zone shift.
 */
export function tdsDate(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  // Spreadsheet dates arrive as UTC midnight.
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10)
  const s = String(v).trim()
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  const mon = /^(\d{1,2})[-\s/.]([A-Za-z]{3,9})[-\s/.,]*(\d{2,4})$/.exec(s)
  if (mon) {
    const i = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(mon[2].slice(0, 3).toUpperCase())
    if (i < 0) return ''
    const y = mon[3].length === 2 ? `20${mon[3]}` : mon[3]
    return `${y}-${String(i + 1).padStart(2, '0')}-${mon[1].padStart(2, '0')}`
  }
  return toIsoDate(typeof v === 'number' ? v : s)
}

/** AY (first year) whose FY contains this date: 2026-06-15 → 2027 (FY 2026-27, AY 2027-28). */
export function ayOfDate(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})/.exec(iso ?? '')
  if (!m) return null
  return Number(m[2]) >= 4 ? Number(m[1]) + 1 : Number(m[1])
}

/** "AY 2027-28" / "2027-28" / "2027" → 2027. */
export function parseAy(s: string | undefined): number | undefined {
  const m = /(20\d{2})/.exec(s ?? '')
  return m ? Number(m[1]) : undefined
}

export function fyLabel(ay: number): string { return `${ay - 1}-${String(ay % 100).padStart(2, '0')}` }
export function ayLabel(ay: number): string { return `${ay}-${String((ay + 1) % 100).padStart(2, '0')}` }

/**
 * Quarter normalization. Accepts `Q1`, `1`, `Quarter 1`, `Apr-Jun`,
 * `01/04/2026`. Returns `Q1`..`Q4` (Indian FY quarter — Apr-Jun = Q1)
 * or `''` if it can't decide.
 */
export function normalizeQuarter(v: string): string {
  if (!v) return ''
  const s = v.trim().toUpperCase()
  const m = /^Q?([1-4])$/.exec(s)
  if (m) return `Q${m[1]}`
  if (/QUARTER\s*([1-4])/.test(s)) return `Q${/([1-4])/.exec(s)![1]}`
  // From a date → derive quarter
  const iso = tdsDate(v)
  if (iso) {
    const month = Number(iso.slice(5, 7))
    if (month >= 4 && month <= 6) return 'Q1'
    if (month >= 7 && month <= 9) return 'Q2'
    if (month >= 10 && month <= 12) return 'Q3'
    return 'Q4' // Jan-Mar of following calendar year
  }
  const monthRanges: Record<string, string> = {
    'APR-JUN': 'Q1', 'JUL-SEP': 'Q2', 'OCT-DEC': 'Q3', 'JAN-MAR': 'Q4',
  }
  return monthRanges[s.replace(/\s+/g, '').toUpperCase()] ?? ''
}

export { toPaise, toIsoDate }
