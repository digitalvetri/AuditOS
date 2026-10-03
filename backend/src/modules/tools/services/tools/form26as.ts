/**
 * FORM 26AS (and Tax Passbook, Form 168) → Excel.
 *
 * TRACES gives Part A as a caret-delimited text export or a PDF:
 *
 *   PART-I - Details of Tax Deducted at Source
 *   Sr. No.^Name of Deductor^TAN of Deductor^Total Amount Paid/Credited^Total Tax Deducted^Total TDS Deposited^
 *   1^ABC KNITWEAR PRIVATE LIMITED^CHEA12345B^710000.00^14200.00^14200.00^
 *   ^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks^Amount Paid / Credited^Tax Deducted^TDS Deposited^
 *   ^1^194C^08-Apr-2026^F^30-Jul-2026^-^220000.00^4400.00^4400.00^
 *   Total^^^2200000.00^54200.00^54200.00^
 *
 * A detail line carries THREE amounts — paid/credited, tax deducted, TDS
 * deposited. Columns are found by their header names (the passbook names
 * them differently), with the documented order as the fallback. Only Part A
 * is read: the taxpayer header above it is summary data, not a skipped row.
 *
 * Several files can be converted together; a file that cannot be read is
 * reported with its reason and the others still convert.
 */
import ExcelJS from 'exceljs'
import { ToolError } from '../errors.js'
import { PDFService } from './PDFService.js'

export const REASONS = {
  notTraces: 'Not a TRACES text export or PDF',
  password: 'PDF is password protected',
  scanned: 'PDF has no text layer (scanned)',
  noPartA: 'Part A not found',
} as const

export interface Txn {
  file: string
  deductor: string
  tan: string
  section: string
  txnDate: Date | null
  status: string
  bookingDate: Date | null
  remarks: string
  amountPaid: number
  taxDeducted: number
  tdsDeposited: number
}
export interface DeductorTotal { file: string; deductor: string; tan: string; amountPaid: number | null; taxDeducted: number | null; tdsDeposited: number | null }
export interface Skip { file: string; row: number; reason: string; text: string }
export interface FileResult { file: string; ok: boolean; reason: string | null; transactions: number }
interface Taxpayer { pan?: string; name?: string; fy?: string; ay?: string; created?: string }

const TAN_RE = /^[A-Z]{4}\d{5}[A-Z]$/
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** dd-Mon-yyyy (08-Apr-2026) or dd-mm-yyyy (also with / or .). */
export function parseDate26(raw: string): Date | null {
  const s = raw.trim()
  let m = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ](\d{4})$/)
  let d: number, mo: number, y: number
  if (m) {
    const idx = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase())
    if (idx < 0) return null
    ;[d, mo, y] = [+m[1], idx + 1, +m[3]]
  } else {
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/)
    if (!m) return null
    ;[d, mo, y] = [+m[1], +m[2], +m[3]]
  }
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCDate() === d && dt.getUTCMonth() === mo - 1 ? dt : null
}

/** Amounts: commas and spaces stripped. Null when not a number. */
export function parseAmount26(raw: string): number | null {
  // A rupee sign (or the box a PDF draws for a missing ₹ glyph) may lead.
  const s = raw.replace(/[,\s]/g, '').replace(/^[^\d-]+(?=\d)/, '')
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null
  return round2(Number(s))
}

// ── column maps by header name ───────────────────────────────────────────

type DeductorCols = { sr: number; name: number; tan: number; paid: number; tax: number; dep: number }
type DetailCols = { sr: number; section: number; txn: number; status: number; booking: number; remarks: number; paid: number; tax: number; dep: number }

const find = (h: string[], ...tests: ((n: string) => boolean)[]) => {
  for (const t of tests) { const i = h.findIndex((x) => t(norm(x))); if (i >= 0) return i }
  return -1
}

