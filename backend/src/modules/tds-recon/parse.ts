/**
 * 26AS and books TDS register → entries, amounts in paise.
 *
 * 26AS text / PDF goes through the Tools converter (ComplianceService.
 * form26asToExcel) — the one 26AS reader in the codebase — and its "Part A -
 * TDS" sheet is read back. An Excel 26AS (TRACES export or the converter's
 * own output) is read by loose header names, like the books register.
 */
import ExcelJS from 'exceljs'
import { ApiError } from '../../lib/http.js'
import { parseCsv } from '../zpay/invoice-import.js'
import { ComplianceService } from '../tools/services/tools/ComplianceService.js'
import { ToolError } from '../tools/services/errors.js'

export interface ParsedEntry {
  deductorName: string | null
  tan: string
  section: string
  date: string
  quarter: string
  amountPaid: bigint
  tds: bigint
  tdsDeposited: bigint
  status: string | null
  reference: string | null
  raw: Record<string, string>
}

export interface ParseResult { entries: ParsedEntry[]; skipped: { row: number; reason: string }[]; format: string }

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
export const normSection = (s: string) => s.toUpperCase().replace(/^(SEC(TION)?|U\/?S)\.?/, '').replace(/[^0-9A-Z]/g, '')
export const normTan = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, '')
const TAN_RE = /^[A-Z]{4}\d{5}[A-Z]$/

/** dd/mm/yyyy (Indian), yyyy-mm-dd, 05-Apr-2026 → YYYY-MM-DD. */
export function toIso(raw: string): string | null {
  const s = raw.trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/)
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    if (Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[1]) < 1 || Number(m[1]) > 31) return null
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  }
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2,4})$/)
  if (m) {
    const idx = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].slice(0, 3).toLowerCase())
    if (idx < 0) return null
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    return `${y}-${String(idx + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`
  }
  return null
}

/** '1,23,456.78' / '(12.00)' → paise. Null when not a number. */
export function toPaise(raw: string): bigint | null {
  let s = raw.trim().replace(/[₹,\s]/g, '')
  if (!s) return null
  let sign = 1n
  if (/^\(.*\)$/.test(s)) { sign = -1n; s = s.slice(1, -1) }
  s = s.replace(/(cr|dr)$/i, '')
  const m = /^(-?)(\d*)(?:\.(\d{0,2})\d*)?$/.exec(s)
  if (!m || (!m[2] && !m[3])) return null
  const v = BigInt(m[2] || '0') * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0')
  return (m[1] ? -v : v) * sign
}

export function quarterOf(date: string): string {
  const m = Number(date.slice(5, 7))
  return m >= 4 && m <= 6 ? 'Q1' : m >= 7 && m <= 9 ? 'Q2' : m >= 10 ? 'Q3' : 'Q4'
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'number') return String(v)
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>
    if ('result' in o) return cellText(o.result as ExcelJS.CellValue)
    if ('richText' in o) return (o.richText as { text: string }[]).map((r) => r.text).join('')
    if ('text' in o) return String(o.text)
    return ''
  }
  return String(v).trim()
}

async function sheets(bytes: Buffer): Promise<{ name: string; rows: string[][] }[]> {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer)
  } catch {
    throw ApiError.unprocessable('unreadable', 'This Excel file could not be opened. Save it as .xlsx without a password and try again.')
  }
  return wb.worksheets.map((ws) => {
    const rows: string[][] = []
    ws.eachRow({ includeEmpty: false }, (row) => {
      const out: string[] = []
      row.eachCell({ includeEmpty: true }, (cell, col) => { out[col - 1] = cellText(cell.value) })
      for (let i = 0; i < out.length; i++) out[i] ??= ''
      rows.push(out)
    })
    return { name: ws.name, rows }
  })
}

const ALIASES: Record<string, string[]> = {
  party: ['party', 'partyname', 'deductor', 'deductorname', 'nameofdeductor', 'name', 'customer', 'customername', 'ledger'],
  tan: ['tan', 'deductortan', 'tanofdeductor', 'tanno'],
  section: ['section', 'sec', 'tdssection', 'sectioncode', 'section1'],
  amount: ['amount', 'amountpaid', 'amountcredited', 'amountpaidcredited', 'grossamount', 'invoiceamount', 'amountpaidorcredited', 'transactionamount'],
  tds: ['tds', 'tdsamount', 'tdsdeducted', 'taxdeducted', 'tdsdeductedamount', 'tdsreceivable'],
  deposited: ['tdsdeposited', 'taxdeposited'],
  date: ['date', 'tdsdate', 'transactiondate', 'invoicedate', 'voucherdate', 'dateofpaymentcredit', 'dateofdeduction'],
  status: ['status', 'statusofbooking', 'bookingstatus'],
  reference: ['reference', 'ref', 'voucher', 'voucherno', 'invoiceno', 'billno'],
}

