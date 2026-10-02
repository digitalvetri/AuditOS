import { ToolError } from '../errors.js'

/**
 * CSVService — parse raw CSV/TSV into typed rows without mangling the values
 * an accountant cares about.
 *
 *   • Leading zeros survive (GSTIN, invoice numbers, TAN, PIN codes).
 *   • Dates are never reformatted — they stay the text the file carried.
 *   • Only unambiguous numbers become numbers; the caller can force any
 *     column (or every column) to stay text.
 */
export type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252'
export type Delimiter = ',' | ';' | '\t' | '|'
export type ColumnType = 'number' | 'date' | 'text'

export interface Detection {
  encoding: Encoding
  delimiter: Delimiter
  hasHeader: boolean
}

export interface ParsedCSV {
  rows: string[][]
  detection: Detection
  columns: ColumnType[]
  columnNames: string[]
  skipped: number
}

export const CSVService = {
  detectEncoding(bytes: Buffer): Encoding {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return 'utf-8'
    } catch {
      return 'windows-1252'
    }
  },

  decode(bytes: Buffer, encoding: Encoding): string {
    const text = new TextDecoder(encoding, { ignoreBOM: false }).decode(bytes)
    return text.replace(/^﻿/, '')
  },

  detectDelimiter(text: string): Delimiter {
    const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 25)
    const candidates: Delimiter[] = [',', ';', '\t', '|']
    let best: Delimiter = ','
    let bestScore = -1
    for (const d of candidates) {
      const counts = sample.map((l) => countOutsideQuotes(l, d))
      const nonZero = counts.filter((c) => c > 0)
      if (nonZero.length === 0) continue
      const mean = nonZero.reduce((a, b) => a + b, 0) / nonZero.length
      const variance = nonZero.reduce((a, b) => a + (b - mean) ** 2, 0) / nonZero.length
      // Prefer a delimiter that appears on most lines with a stable count.
      const score = (nonZero.length / sample.length) * mean / (1 + variance)
      if (score > bestScore) { bestScore = score; best = d }
    }
    return best
  },

  /** RFC 4180 parse with the given delimiter; tolerant of bare quotes. */
  parseRows(text: string, delimiter: Delimiter): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let field = ''
    let quoted = false
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
        } else field += ch
        continue
      }
      if (ch === '"') { quoted = true; continue }
      if (ch === delimiter) { row.push(field); field = ''; continue }
      if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++
        row.push(field); field = ''
        rows.push(row); row = []
        continue
      }
      field += ch
    }
    if (field.length || row.length) { row.push(field); rows.push(row) }
    // Drop fully empty trailing rows.
    while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop()
    return rows
  },

  /** Heuristic: a header row is mostly non-numeric while the next row is not. */
  guessHeader(rows: string[][]): boolean {
    if (rows.length < 2) return rows.length === 1
    const [first, second] = rows
    const numeric = (v: string) => CSVService.classify(v) === 'number'
    const firstNumeric = first.filter(numeric).length
    const secondNumeric = second.filter(numeric).length
    if (firstNumeric === 0 && secondNumeric > 0) return true
    if (firstNumeric === 0 && first.every((c) => c.trim() !== '')) return true
    return false
  },

  /** What one cell looks like. Leading-zero codes and dates are NOT numbers. */
  classify(raw: string): ColumnType | 'empty' {
    const v = raw.trim()
    if (v === '') return 'empty'
    if (isDate(v)) return 'date'
    if (parseNumber(v) !== null) return 'number'
    return 'text'
  },

  inferColumns(rows: string[][], skipHeader: boolean): ColumnType[] {
    const body = skipHeader ? rows.slice(1) : rows
    const width = Math.max(0, ...rows.map((r) => r.length))
    const types: ColumnType[] = []
    for (let c = 0; c < width; c++) {
      let numbers = 0, dates = 0, texts = 0
      for (const r of body) {
        const k = CSVService.classify(r[c] ?? '')
        if (k === 'number') numbers++
        else if (k === 'date') dates++
        else if (k === 'text') texts++
      }
      const seen = numbers + dates + texts
      if (seen === 0) types.push('text')
      else if (texts === 0 && dates === 0) types.push('number')
      else if (texts === 0 && numbers === 0) types.push('date')
      else types.push('text')
    }
    return types
  },

  parse(bytes: Buffer, opts: { delimiter?: Delimiter | 'auto'; encoding?: Encoding | 'auto'; hasHeader?: boolean | 'auto' } = {}): ParsedCSV {
    if (bytes.length === 0) throw new ToolError('empty', 'This file is empty.')
    const encoding = !opts.encoding || opts.encoding === 'auto' ? CSVService.detectEncoding(bytes) : opts.encoding
    const text = CSVService.decode(bytes, encoding)
    if (!text.trim()) throw new ToolError('empty', 'This file is empty.')
    const delimiter = !opts.delimiter || opts.delimiter === 'auto' ? CSVService.detectDelimiter(text) : opts.delimiter
    const raw = CSVService.parseRows(text, delimiter)
    const width = Math.max(...raw.map((r) => r.length))
    // Rows that are wildly narrower than the header are usually stray notes; keep
    // them but count them so the caller can report an honest partial result.
    const rows = raw.map((r) => (r.length < width ? [...r, ...new Array(width - r.length).fill('')] : r))
    const skipped = raw.filter((r) => r.every((c) => c.trim() === '')).length
    const hasHeader = opts.hasHeader === undefined || opts.hasHeader === 'auto' ? CSVService.guessHeader(rows) : opts.hasHeader
    const columns = CSVService.inferColumns(rows, hasHeader)
    const columnNames = hasHeader
      ? rows[0].map((h, i) => (h.trim() || `Column ${i + 1}`))
      : columns.map((_, i) => `Column ${i + 1}`)
    return { rows, detection: { encoding, delimiter, hasHeader }, columns, columnNames, skipped }
  },

  toNumber: parseNumber,
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0, q = false
  for (const ch of line) {
    if (ch === '"') q = !q
    else if (!q && ch === d) n++
  }
  return n
}