function deductorCols(h: string[]): DeductorCols | null {
  if (!h.some((x) => norm(x).startsWith('nameofdeductor'))) return null
  return {
    sr: find(h, (n) => n === 'srno' || n === 'sno' || n === 'srnos'),
    name: find(h, (n) => n.startsWith('nameofdeductor')),
    tan: find(h, (n) => n.startsWith('tanofdeductor') || n === 'tan'),
    paid: find(h, (n) => n.startsWith('totalamountpaid'), (n) => n.startsWith('amountpaid')),
    tax: find(h, (n) => n.startsWith('totaltaxdeducted'), (n) => n.startsWith('taxdeducted')),
    dep: find(h, (n) => n.startsWith('totaltdsdeposited'), (n) => n.startsWith('totaltdstcsdeposited'), (n) => n.startsWith('tdsdeposited'), (n) => n.startsWith('tdstcsdeposited')),
  }
}

function detailCols(h: string[]): DetailCols | null {
  if (!h.some((x) => norm(x) === 'transactiondate' || norm(x).startsWith('dateofpayment'))) return null
  return {
    sr: find(h, (n) => n === 'srno' || n === 'sno'),
    section: find(h, (n) => n === 'section' || n.startsWith('section')),
    txn: find(h, (n) => n === 'transactiondate', (n) => n.startsWith('dateofpayment')),
    status: find(h, (n) => n.startsWith('statusofbooking')),
    booking: find(h, (n) => n.startsWith('dateofbooking')),
    remarks: find(h, (n) => n.startsWith('remark')),
    paid: find(h, (n) => n.startsWith('amountpaid')),
    tax: find(h, (n) => n.startsWith('taxdeducted')),
    dep: find(h, (n) => n.startsWith('tdsdeposited'), (n) => n.startsWith('tdstcsdeposited')),
  }
}

// Documented order, used when a file has no header line.
const DEFAULT_DEDUCTOR: DeductorCols = { sr: 0, name: 1, tan: 2, paid: 3, tax: 4, dep: 5 }
const DEFAULT_DETAIL: DetailCols = { sr: 1, section: 2, txn: 3, status: 4, booking: 5, remarks: 6, paid: 7, tax: 8, dep: 9 }

// "PART-I - Details of Tax Deducted at Source", "Part A - …", "Part I — TDS Details".
const isPartA = (line: string) => /^\W*part\s*[-–—]?\s*(i|a)\b(?![\dI])/i.test(line) && /tax\s*deducted|\btds\b/i.test(line)
// Part A ends at the next part — A1 / A2 (15G/15H, 194IA…), II, B …
const isLaterPart = (line: string) => /^\W*part\s*[-–—]?\s*(a\s*\d|ii|iii|iv|v|vi|vii|viii|b|c|d|e|f|g|h)\b/i.test(line)

// ── text export ──────────────────────────────────────────────────────────

interface Parsed { txns: Txn[]; totals: DeductorTotal[]; fileTotal: { paid: number; tax: number; dep: number } | null; skips: Skip[]; taxpayer: Taxpayer }

