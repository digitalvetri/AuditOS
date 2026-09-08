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
  /** TRACES status (Booked / Provisional / Overbooked / etc.). */
  status?: string
  glCode?: string
  rawJson?: string
}

export interface ParsedTds26AS {
  pan?: string
  assessmentYear?: number
  generatedAt?: string
  entries: NormalizedTdsEntry[]
}

export interface ParsedTdsBooks {
  entries: NormalizedTdsEntry[]
}

export interface TdsBooksColumnMap {
  deductorTan: string
  deductorName?: string
  section: string
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
 * TDS section normalization: pull the leading numeric code with an
 * optional single trailing letter. `Sec 194C`, `194 C`, `sec.194c`,
 * `Under section 194C(1)` all → `194C`.
 */
export function normalizeSection(s: string): string {
  if (!s) return ''
  const m = /(\d{2,3}[A-Za-z]?)/.exec(s.replace(/\s+/g, ''))
  return m ? m[1].toUpperCase() : s.trim().toUpperCase()
}

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
  const iso = toIsoDate(v)
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