/**
 * Strict numeric parse. Accepts 1234, -12.5, 1,25,000.00 (Indian grouping),
 * 1,250,000 (Western grouping), (1,200) accounting negatives, ₹/Rs prefixes.
 * Rejects leading-zero codes ("0012"), anything with letters, and dates.
 */
export function parseNumber(raw: string): number | null {
  let v = raw.trim()
  if (!v) return null
  let negative = false
  if (/^\(.*\)$/.test(v)) { negative = true; v = v.slice(1, -1).trim() }
  v = v.replace(/^(₹|Rs\.?|INR)\s*/i, '')
  if (v.startsWith('-')) { negative = !negative; v = v.slice(1).trim() }
  else if (v.startsWith('+')) v = v.slice(1).trim()
  if (v.endsWith('-')) { negative = !negative; v = v.slice(0, -1).trim() } // 1,200- (some bank exports)
  if (!/^\d[\d,]*(\.\d+)?$|^\.\d+$/.test(v)) return null
  const intPart = v.split('.')[0]
  // Leading zero followed by more digits → an identifier, not a number.
  if (/^0\d/.test(intPart.replace(/,/g, ''))) return null
  if (intPart.includes(',')) {
    // Grouping must be Indian (x,xx,xxx) or Western (x,xxx,xxx); otherwise it is text.
    const indian = /^\d{1,2}(,\d{2})*,\d{3}$/.test(intPart)
    const western = /^\d{1,3}(,\d{3})+$/.test(intPart)
    if (!indian && !western) return null
  }
  const n = Number(v.replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  // Beyond 2^53 a JS number loses digits — keep such values as text.
  if (Math.abs(n) > Number.MAX_SAFE_INTEGER) return null
  return negative ? -n : n
}

const DATE_PATTERNS = [
  /^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/,                   // 08/09/2026, 8-9-26
  /^\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}$/,                     // 2026-09-08
  /^\d{1,2}[ \-]?[A-Za-z]{3,9}[ \-,]+\d{2,4}$/,             // 08 Sep 2026, 8-Sep-26
  /^[A-Za-z]{3,9}[ \-]\d{1,2},?[ \-]\d{2,4}$/,               // Sep 08, 2026
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,                           // ISO timestamp
]
export function isDate(v: string): boolean {
  return DATE_PATTERNS.some((p) => p.test(v.trim()))
}