function parseText(file: string, text: string): Parsed {
  const lines = text.split(/\r?\n/)
  const out: Parsed = { txns: [], totals: [], fileTotal: null, skips: [], taxpayer: {} }
  const start = lines.findIndex(isPartA)
  if (start < 0) throw new ToolError('no_tables', REASONS.noPartA)

  // Taxpayer header above Part A: a header line, then its values (often shifted by a leading ^).
  for (let i = 0; i < start; i++) {
    const h = lines[i].split('^').map((s) => s.trim())
    if (!h.some((x) => /permanentaccountnumber/.test(norm(x)))) continue
    const v = (lines[i + 1] ?? '').split('^').map((s) => s.trim())
    const shift = v[0] === '' && h[0] !== '' ? 1 : 0
    const at = (t: (n: string) => boolean) => { const k = h.findIndex((x) => t(norm(x))); return k >= 0 ? v[k + shift] ?? '' : '' }
    out.taxpayer = {
      pan: at((n) => n.startsWith('permanentaccountnumber')), name: at((n) => n.startsWith('nameofassessee')),
      fy: at((n) => n === 'financialyear'), ay: at((n) => n === 'assessmentyear'), created: at((n) => n === 'filecreationdate'),
    }
    break
  }

  let dCols: DeductorCols = DEFAULT_DEDUCTOR
  let tCols: DetailCols = DEFAULT_DETAIL
  let current: { deductor: string; tan: string } | null = null
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw.trim()) continue
    if (isLaterPart(raw)) break
    // Split on ^; blank trailing fields (and extra ^ at the end) dropped.
    const f = raw.split('^').map((s) => s.trim())
    while (f.length && f[f.length - 1] === '') f.pop()
    if (!f.length) continue
    const row = i + 1
    const dc = deductorCols(f); if (dc) { dCols = dc; continue }
    const tc = detailCols(f); if (tc) { tCols = tc; continue }

    if (/^(grand\s*)?total$/i.test(f[0])) {
      const n = (k: number) => (k >= 0 ? parseAmount26(f[k] ?? '') : null) ?? 0
      out.fileTotal = { paid: n(dCols.paid), tax: n(dCols.tax), dep: n(dCols.dep) }
      continue
    }
    // Deductor line: starts with its serial number (no leading ^) and names a TAN.
    if (f[0] !== '' && /^\d+$/.test(f[0])) {
      const tan = (f[dCols.tan] ?? '').toUpperCase()
      if (!TAN_RE.test(tan)) { out.skips.push({ file, row, reason: `Row ${row}: deductor line without a valid TAN ("${f[dCols.tan] ?? ''}")`, text: raw }); current = null; continue }
      current = { deductor: f[dCols.name] ?? '', tan }
      out.totals.push({ file, deductor: current.deductor, tan, amountPaid: parseAmount26(f[dCols.paid] ?? ''), taxDeducted: parseAmount26(f[dCols.tax] ?? ''), tdsDeposited: parseAmount26(f[dCols.dep] ?? '') })
      continue
    }
    // Detail line: starts with ^ and a serial number.
    if (f[0] === '' && /^\d+$/.test(f[tCols.sr] ?? '')) {
      const r = detail(f, tCols, row, raw, file, current)
      if ('reason' in r) out.skips.push(r)
      else out.txns.push(r)
    }
    // Anything else inside Part A (notes, blank separators) is not a transaction.
  }
  return out
}

function detail(f: string[], c: DetailCols, row: number, raw: string, file: string, current: { deductor: string; tan: string } | null): Txn | Skip {
  const skip = (reason: string): Skip => ({ file, row, reason: `Row ${row}: ${reason}`, text: raw })
  if (!current) return skip('transaction before any deductor line')
  const get = (k: number) => (k >= 0 ? f[k] ?? '' : '')
  const dateOf = (k: number, required: boolean): Date | null | Skip => {
    const v = get(k)
    if (!v || v === '-') return required ? skip(`unknown date format "${v}"`) : null
    return parseDate26(v) ?? skip(`unknown date format "${v}"`)
  }
  const txn = dateOf(c.txn, true); if (txn && 'reason' in txn) return txn
  const booking = dateOf(c.booking, false); if (booking && 'reason' in booking) return booking
  const amounts: number[] = []
  for (const k of [c.paid, c.tax, c.dep]) {
    const v = get(k)
    const n = parseAmount26(v)
    if (n === null) return skip(`amount is not a number "${v}"`)
    amounts.push(n)
  }
  const remarks = get(c.remarks)
  return {
    file, deductor: current.deductor, tan: current.tan, section: get(c.section), txnDate: txn as Date, status: get(c.status),
    bookingDate: booking as Date | null, remarks: remarks === '-' ? '' : remarks,
    amountPaid: amounts[0], taxDeducted: amounts[1], tdsDeposited: amounts[2],
  }
}

// ── PDF ──────────────────────────────────────────────────────────────────