function headerMap(row: string[]): Map<string, number> {
  const m = new Map<string, number>()
  row.forEach((h, i) => {
    const k = norm(h)
    for (const [field, names] of Object.entries(ALIASES)) if (!m.has(field) && names.includes(k)) m.set(field, i)
  })
  return m
}

/** Rows with a recognised header → entries. Needs TAN or party, section, TDS. */
function fromTable(rows: string[][], fallbackDate: string): ParseResult & { found: boolean } {
  const at = rows.slice(0, 25).findIndex((r) => {
    const h = headerMap(r)
    return h.has('section') && h.has('tds') && (h.has('tan') || h.has('party'))
  })
  if (at < 0) return { entries: [], skipped: [], format: '', found: false }
  const h = headerMap(rows[at])
  const get = (r: string[], f: string) => (h.has(f) ? (r[h.get(f)!] ?? '').trim() : '')
  const entries: ParsedEntry[] = []
  const skipped: { row: number; reason: string }[] = []
  rows.slice(at + 1).forEach((r, i) => {
    const n = at + i + 2
    if (r.every((c) => !String(c ?? '').trim())) return
    const party = get(r, 'party')
    if (/^(grand\s*)?total$/i.test(party)) return
    const tds = toPaise(get(r, 'tds'))
    const section = normSection(get(r, 'section'))
    const tan = normTan(get(r, 'tan'))
    if (tds === null) { skipped.push({ row: n, reason: 'no TDS amount' }); return }
    if (!section) { skipped.push({ row: n, reason: 'no section' }); return }
    if (!tan && !party) { skipped.push({ row: n, reason: 'no TAN or party name' }); return }
    if (tan && !TAN_RE.test(tan)) { skipped.push({ row: n, reason: `TAN ${tan} is not valid` }); return }
    const date = toIso(get(r, 'date')) ?? fallbackDate
    const raw: Record<string, string> = {}
    rows[at].forEach((head, j) => { if (head) raw[head] = r[j] ?? '' })
    entries.push({
      deductorName: party || null, tan, section, date, quarter: date ? quarterOf(date) : '',
      amountPaid: toPaise(get(r, 'amount')) ?? 0n, tds, tdsDeposited: toPaise(get(r, 'deposited')) ?? 0n,
      status: get(r, 'status').toUpperCase().slice(0, 1) || null, reference: get(r, 'reference') || null, raw,
    })
  })
  return { entries, skipped, format: '', found: true }
}

const isZip = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
const isPdf = (b: Buffer) => b.length > 4 && b.subarray(0, 4).toString('latin1') === '%PDF'

/** Form 26AS: TRACES text, PDF or Excel. */
export async function parse26AS(bytes: Buffer, filename: string): Promise<ParseResult & { sourceFormat: 'text' | 'excel' }> {
  if (isZip(bytes)) {
    for (const s of await sheets(bytes)) {
      const r = fromTable(s.rows, '')
      if (r.found && r.entries.length) return { ...r, format: 'excel', sourceFormat: 'excel' }
    }
    throw ApiError.unprocessable('no_tables', 'No 26AS rows (TAN, section, TDS) were found in this workbook.')
  }
  const text = !isPdf(bytes)
  if (text && bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) {
    throw ApiError.unprocessable('unsupported_type', `${filename} is not a 26AS text, PDF or Excel file.`)
  }
  let out: Awaited<ReturnType<typeof ComplianceService.form26asToExcel>>
  try {
    out = await ComplianceService.form26asToExcel(bytes, text)
  } catch (e) {
    if (e instanceof ToolError) throw ApiError.unprocessable(e.code, e.message)
    throw e
  }
  const sheet = (await sheets(out.bytes)).find((s) => s.name === 'Part A - TDS')
  const r = sheet ? fromTable(sheet.rows, '') : null
  if (!r?.entries.length) throw ApiError.unprocessable('no_tables', 'No Part A rows could be read from this 26AS.')
  // The converter's sheet has no TDS-deposited column: treat deducted as deposited.
  return { ...r, format: text ? 'text' : 'pdf', sourceFormat: text ? 'text' : 'excel' }
}

/** Books TDS register: Excel or CSV of party, TAN, section, amount, TDS (date, reference optional). */
export async function parseBooks(bytes: Buffer, filename: string): Promise<ParseResult & { sourceFormat: 'excel' }> {
  let tables: string[][][]
  if (isZip(bytes)) tables = (await sheets(bytes)).map((s) => s.rows)
  else if (/\.csv$/i.test(filename) || !bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) tables = [parseCsv(bytes.toString('utf8'))]
  else throw ApiError.unprocessable('unsupported_type', 'Upload the TDS register as .xlsx or .csv.')
  for (const t of tables) {
    const r = fromTable(t, '')
    if (r.found) {
      if (!r.entries.length) throw ApiError.unprocessable('empty', 'The register has a header but no usable rows.', { skipped: r.skipped.slice(0, 50) })
      return { ...r, format: 'excel', sourceFormat: 'excel' }
    }
  }
  throw ApiError.unprocessable('no_tables', 'No header row with party/TAN, section and TDS columns was found.')
}