async function parsePdf(file: string, bytes: Buffer): Promise<Parsed> {
  const doc = await PDFService.load(bytes).catch(() => null)
  if (!doc) throw new ToolError('unreadable', REASONS.notTraces)
  if (doc.isEncrypted) throw new ToolError('encrypted', REASONS.password)
  let pages
  try { pages = await PDFService.extractText(bytes) } catch { throw new ToolError('encrypted', REASONS.password) }
  if (!PDFService.hasTextLayer(pages)) throw new ToolError('no_text_layer', REASONS.scanned)

  const out: Parsed = { txns: [], totals: [], fileTotal: null, skips: [], taxpayer: {} }
  let inPartA = false
  let current: { deductor: string; tan: string } | null = null
  let row = 0
  const summary: { paid?: number; tax?: number; dep?: number } = {}
  for (const page of pages) {
    for (const line of page.lines) {
      row++
      const cells = line.cells.map((c) => c.text.trim()).filter((t) => t !== '')
      if (!cells.length) continue
      const joined = cells.join(' ')
      // A summary block ("Total Amount Paid/Credited  ₹2,20,000.00") anywhere in the file.
      const lastAmt = parseAmount26(cells[cells.length - 1])
      if (lastAmt !== null && cells.length <= 3 && !/name of deductor/i.test(joined)) {
        if (/^total amount paid/i.test(joined)) summary.paid = lastAmt
        else if (/^total tax deducted/i.test(joined)) summary.tax = lastAmt
        else if (/^total (tax|tds) deposited/i.test(joined)) summary.dep = lastAmt
      }
      if (!inPartA) {
        const pan = joined.match(/\b([A-Z]{5}\d{4}[A-Z])\b/)
        if (pan && /permanent account number|pan/i.test(joined) && !out.taxpayer.pan) out.taxpayer.pan = pan[1]
        if (isPartA(joined)) inPartA = true
        continue
      }
      if (isLaterPart(joined)) { inPartA = false; break }
      if (/name of deductor|transaction date/i.test(joined)) continue
      const where = `page ${page.page}`
      const amounts = cells.map(parseAmount26)
      const lastThree = () => cells.map((c, i) => [c, amounts[i]] as const).filter(([, n]) => n !== null).slice(-3).map(([, n]) => n as number)
      if (/^(grand\s*)?total\b/i.test(cells[0])) {
        const [p, t, d] = lastThree(); out.fileTotal = { paid: p ?? 0, tax: t ?? 0, dep: d ?? 0 }; continue
      }
      const tan = cells.find((c) => TAN_RE.test(c))
      // One line per transaction with its deductor on it (Sl.No, TAN, Name, Section, Date, amounts).
      if (tan && /^\d+$/.test(cells[0]) && cells.some((c) => parseDate26(c))) {
        const dates = cells.map(parseDate26)
        const di = dates.map((d, i) => (d ? i : -1)).filter((i) => i >= 0)
        const [p, t, d] = lastThree()
        if (p === undefined || t === undefined || d === undefined) { out.skips.push({ file, row, reason: `Row ${row} (${where}): amount is not a number — fewer than three amounts`, text: joined }); continue }
        const sectionAt = cells.findIndex((c, i) => i > 0 && /^\d{3}[A-Z]{0,3}$/.test(c) && c !== tan)
        const name = cells.filter((c, i) => i > 0 && c !== tan && i !== sectionAt && !dates[i] && amounts[i] === null && !/^[A-Z]$/.test(c) && c !== '-').join(' ')
        out.txns.push({
          file, deductor: name, tan, section: sectionAt >= 0 ? cells[sectionAt] : '', txnDate: dates[di[0]], status: cells.find((c) => /^[A-Z]$/.test(c)) ?? '',
          bookingDate: di.length > 1 ? dates[di[1]] : null, remarks: '', amountPaid: p, taxDeducted: t, tdsDeposited: d,
        })
        continue
      }
      if (tan && /^\d+$/.test(cells[0])) {
        const name = cells.slice(1, cells.indexOf(tan)).join(' ')
        const [p, t, d] = lastThree()
        current = { deductor: name, tan }
        out.totals.push({ file, deductor: name, tan, amountPaid: p ?? null, taxDeducted: t ?? null, tdsDeposited: d ?? null })
        continue
      }
      const dates = cells.map(parseDate26)
      if (/^\d+$/.test(cells[0]) && dates.some((d) => d)) {
        const amountsOnly = lastThree()
        if (!current) { out.skips.push({ file, row, reason: `Row ${row} (${where}): transaction before any deductor line`, text: joined }); continue }
        if (amountsOnly.length < 3) { out.skips.push({ file, row, reason: `Row ${row} (${where}): amount is not a number — fewer than three amounts`, text: joined }); continue }
        const di = dates.map((d, i) => (d ? i : -1)).filter((i) => i >= 0)
        const lastDateIdx = di[di.length - 1]
        const firstAmountIdx = cells.length - 3
        const middle = cells.slice(lastDateIdx + 1, firstAmountIdx).filter((c) => !/^[A-Z]$/.test(c))
        out.txns.push({
          file, deductor: current.deductor, tan: current.tan,
          section: cells.find((c) => /^\d{3}[A-Z]{0,3}(\(\w\))?$/.test(c) && c !== cells[0]) ?? '',
          txnDate: dates[di[0]], status: cells.find((c) => /^[A-Z]$/.test(c)) ?? '',
          bookingDate: di.length > 1 ? dates[di[1]] : null,
          remarks: middle.filter((c) => c !== '-').join(' '),
          amountPaid: amountsOnly[0], taxDeducted: amountsOnly[1], tdsDeposited: amountsOnly[2],
        })
      }
    }
  }
  if (!out.txns.length && !out.totals.length) throw new ToolError('no_tables', REASONS.noPartA)
  if (!out.fileTotal && summary.paid !== undefined) out.fileTotal = { paid: summary.paid, tax: summary.tax ?? 0, dep: summary.dep ?? summary.tax ?? 0 }
  return out
}

// ── one file ─────────────────────────────────────────────────────────────

/** Type from the bytes, not the name: %PDF → PDF; text with ^ fields → TRACES export. */
async function parseFile(name: string, bytes: Buffer): Promise<Parsed> {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return parsePdf(name, bytes)
  const sample = bytes.subarray(0, 4096)
  const binary = sample.some((b) => b === 0) || (sample[0] === 0x50 && sample[1] === 0x4b) // NUL bytes, or a zip (xlsx/docx)
  if (binary) throw new ToolError('unsupported_type', REASONS.notTraces)
  const text = bytes.toString('utf8').replace(/^﻿/, '')
  if (!text.includes('^')) throw new ToolError('unsupported_type', REASONS.notTraces)
  return parseText(name, text)
}

// ── workbook ─────────────────────────────────────────────────────────────

export interface Form26asResult {
  bytes: Buffer
  files: FileResult[]
  transactions: number
  deductors: number
  totals: { paid: number; tax: number; dep: number }
  skipped: Skip[]
  checks: { label: string; ok: boolean; detail: string }[]
}

export async function form26asToExcel(inputs: { name: string; bytes: Buffer }[]): Promise<Form26asResult> {
  const files: FileResult[] = []
  const parsed: Parsed[] = []
  for (const f of inputs) {
    try {
      const p = await parseFile(f.name, f.bytes)
      if (!p.txns.length && !p.skips.length) throw new ToolError('no_tables', `${REASONS.noPartA} — no transaction lines under it`)
      parsed.push(p)
      files.push({ file: f.name, ok: true, reason: null, transactions: p.txns.length })
    } catch (e) {
      files.push({ file: f.name, ok: false, reason: e instanceof ToolError ? e.message : REASONS.notTraces, transactions: 0 })
    }
  }
  if (!parsed.length) {
    throw new ToolError('no_tables', files.map((f) => `${f.file}: ${f.reason}`).join(' · '), { files })
  }
  const multi = inputs.length > 1
  const txns = parsed.flatMap((p) => p.txns)
  const totals = parsed.flatMap((p) => p.totals)
  const skipped = parsed.flatMap((p) => p.skips)
  const sum = (k: 'amountPaid' | 'taxDeducted' | 'tdsDeposited', list = txns) => round2(list.reduce((a, t) => a + t[k], 0))
  const grand = { paid: sum('amountPaid'), tax: sum('taxDeducted'), dep: sum('tdsDeposited') }

  // Checks: each deductor's transactions against its total line; all against the file's Total line.
  const checks: Form26asResult['checks'] = []
  for (const d of totals) {
    const mine = txns.filter((t) => t.file === d.file && t.tan === d.tan)
    for (const [k, label, fileVal] of [['amountPaid', 'amount paid', d.amountPaid], ['taxDeducted', 'tax deducted', d.taxDeducted], ['tdsDeposited', 'TDS deposited', d.tdsDeposited]] as const) {
      if (fileVal === null) continue
      const got = sum(k, mine)
      if (Math.abs(got - fileVal) > 0.005) checks.push({ label: `${d.deductor} (${d.tan})`, ok: false, detail: `${label}: transactions ${got.toFixed(2)} vs deductor total ${fileVal.toFixed(2)}` })
    }
  }
  for (const p of parsed) {
    if (!p.fileTotal) continue
    const file = p.txns[0]?.file ?? ''
    const got = { paid: sum('amountPaid', p.txns), tax: sum('taxDeducted', p.txns), dep: sum('tdsDeposited', p.txns) }
    const ok = Math.abs(got.paid - p.fileTotal.paid) < 0.005 && Math.abs(got.tax - p.fileTotal.tax) < 0.005 && Math.abs(got.dep - p.fileTotal.dep) < 0.005
    checks.push({ label: multi ? `${file} total` : 'File total', ok, detail: ok ? 'Transactions equal the file\'s Total line' : `transactions ${got.paid.toFixed(2)} / ${got.tax.toFixed(2)} / ${got.dep.toFixed(2)} vs Total line ${p.fileTotal.paid.toFixed(2)} / ${p.fileTotal.tax.toFixed(2)} / ${p.fileTotal.dep.toFixed(2)}` })
  }

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Audit OS'

  // Transactions
  const tx = wb.addWorksheet('Transactions')
  const cols = [
    { header: 'Deductor', key: 'deductor', width: 38 }, { header: 'TAN', key: 'tan', width: 13 }, { header: 'Section', key: 'section', width: 9 },
    { header: 'Transaction Date', key: 'txnDate', width: 15 }, { header: 'Status of Booking', key: 'status', width: 10 }, { header: 'Date of Booking', key: 'bookingDate', width: 15 },
    { header: 'Remarks', key: 'remarks', width: 14 }, { header: 'Amount Paid', key: 'amountPaid', width: 16 }, { header: 'Tax Deducted', key: 'taxDeducted', width: 14 },
    { header: 'TDS Deposited', key: 'tdsDeposited', width: 14 }, ...(multi ? [{ header: 'Source File', key: 'file', width: 30 }] : []),
  ]
  tx.columns = cols
  txns.forEach((t) => tx.addRow(t))
  tx.getColumn('tan').numFmt = '@'
  for (const k of ['txnDate', 'bookingDate']) tx.getColumn(k).numFmt = 'dd-mm-yyyy'
  for (const k of ['amountPaid', 'taxDeducted', 'tdsDeposited']) tx.getColumn(k).numFmt = '#,##0.00'
  tx.getRow(1).font = { bold: true }
  tx.views = [{ state: 'frozen', ySplit: 1 }]
  const last = Math.max(2, txns.length + 1)
  const rng = (col: string) => `Transactions!$${col}$2:$${col}$${last}`

  // Deductor Totals — SUMIFS over Transactions, beside the totals the file states.
  const dt = wb.addWorksheet('Deductor Totals')
  dt.columns = [
    { header: 'Deductor', key: 'd', width: 38 }, { header: 'TAN', key: 'tan', width: 13 }, { header: 'Entries', key: 'n', width: 9 },
    { header: 'Amount Paid', key: 'p', width: 16 }, { header: 'Tax Deducted', key: 't', width: 14 }, { header: 'TDS Deposited', key: 'x', width: 14 },
    { header: 'File: Amount Paid', key: 'fp', width: 17 }, { header: 'File: Tax Deducted', key: 'ft', width: 17 }, { header: 'File: TDS Deposited', key: 'fx', width: 18 },
    { header: 'Check', key: 'c', width: 12 }, ...(multi ? [{ header: 'Source File', key: 'file', width: 30 }] : []),
  ]
  dt.getColumn('tan').numFmt = '@'
  // One row per deductor of each file (a TAN with no total line still gets a row).
  const keys = new Map<string, DeductorTotal>()
  for (const d of totals) keys.set(`${d.file}|${d.tan}`, d)
  for (const t of txns) if (!keys.has(`${t.file}|${t.tan}`)) keys.set(`${t.file}|${t.tan}`, { file: t.file, deductor: t.deductor, tan: t.tan, amountPaid: null, taxDeducted: null, tdsDeposited: null })
  const fileCol = multi ? 'K' : null
  let r = 2
  for (const d of keys.values()) {
    const crit = `${rng('B')},$B${r}${fileCol ? `,${rng(fileCol)},$K${r}` : ''}`
    const mine = txns.filter((t) => t.file === d.file && t.tan === d.tan)
    const row = dt.addRow({ d: d.deductor, tan: d.tan, fp: d.amountPaid, ft: d.taxDeducted, fx: d.tdsDeposited, ...(multi ? { file: d.file } : {}) })
    row.getCell(3).value = { formula: `COUNTIFS(${crit})`, result: mine.length }
    row.getCell(4).value = { formula: `SUMIFS(${rng('H')},${crit})`, result: sum('amountPaid', mine) }
    row.getCell(5).value = { formula: `SUMIFS(${rng('I')},${crit})`, result: sum('taxDeducted', mine) }
    row.getCell(6).value = { formula: `SUMIFS(${rng('J')},${crit})`, result: sum('tdsDeposited', mine) }
    const okRow = d.amountPaid === null || (Math.abs(sum('amountPaid', mine) - (d.amountPaid ?? 0)) < 0.005 && Math.abs(sum('taxDeducted', mine) - (d.taxDeducted ?? 0)) < 0.005 && Math.abs(sum('tdsDeposited', mine) - (d.tdsDeposited ?? 0)) < 0.005)
    row.getCell(10).value = d.amountPaid === null ? 'No total line'
      : { formula: `IF(AND(ABS(D${r}-G${r})<0.01,ABS(E${r}-H${r})<0.01,ABS(F${r}-I${r})<0.01),"OK","MISMATCH")`, result: okRow ? 'OK' : 'MISMATCH' }
    r++
  }
  const totalRow = dt.addRow({ d: 'Total' })
  for (const [i, c] of ['C', 'D', 'E', 'F', 'G', 'H', 'I'].entries()) {
    const vals = [txns.length, grand.paid, grand.tax, grand.dep,
      round2(totals.reduce((a, t) => a + (t.amountPaid ?? 0), 0)), round2(totals.reduce((a, t) => a + (t.taxDeducted ?? 0), 0)), round2(totals.reduce((a, t) => a + (t.tdsDeposited ?? 0), 0))]
    totalRow.getCell(3 + i).value = { formula: `SUM(${c}2:${c}${r - 1})`, result: vals[i] }
  }
  totalRow.font = { bold: true }
  const fileTotal = parsed.reduce<{ paid: number; tax: number; dep: number } | null>((a, p) => (p.fileTotal ? { paid: (a?.paid ?? 0) + p.fileTotal.paid, tax: (a?.tax ?? 0) + p.fileTotal.tax, dep: (a?.dep ?? 0) + p.fileTotal.dep } : a), null)
  if (fileTotal) {
    const ft = dt.addRow({ d: 'Total line in the file', fp: round2(fileTotal.paid), ft: round2(fileTotal.tax), fx: round2(fileTotal.dep) })
    const tr = totalRow.number; const fr = ft.number
    const okAll = checks.filter((c) => /total$/i.test(c.label) || c.label === 'File total').every((c) => c.ok)
    ft.getCell(10).value = { formula: `IF(AND(ABS(D${tr}-G${fr})<0.01,ABS(E${tr}-H${fr})<0.01,ABS(F${tr}-I${fr})<0.01),"OK","MISMATCH")`, result: okAll ? 'OK' : 'MISMATCH' }
    ft.getCell(4).value = { formula: `D${tr}`, result: grand.paid }
    ft.getCell(5).value = { formula: `E${tr}`, result: grand.tax }
    ft.getCell(6).value = { formula: `F${tr}`, result: grand.dep }
    ft.font = { italic: true }
  }
  for (let c = 3; c <= 9; c++) dt.getColumn(c).numFmt = c === 3 ? '0' : '#,##0.00'
  dt.getRow(1).font = { bold: true }
  dt.views = [{ state: 'frozen', ySplit: 1 }]

  // Summary: the taxpayer, PAN as text.
  const tp = parsed.find((p) => p.taxpayer.pan)?.taxpayer ?? {}
  const sm = wb.addWorksheet('Summary')
  sm.columns = [{ header: 'Field', key: 'k', width: 28 }, { header: 'Value', key: 'v', width: 44 }]
  sm.getColumn(2).numFmt = '@'
  for (const [k, v] of [['PAN', tp.pan], ['Name of Assessee', tp.name], ['Financial Year', tp.fy], ['Assessment Year', tp.ay], ['File Creation Date', tp.created]] as const) {
    if (v) sm.addRow({ k, v })
  }
  sm.addRow({ k: 'Transactions', v: String(txns.length) })
  sm.addRow({ k: 'Deductors', v: String(new Set(txns.map((t) => `${t.file}|${t.tan}`)).size) })
  sm.addRow({ k: 'Amount Paid', v: grand.paid.toFixed(2) })
  sm.addRow({ k: 'Tax Deducted', v: grand.tax.toFixed(2) })
  sm.addRow({ k: 'TDS Deposited', v: grand.dep.toFixed(2) })
  sm.addRow({ k: 'Check', v: checks.every((c) => c.ok) ? 'OK — transactions equal the totals in the file' : `MISMATCH — ${checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`).join('; ')}` })
  sm.getRow(1).font = { bold: true }

  // Skipped: only Part A lines that looked like transactions but failed.
  const sk = wb.addWorksheet('Skipped')
  sk.columns = [...(multi ? [{ header: 'File', key: 'file', width: 30 }] : []), { header: 'Row', key: 'row', width: 8 }, { header: 'Reason', key: 'reason', width: 60 }, { header: 'Line', key: 'text', width: 80 }]
  skipped.forEach((s) => sk.addRow(s))
  sk.getRow(1).font = { bold: true }

  if (multi || files.some((f) => !f.ok)) {
    const fs = wb.addWorksheet('Files')
    fs.columns = [{ header: 'File', key: 'file', width: 40 }, { header: 'Status', key: 'status', width: 12 }, { header: 'Transactions', key: 'transactions', width: 13 }, { header: 'Reason', key: 'reason', width: 50 }]
    files.forEach((f) => fs.addRow({ ...f, status: f.ok ? 'Converted' : 'Not converted', reason: f.reason ?? '' }))
    fs.getRow(1).font = { bold: true }
  }

  return {
    bytes: Buffer.from(await wb.xlsx.writeBuffer()), files, transactions: txns.length,
    deductors: new Set(txns.map((t) => `${t.file}|${t.tan}`)).size, totals: grand, skipped, checks,
  }
}
