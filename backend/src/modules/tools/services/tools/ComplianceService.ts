/**
 * COMPLIANCE CONVERTERS — the six tools in Finance & Compliance.
 *
 * Each one is a pure function over bytes: it parses an input the firm
 * already has, and emits the shape a portal or Tally will accept. They share
 * three rules, learned from the converters that shipped before them:
 *
 *  - **Never invent a value.** A column the sheet did not supply is left
 *    empty, not defaulted to zero. Silent zeros in a TDS or GST file are
 *    worse than a refusal.
 *  - **Say what was skipped.** Every converter returns the rows it could not
 *    read alongside the ones it could, and the runner surfaces that as a
 *    warning on an otherwise completed job (§13 honest partial results).
 *  - **Header names are matched loosely** — case, spaces and punctuation are
 *    ignored — because these sheets are typed by hand at a dozen firms and
 *    "Invoice No.", "invoice_no" and "INVOICE NUMBER" are the same column.
 */
import ExcelJS from 'exceljs'
import { ToolError } from '../errors.js'
import { PDFService, type PageText, type TextSpan } from './PDFService.js'
import * as F140 from './tds-form140.js'

// ── Shared helpers ───────────────────────────────────────────────────────

/** Loose header key: lower-case, letters and digits only. */
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

const cellText = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return isoDate(v)
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>
    if ('text' in o) return String(o.text ?? '')
    if ('result' in o) return String(o.result ?? '')
    if ('richText' in o) return (o.richText as { text: string }[]).map((r) => r.text).join('')
    return ''
  }
  return String(v)
}

const isoDate = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`

/**
 * Indian compliance files date as dd/mm/yyyy, so an ambiguous 03/04/2026 is
 * 3 April, never 4 March. Returned as dd/mm/yyyy — the format every portal
 * and Tally expects on the way back out.
 */
function parseDate(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/)
  if (m) {
    const [, d, mo, y] = m
    const year = y.length === 2 ? Number(y) + 2000 : Number(y)
    if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null
    return `${d.padStart(2, '0')}/${mo.padStart(2, '0')}/${year}`
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[3]}/${m[2]}/${m[1]}`
  // "05-Apr-2026" / "5 April 26"
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2,4})$/)
  if (m) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    const idx = months.indexOf(m[2].slice(0, 3).toLowerCase())
    if (idx < 0) return null
    const year = m[3].length === 2 ? Number(m[3]) + 2000 : Number(m[3])
    return `${m[1].padStart(2, '0')}/${String(idx + 1).padStart(2, '0')}/${year}`
  }
  return null
}

/** `1,23,456.78` / `(1234.00)` / `1234 Cr` → number. Null when not a number. */
function parseAmount(raw: string): number | null {
  let s = raw.trim().replace(/[₹,\s]/g, '')
  if (!s) return null
  let sign = 1
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1) }
  s = s.replace(/(cr|dr)$/i, '')
  if (!/^-?\d*\.?\d+$/.test(s)) return null
  const n = Number(s) * sign
  return Number.isFinite(n) ? n : null
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Read the first worksheet into header-keyed rows, keeping the raw labels. */
interface SheetRows {
  headers: string[]
  /** norm(header) → column index */
  index: Map<string, number>
  rows: string[][]
  /** The worksheet row number of each entry in `rows`, for messages. */
  rowNos: number[]
  sheetName: string
}

async function readSheet(bytes: Buffer, sheetName?: string): Promise<SheetRows> {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer)
  } catch {
    throw new ToolError('unreadable', "We couldn't open this spreadsheet. It may be corrupted or not a real Excel file.")
  }
  const ws = (sheetName ? wb.getWorksheet(sheetName) : undefined) ?? wb.worksheets[0]
  if (!ws) throw new ToolError('empty', 'This workbook has no sheets.')

  const matrix: string[][] = []
  const numbers: number[] = []
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    numbers.push(rowNumber)
    const vals: string[] = []
    row.eachCell({ includeEmpty: true }, (cell, col) => { vals[col - 1] = cellText(cell.value).trim() })
    for (let i = 0; i < vals.length; i++) vals[i] ??= ''
    matrix.push(vals)
  })
  // The header is the first row carrying two or more non-empty labels —
  // these sheets often open with a title row and a blank line.
  const headerAt = matrix.findIndex((r) => r.filter((c) => c !== '').length >= 2)
  if (headerAt < 0) throw new ToolError('empty', 'This sheet has no header row we could read.')

  const headers = matrix[headerAt].map((h) => h.trim())
  const index = new Map<string, number>()
  headers.forEach((h, i) => { if (h && !index.has(norm(h))) index.set(norm(h), i) })
  const keep = matrix.map((r, i) => i > headerAt && r.some((c) => c !== ''))
  const rows = matrix.filter((_, i) => keep[i])
  const rowNos = numbers.filter((_, i) => keep[i])
  if (rows.length === 0) throw new ToolError('empty', 'This sheet has a header but no data rows.')
  return { headers, index, rows, rowNos, sheetName: ws.name }
}

/** First header present from `names`, else -1. */
function col(s: SheetRows, ...names: string[]): number {
  for (const n of names) {
    const i = s.index.get(norm(n))
    if (i !== undefined) return i
  }
  return -1
}

function requireCols(s: SheetRows, wanted: Record<string, string[]>): Record<string, number> {
  const out: Record<string, number> = {}
  const missing: string[] = []
  for (const [key, names] of Object.entries(wanted)) {
    const i = col(s, ...names)
    if (i < 0) missing.push(names[0])
    out[key] = i
  }
  if (missing.length) {
    throw new ToolError('invalid_options',
      `This sheet is missing ${missing.length === 1 ? 'a required column' : 'required columns'}: ${missing.join(', ')}. Found: ${s.headers.filter(Boolean).join(', ') || '(none)'}.`,
      { missing, found: s.headers.filter(Boolean) })
  }
  return out
}

const at = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '')

function autoWidth(ws: ExcelJS.Worksheet) {
  ws.columns.forEach((c) => {
    let w = String(c.header ?? '').length + 2
    c.eachCell?.({ includeEmpty: false }, (cell) => { w = Math.max(w, Math.min(60, cellText(cell.value).length + 2)) })
    c.width = Math.max(10, w)
  })
  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
}

function newBook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Audit OS'
  wb.created = new Date()
  return wb
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export interface SkipNote { row: number; reason: string }

/** One sentence naming what was dropped, for RunOutput.warning. */
function skipWarning(skipped: SkipNote[], kept: number, noun: string): string | undefined {
  if (skipped.length === 0) return undefined
  const sample = skipped.slice(0, 3).map((s) => `row ${s.row} (${s.reason})`).join(', ')
  return `${kept} ${noun} converted. ${skipped.length} ${skipped.length === 1 ? 'row was' : 'rows were'} skipped and listed on the Skipped sheet — ${sample}${skipped.length > 3 ? ', …' : ''}.`
}

function addSkippedSheet(wb: ExcelJS.Workbook, skipped: SkipNote[]) {
  if (skipped.length === 0) return
  const ws = wb.addWorksheet('Skipped')
  ws.columns = [
    { header: 'Source row', key: 'row', width: 12 },
    { header: 'Why it was skipped', key: 'reason', width: 70 },
  ]
  skipped.forEach((s) => ws.addRow({ row: s.row, reason: s.reason }))
  autoWidth(ws)
}

// ── 1. GST JSON ⇄ Excel ──────────────────────────────────────────────────

/**
 * GSTR-1 sections as the offline tool's JSON nests them. GSTN publishes no
 * formal JSON schema; the shapes and key names here follow the portal /
 * offline-tool export (cross-checked against a community schema built by
 * validating against the portal). Each section is a list of levels — e.g.
 * B2B is recipient → invoice → item — and becomes one sheet with the outer
 * levels repeated down the item rows. The same table rebuilds the JSON,
 * regrouping rows whose outer fields match.
 *
 *   kind  num   → a number in Excel and in JSON (amounts, rates, counts)
 *         text  → a string; codes like "33" or "KT/001" never become numbers
 *         date  → "dd-mm-yyyy" text; a real Excel date is converted back
 *         state → two-digit state code, "7" → "07"
 *         hsn   → digits, a dropped leading zero restored ("402" → "0402")
 */
type GstKind = 'num' | 'text' | 'date' | 'state' | 'hsn'
interface GstField { key: string; header: string; kind: GstKind }
interface GstLevel { fields: GstField[]; child?: string; wrap?: 'itm_det' }
interface GstSection { key: string; label: string; container?: string; tables?: string[]; levels: GstLevel[] }

const F = (key: string, header: string, kind: GstKind = 'text'): GstField => ({ key, header, kind })
const TAX_ITEM: GstField[] = [F('rt', 'Rate', 'num'), F('txval', 'Taxable Value', 'num'), F('iamt', 'IGST', 'num'), F('camt', 'CGST', 'num'), F('samt', 'SGST', 'num'), F('csamt', 'Cess', 'num')]
const ITEM_NUM = F('num', 'Item No', 'num')
const WRAPPED_ITEMS: GstLevel = { fields: [ITEM_NUM, ...TAX_ITEM], wrap: 'itm_det' }

const GST_SECTIONS: GstSection[] = [
  { key: 'b2b', label: 'B2B', levels: [
    { fields: [F('ctin', 'Recipient GSTIN')], child: 'inv' },
    { fields: [F('inum', 'Invoice No'), F('idt', 'Invoice Date', 'date'), F('val', 'Invoice Value', 'num'), F('pos', 'Place of Supply', 'state'),
      F('rchrg', 'Reverse Charge'), F('inv_typ', 'Invoice Type'), F('etin', 'E-commerce GSTIN'), F('diff_percent', 'Applicable % of Tax Rate', 'num')], child: 'itms' },
    WRAPPED_ITEMS,
  ] },
  { key: 'b2cl', label: 'B2CL', levels: [
    { fields: [F('pos', 'Place of Supply', 'state')], child: 'inv' },
    { fields: [F('inum', 'Invoice No'), F('idt', 'Invoice Date', 'date'), F('val', 'Invoice Value', 'num'), F('etin', 'E-commerce GSTIN'),
      F('diff_percent', 'Applicable % of Tax Rate', 'num'), F('rchrg', 'Reverse Charge'), F('inv_typ', 'Invoice Type')], child: 'itms' },
    WRAPPED_ITEMS,
  ] },
  // b2cs carries no invoice wrapper — each entry IS a rate line.
  { key: 'b2cs', label: 'B2CS', levels: [
    { fields: [F('sply_ty', 'Supply Type'), F('pos', 'Place of Supply', 'state'), F('typ', 'Type'), F('etin', 'E-commerce GSTIN'),
      F('diff_percent', 'Applicable % of Tax Rate', 'num'), ...TAX_ITEM] },
  ] },
  { key: 'cdnr', label: 'CDNR', levels: [
    { fields: [F('ctin', 'Recipient GSTIN')], child: 'nt' },
    { fields: [F('ntty', 'Note Type'), F('nt_num', 'Note No'), F('nt_dt', 'Note Date', 'date'), F('val', 'Note Value', 'num'), F('pos', 'Place of Supply', 'state'),
      F('rchrg', 'Reverse Charge'), F('inv_typ', 'Invoice Type'), F('diff_percent', 'Applicable % of Tax Rate', 'num')], child: 'itms' },
    WRAPPED_ITEMS,
  ] },
  // cdnur is a flat list of notes, each with its unregistered-type `typ`.
  { key: 'cdnur', label: 'CDNUR', levels: [
    { fields: [F('typ', 'UR Type'), F('ntty', 'Note Type'), F('nt_num', 'Note No'), F('nt_dt', 'Note Date', 'date'), F('val', 'Note Value', 'num'),
      F('pos', 'Place of Supply', 'state'), F('diff_percent', 'Applicable % of Tax Rate', 'num')], child: 'itms' },
    WRAPPED_ITEMS,
  ] },
  // Export items are NOT wrapped in itm_det.
  { key: 'exp', label: 'EXP', levels: [
    { fields: [F('exp_typ', 'Export Type')], child: 'inv' },
    { fields: [F('inum', 'Invoice No'), F('idt', 'Invoice Date', 'date'), F('val', 'Invoice Value', 'num'), F('sbpcode', 'Shipping Bill Port Code'),
      F('sbnum', 'Shipping Bill No'), F('sbdt', 'Shipping Bill Date', 'date'), F('diff_percent', 'Applicable % of Tax Rate', 'num')], child: 'itms' },
    { fields: [F('num', 'Item No', 'num'), F('rt', 'Rate', 'num'), F('txval', 'Taxable Value', 'num'), F('iamt', 'IGST', 'num'), F('csamt', 'Cess', 'num')] },
  ] },
  // Table 12 — split into hsn_b2b / hsn_b2c on current returns, `data` on older ones.
  { key: 'hsn', label: 'HSN', tables: ['hsn_b2b', 'hsn_b2c', 'data'], levels: [
    { fields: [F('num', 'Line No', 'num'), F('hsn_sc', 'HSN', 'hsn'), F('desc', 'Description'), F('user_desc', 'User Description'), F('uqc', 'UQC'),
      F('qty', 'Quantity', 'num'), F('rt', 'Rate', 'num'), F('txval', 'Taxable Value', 'num'), F('iamt', 'IGST', 'num'), F('camt', 'CGST', 'num'),
      F('samt', 'SGST', 'num'), F('csamt', 'Cess', 'num'), F('val', 'Total Value', 'num')] },
  ] },
  // Table 13 — documents issued.
  { key: 'doc_issue', label: 'DOCS', container: 'doc_det', levels: [
    { fields: [F('doc_num', 'Document Type No', 'num'), F('doc_typ', 'Document Type')], child: 'docs' },
    { fields: [F('num', 'Line No', 'num'), F('from', 'Sr. No. From'), F('to', 'Sr. No. To'), F('totnum', 'Total Number', 'num'),
      F('cancel', 'Cancelled', 'num'), F('net_issue', 'Net Issued', 'num')] },
  ] },
  // Table 8 — nil rated, exempted and non-GST supplies.
  { key: 'nil', label: 'NIL', container: 'inv', levels: [
    { fields: [F('sply_ty', 'Supply Type'), F('nil_amt', 'Nil Rated', 'num'), F('expt_amt', 'Exempted', 'num'), F('ngsup_amt', 'Non-GST', 'num')] },
  ] },
]

const GST_TOP_LEVEL = new Set(['gstin', 'fp', 'version', 'hash', 'gt', 'cur_gt', 'filing_typ', ...GST_SECTIONS.map((s) => s.key)])
const TABLE_HEADER = 'Table'

/** Excel/JSON value → the JSON value for a field, or undefined when blank. */
function gstValue(kind: GstKind, raw: string): string | number | undefined {
  const v = raw.trim()
  if (v === '') return undefined
  switch (kind) {
    case 'num': { const n = parseAmount(v); return n === null ? v : n }
    case 'date': {
      // A date re-entered in a text-formatted cell can come back as its Excel serial.
      if (/^\d{5}(\.\d+)?$/.test(v)) return isoDate(new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(v)) * 86_400_000)).split('-').reverse().join('-')
      const d = parseDate(v); return d ? d.replace(/\//g, '-') : v
    }
    case 'state': return /^\d{1,2}$/.test(v) ? v.padStart(2, '0') : v
    case 'hsn': return /^\d+$/.test(v) && v.length % 2 === 1 ? `0${v}` : v
    default: return v
  }
}

/** One section's JSON → flat rows (one per leaf), keyed by header. */
function gstFlatten(sec: GstSection, nodes: Record<string, unknown>[]): { rows: Record<string, unknown>[]; docs: number } {
  const rows: Record<string, unknown>[] = []
  let docs = 0
  const walk = (list: Record<string, unknown>[], depth: number, acc: Record<string, unknown>) => {
    const lv = sec.levels[depth]
    for (const node of list) {
      if (depth === Math.min(1, sec.levels.length - 1)) docs++
      const row = { ...acc }
      const src = lv.wrap ? { ...(node[lv.wrap] as Record<string, unknown> ?? {}), num: node.num } : node
      for (const f of lv.fields) {
        const v = src[f.key]
        if (v === undefined || v === null || v === '') continue
        row[f.header] = f.kind === 'num' && typeof v === 'number' ? v : f.kind === 'num' ? (parseAmount(String(v)) ?? String(v)) : String(v)
      }
      const kids = lv.child ? node[lv.child] : undefined
      if (lv.child && Array.isArray(kids) && kids.length) walk(kids as Record<string, unknown>[], depth + 1, row)
      else rows.push(row)
    }
  }
  walk(nodes, 0, {})
  return { rows, docs }
}

/** Flat sheet rows → the section's nested JSON list. */
function gstNest(sec: GstSection, sheet: SheetRows): { list: Record<string, unknown>[]; docs: number } {
  const root: Record<string, unknown>[] = []
  const index = new Map<string, Record<string, unknown>>()
  let docs = 0
  sheet.rows.forEach((r) => {
    let parentList = root
    let path = ''
    sec.levels.forEach((lv, depth) => {
      const obj: Record<string, unknown> = {}
      for (const f of lv.fields) {
        const v = gstValue(f.kind, at(r, col(sheet, f.header, f.key)))
        if (v !== undefined) obj[f.key] = v
      }
      const leaf = depth === sec.levels.length - 1
      if (leaf) {
        let node: Record<string, unknown> = obj
        if (lv.wrap) {
          const { num, ...det } = obj
          node = { num: num ?? parentList.length + 1, [lv.wrap]: det }
        }
        parentList.push(node)
        if (depth === Math.min(1, sec.levels.length - 1)) docs++
        return
      }
      path += '|' + JSON.stringify(obj)
      let node = index.get(path)
      if (!node) {
        node = { ...obj, [lv.child!]: [] }
        index.set(path, node)
        parentList.push(node)
        if (depth === 1) docs++
      }
      parentList = node[lv.child!] as Record<string, unknown>[]
    })
  })
  return { list: root, docs }
}

// ── Form 140 deductor details ────────────────────────────────────────────

/** Deductor and responsible-person details for the Form 140 batch header. */
export interface TdsStatementOptions {
  quarter?: string; fy?: string
  tan?: string; pan?: string; name?: string; type?: string; gstin?: string
  address?: string[]; state?: string; pincode?: string; email?: string; phone?: string
  rpName?: string; rpDesignation?: string; rpPan?: string
  rpAddress?: string[]; rpState?: string; rpPincode?: string; rpEmail?: string; rpPhone?: string
  filedEarlier?: boolean; previousToken?: string
}

/** Today's date in India, at UTC midnight — the FVU's "no future date" line. */
function istToday(): Date {
  const t = new Date(Date.now() + 330 * 60_000)
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()))
}

/** Date (UTC) → "dd/mm/yyyy". */
const fmtDmy = (t: Date) =>
  `${String(t.getUTCDate()).padStart(2, '0')}/${String(t.getUTCMonth() + 1).padStart(2, '0')}/${t.getUTCFullYear()}`

/** A state as the spec's two-digit code, from a code or a name. */
function stateCode(v: string): string {
  const s = v.trim().toUpperCase()
  if (/^\d{1,2}$/.test(s)) { const c = s.padStart(2, '0'); return F140.STATE_CODE_VALUES.has(c) ? c : '' }
  return F140.STATE_CODES[s.replace(/\s+AND\s+/g, ' AND ')] ?? ''
}

/**
 * Every batch-header field the spec marks mandatory, checked up front and
 * reported together — a missing email is found before the sheet is read,
 * not after the FVU rejects the file.
 */
function checkDeductor(o: TdsStatementOptions) {
  const problems: string[] = []
  const need = (ok: boolean, msg: string) => { if (!ok) problems.push(msg) }
  const PAN = /^[A-Z]{5}\d{4}[A-Z]$/
  const EMAIL = /^[^\s@^]+@[^\s@^]+\.[^\s@^]+$/
  const addr = (a: string[] | undefined) => Array.from({ length: 5 }, (_, i) => F140.text(a?.[i] ?? '', 25))
  const digits = (v: string | undefined) => (v ?? '').replace(/\D/g, '')

  const quarter = (o.quarter ?? '').toUpperCase()
  need(/^Q[1-4]$/.test(quarter), 'Choose a quarter.')
  const fy = (o.fy ?? '').trim().match(/^(\d{4})-(\d{2}|\d{4})$/)
  const startYear = fy ? Number(fy[1]) : 0
  need(!!fy, 'Write the tax year as 2026-27.')
  if (fy && startYear < 2026) {
    problems.push(`Form 140 starts with tax year 2026-27. For ${fy[0]} and earlier, the return is Form 26Q — prepare it in NSDL's RPU 6.0.`)
  }

  const tan = (o.tan ?? '').trim().toUpperCase()
  need(/^[A-Z]{4}\d{5}[A-Z]$/.test(tan), 'Deductor TAN must be 4 letters, 5 digits and a letter.')
  const pan = (o.pan ?? '').trim().toUpperCase()
  need(PAN.test(pan) || pan === 'PANNOTREQD', 'Deductor PAN must be a valid PAN (or PANNOTREQD).')
  const name = F140.text(o.name ?? '', 75)
  need(/[A-Za-z0-9]/.test(name), 'Deductor name is required, exactly as registered with TRACES.')
  const type = (o.type ?? '').trim().toUpperCase()
  need(type in F140.DEDUCTOR_TYPES, 'Choose the deductor type.')
  const gstin = (o.gstin ?? '').trim().toUpperCase()
  need(!gstin || /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(gstin), 'Deductor GSTIN is not a valid GSTIN.')

  const address = addr(o.address)
  need(/[A-Za-z0-9]/.test(address[0]), 'Deductor address line 1 (flat / door / block) is required.')
  const state = stateCode(o.state ?? '')
  need(!!state, 'Choose the deductor\'s state.')
  const pincode = digits(o.pincode)
  need(/^[1-9]\d{5}$/.test(pincode), 'Deductor PIN code must be 6 digits.')
  const email = (o.email ?? '').trim()
  need(EMAIL.test(email), 'Deductor email is not a valid email address.')
  const phone = digits(o.phone).replace(/^(91|0)(?=\d{10}$)/, '')
  need(/^\d{10}$/.test(phone), 'Deductor contact number must be 10 digits.')

  const rpName = F140.text(o.rpName ?? '', 75)
  need(/[A-Za-z]/.test(rpName), 'Name of the person responsible is required.')
  const rpDesignation = F140.text(o.rpDesignation ?? '', 20)
  need(/[A-Za-z]/.test(rpDesignation), 'Designation of the person responsible is required.')
  const rpPan = (o.rpPan ?? '').trim().toUpperCase()
  need(PAN.test(rpPan), 'PAN of the person responsible must be a valid PAN.')
  const rpAddress = addr(o.rpAddress)
  need(/[A-Za-z0-9]/.test(rpAddress[0]), 'Responsible person\'s address line 1 is required.')
  const rpState = stateCode(o.rpState ?? '')
  need(!!rpState, 'Choose the responsible person\'s state.')
  const rpPincode = digits(o.rpPincode)
  need(/^[1-9]\d{5}$/.test(rpPincode), 'Responsible person\'s PIN code must be 6 digits.')
  const rpEmail = (o.rpEmail ?? '').trim()
  need(EMAIL.test(rpEmail), 'Responsible person\'s email is not a valid email address.')
  const rpPhone = digits(o.rpPhone).replace(/^(91|0)(?=\d{10}$)/, '')
  need(/^\d{10}$/.test(rpPhone), 'Responsible person\'s contact number must be 10 digits.')

  const filedEarlier = !!o.filedEarlier
  const previousToken = digits(o.previousToken)
  need(!filedEarlier || /^\d{15}$/.test(previousToken), 'Give the 15-digit token number of the previous regular Form 140 statement.')

  if (problems.length) {
    throw new ToolError('invalid_options', problems.join(' '), { problems })
  }
  const ay = `${startYear + 1}${String(startYear + 2).slice(2)}`
  return {
    quarter, startYear, fyLabel: `${startYear}-${String(startYear + 1).slice(2)}`,
    ty: `${startYear}${String(startYear + 1).slice(2)}`, ay,
    tan, pan, name, type, gstin, address, state, pincode, email, phone, phoneCc: 91, country: 'INDIA',
    rpName, rpDesignation, rpPan, rpAddress, rpState, rpPincode, rpEmail, rpPhone, rpPhoneCc: 91, rpCountry: 'INDIA',
    filedEarlier, previousToken: filedEarlier ? previousToken : '',
  }
}

// ── Bank statement helpers ──────────────────────────────────────────────

interface BankPiece { text: string; x0: number; x1: number; money: number | null; mark: 'dr' | 'cr' | null; marker: boolean }

const BANK_MONEY = /^\(?-?(?:\d{1,3}(?:,\d{2,3})*|\d+)\.\d{2}\)?$/

/**
 * A line's cells as pieces. A cell that is nothing but amounts and Cr/Dr
 * markers ("20,000.00 1,00,000.00", "10,000.00 Dr") is split, because
 * tightly printed columns arrive as one span; each piece gets a share of the
 * cell's width so its right edge still says which column it sits in.
 */
function bankPieces(cells: { text: string; x0: number; x1: number }[]): BankPiece[] {
  const out: BankPiece[] = []
  for (const c of cells) {
    const text = c.text.replace(/₹/g, '').trim()
    if (!text) continue
    const words = text.split(/\s+/)
    const isMoney = (w: string) => BANK_MONEY.test(w.replace(/(cr|dr)$/i, ''))
    const isMarker = (w: string) => /^(cr|dr)\.?$/i.test(w)
    const all = words.length > 1 && words.every((w) => isMoney(w) || isMarker(w))
    if (!all) { out.push(piece(text, c.x0, c.x1)); continue }
    let pos = 0
    for (const w of words) {
      const at = text.indexOf(w, pos); pos = at + w.length
      const span = c.x1 - c.x0
      out.push(piece(w, c.x0 + (at / text.length) * span, c.x0 + (pos / text.length) * span))
    }
  }
  // A lone Cr/Dr marker belongs to the amount before it.
  for (let i = 1; i < out.length; i++) {
    if (out[i].marker && out[i - 1].money !== null && !out[i - 1].mark) out[i - 1].mark = /^d/i.test(out[i].text) ? 'dr' : 'cr'
  }
  return out
}

function piece(text: string, x0: number, x1: number): BankPiece {
  const marker = /^(cr|dr)\.?$/i.test(text)
  const m = text.match(/^(.*?)(cr|dr)$/i)
  const body = m && BANK_MONEY.test(m[1].trim()) ? m[1].trim() : text
  let money: number | null = null
  if (BANK_MONEY.test(body)) {
    const neg = /^\(.*\)$/.test(body) || body.startsWith('-')
    money = Number(body.replace(/[(),-]/g, ''))
    if (neg) money = -money
  }
  return { text, x0, x1, money, mark: money !== null && m && body !== text ? (/^d/i.test(m[2]) ? 'dr' : 'cr') : null, marker }
}

/** A Dr balance is an overdraft — a negative balance. */
const signed = (p: BankPiece) => (p.mark === 'dr' ? -Math.abs(p.money!) : p.money!)

/** The transaction date: the first cell, or the second after a serial number. */
function bankDate(pieces: BankPiece[]): { date: string; at: number } | null {
  const d0 = parseDate(pieces[0]?.text ?? '')
  if (d0) return { date: d0, at: 0 }
  if (/^\d{1,5}\.?$/.test(pieces[0]?.text ?? '')) {
    const d1 = parseDate(pieces[1]?.text ?? '')
    if (d1) return { date: d1, at: 1 }
  }
  return null
}

// ── Tally helpers ───────────────────────────────────────────────────────

type TallyKind = 'sales' | 'purchase' | 'receipt' | 'payment' | 'credit_note' | 'debit_note' | 'contra' | 'journal'

/** A voucher type name ("Sales GST", "Receipt - HDFC", "Credit Note") → its accounting kind. */
function tallyKind(vchType: string): TallyKind {
  const t = vchType.toLowerCase()
  if (/credit\s*note|sales\s*return/.test(t)) return 'credit_note'
  if (/debit\s*note|purchase\s*return/.test(t)) return 'debit_note'
  if (/receipt/.test(t)) return 'receipt'
  if (/payment/.test(t)) return 'payment'
  if (/contra/.test(t)) return 'contra'
  if (/sales|sale\b/.test(t)) return 'sales'
  if (/purchase/.test(t)) return 'purchase'
  return 'journal'
}

/** The party ledger's ordinary side per voucher kind (true = debited). */
const PARTY_DEBITED: Record<TallyKind, boolean> = {
  sales: true, purchase: false, receipt: false, payment: true,
  credit_note: false, debit_note: true, contra: true, journal: true,
}

export const ComplianceService = {
  /** JSON → workbook. One sheet per section present, plus Summary. */
  async gstJsonToExcel(bytes: Buffer): Promise<{ bytes: Buffer; sections: string[]; invoices: number; rows: number; warning?: string }> {
    let doc: Record<string, unknown>
    try {
      doc = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
    } catch {
      throw new ToolError('unreadable', "This file isn't valid JSON. Export it again from the GST offline utility.")
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new ToolError('unreadable', "This JSON isn't a GSTR-1 return file.")
    }
    const hasGstr1 = GST_SECTIONS.some((s) => doc[s.key] !== undefined)
    if (!hasGstr1 && (doc.ret_period !== undefined || doc.sup_details !== undefined || doc.itc_elg !== undefined)) {
      throw new ToolError('unreadable', 'This looks like a GSTR-3B JSON. Only GSTR-1 is supported by this tool.')
    }
    const wb = newBook()
    const sections: string[] = []
    let invoices = 0
    let rows = 0

    const summary = wb.addWorksheet('Summary')
    summary.columns = [
      { header: 'Field', key: 'k', width: 24 },
      { header: 'Value', key: 'v', width: 34 },
    ]
    for (const [k, label] of [['gstin', 'GSTIN'], ['fp', 'Return period'], ['gt', 'Gross turnover'], ['cur_gt', 'Current turnover'], ['version', 'Version'], ['hash', 'Hash'], ['filing_typ', 'Filing type']] as const) {
      if (doc[k] !== undefined) summary.addRow({ k: label, v: typeof doc[k] === 'number' ? doc[k] : String(doc[k]) })
    }

    for (const sec of GST_SECTIONS) {
      const raw = doc[sec.key]
      if (raw === undefined || raw === null) continue
      let flat: Record<string, unknown>[] = []
      let docs = 0
      if (sec.tables) {
        for (const t of sec.tables) {
          const list = (raw as Record<string, unknown>)[t]
          if (!Array.isArray(list)) continue
          const f = gstFlatten(sec, list as Record<string, unknown>[])
          flat.push(...f.rows.map((r) => ({ [TABLE_HEADER]: t, ...r })))
          docs += f.docs
        }
      } else {
        const list = sec.container ? (raw as Record<string, unknown>)[sec.container] : raw
        if (!Array.isArray(list)) continue
        const f = gstFlatten(sec, list as Record<string, unknown>[])
        flat = f.rows; docs = f.docs
      }
      if (flat.length === 0) continue
      sections.push(sec.label)
      invoices += docs
      rows += flat.length

      const fields = sec.levels.flatMap((l) => l.fields)
      // Only the columns this file uses, in schema order — plus Table for HSN.
      const used = fields.filter((f, i) => fields.findIndex((g) => g.header === f.header) === i && flat.some((r) => r[f.header] !== undefined))
      const ws = wb.addWorksheet(sec.label)
      const heads = [...(sec.tables ? [TABLE_HEADER] : []), ...used.map((f) => f.header)]
      ws.addRow(heads)
      flat.forEach((r) => ws.addRow(heads.map((h) => r[h] ?? null)))
      used.forEach((f, i) => { if (f.kind !== 'num') ws.getColumn(i + 1 + (sec.tables ? 1 : 0)).numFmt = '@' })
      ws.columns.forEach((c, i) => { c.width = Math.max(10, Math.min(40, String(heads[i] ?? '').length + 4)) })
      ws.getRow(1).font = { bold: true }
      ws.views = [{ state: 'frozen', ySplit: 1 }]
    }

    const notConverted = Object.keys(doc).filter((k) => !GST_TOP_LEVEL.has(k))
    if (sections.length === 0) {
      throw new ToolError('empty', `No GSTR-1 sections (${GST_SECTIONS.map((s) => s.key).join(', ')}) were found in this JSON.${notConverted.length ? ` It has: ${notConverted.join(', ')}.` : ''}`)
    }
    summary.addRow({ k: 'Sections', v: sections.join(', ') })
    summary.addRow({ k: 'Invoices / notes / entries', v: invoices })
    summary.addRow({ k: 'Line rows', v: rows })
    if (notConverted.length) summary.addRow({ k: 'Not converted', v: notConverted.join(', ') })
    autoWidth(summary)
    return {
      bytes: Buffer.from(await wb.xlsx.writeBuffer()), sections, invoices, rows,
      warning: notConverted.length
        ? `These parts of the JSON are not converted and are NOT in the workbook: ${notConverted.join(', ')}. Add them in the offline tool before filing.`
        : undefined,
    }
  },

  /** Workbook → GSTR-1 JSON. Reverses gstJsonToExcel sheet for sheet. */
  async gstExcelToJson(bytes: Buffer): Promise<{ bytes: Buffer; sections: string[]; invoices: number; rows: number }> {
    const wb = new ExcelJS.Workbook()
    try {
      await wb.xlsx.load(bytes as unknown as ArrayBuffer)
    } catch {
      throw new ToolError('unreadable', "We couldn't open this spreadsheet. It may be corrupted or not a real Excel file.")
    }
    const out: Record<string, unknown> = {}
    const summary = wb.getWorksheet('Summary')
    if (summary) {
      summary.eachRow((row) => {
        const k = norm(cellText(row.getCell(1).value))
        const v = cellText(row.getCell(2).value).trim()
        if (!v) return
        if (k === 'gstin') out.gstin = v.toUpperCase()
        if (k === 'returnperiod') out.fp = v.padStart(6, '0')
        if (k === 'grossturnover') out.gt = parseAmount(v) ?? v
        if (k === 'currentturnover') out.cur_gt = parseAmount(v) ?? v
        if (k === 'version') out.version = v
        if (k === 'hash') out.hash = v
        if (k === 'filingtype') out.filing_typ = v
      })
    }
    out.version ??= 'GST3.1.6'
    out.hash ??= 'hash'

    const sections: string[] = []
    let invoices = 0
    let rows = 0

    for (const sec of GST_SECTIONS) {
      if (!wb.getWorksheet(sec.label)) continue
      let sheet: SheetRows
      try {
        sheet = await readSheet(bytes, sec.label)
      } catch {
        continue
      }
      if (sec.tables) {
        const tCol = col(sheet, TABLE_HEADER)
        const obj: Record<string, unknown> = {}
        for (const t of sec.tables) {
          const part = { ...sheet, rows: sheet.rows.filter((r) => (at(r, tCol) || sec.tables![0]) === t) }
          if (!part.rows.length) continue
          const n = gstNest(sec, part)
          obj[t] = n.list; invoices += n.docs
        }
        out[sec.key] = obj
      } else {
        const n = gstNest(sec, sheet)
        out[sec.key] = sec.container ? { [sec.container]: n.list } : n.list
        invoices += n.docs
      }
      rows += sheet.rows.length
      sections.push(sec.label)
    }

    if (sections.length === 0) {
      throw new ToolError('empty', `No sheet named ${GST_SECTIONS.map((s) => s.label).join(', ')} was found in this workbook.`)
    }
    return { bytes: Buffer.from(JSON.stringify(out, null, 2), 'utf8'), sections, invoices, rows }
  },

  // ── 2. Bank statement (PDF) → Excel ────────────────────────────────────

  /**
   * Bank PDFs share no layout, so this reads structurally rather than per
   * bank: a transaction line starts with a date (after an optional serial
   * number) and carries one to three money columns, the last of which is the
   * running balance. Money is anything printed with paise ("1,25,000.00"),
   * which keeps cheque numbers, serials and branch codes out.
   *
   * Direction is never guessed from column order alone:
   *  - three amounts → withdrawal, deposit, balance (every Indian bank's order);
   *  - two amounts → the change in the running balance says which side, and
   *    the amount's x-position is learned per side so the first row (which
   *    has no previous balance) is read from the column it sits in;
   *  - a Cr/Dr marker on the amount, when printed, is taken as given.
   * Then the whole chain is checked row by row — opening + credits − debits
   * must equal every printed balance — and a statement that does not tie is
   * refused with the row that breaks, never handed back reversed.
   */
  async bankStatementToExcel(bytes: Buffer, onProgress?: (pct: number) => void): Promise<{
    bytes: Buffer; transactions: number; pageCount: number; skipped: number
    opening: number | null; closing: number | null; totalDebit: number; totalCredit: number; balanced: boolean
  }> {
    const pages: PageText[] = await PDFService.extractText(bytes, (d, t) => onProgress?.((d / t) * 60))
    if (!PDFService.hasTextLayer(pages)) {
      throw new ToolError('no_text_layer', 'This statement is a scan with no text layer. Run OCR Scan on it first, then try again.')
    }

    interface Amt { v: number; x1: number; mark: 'dr' | 'cr' | null }
    interface Raw { page: number; date: string; narration: string; ref: string; amts: Amt[] }
    interface Txn { page: number; date: string; narration: string; ref: string; debit: number | null; credit: number | null; balance: number | null }
    const raws: Raw[] = []
    const skipped: SkipNote[] = []
    let opening: number | null = null      // printed before the first transaction
    let openingHint: number | null = null  // printed in an end-of-statement summary
    let summaryOpeningX: number | null = null

    for (const page of pages) {
      for (const line of page.lines) {
        const pieces = bankPieces(line.cells)
        if (pieces.length === 0) continue
        const joined = pieces.map((p) => p.text).join(' ')

        // A summary block prints "Opening Balance" as a column header and the
        // figure on the line below it.
        if (summaryOpeningX !== null) {
          const under = pieces.filter((p) => p.money !== null).find((p) => Math.abs(p.x0 - summaryOpeningX!) < 25)
          if (under) openingHint = signed(under)
          summaryOpeningX = null
        }
        // Opening / brought-forward and closing / carried-forward lines are
        // balances, not transactions, dated or not. A dated one is recognised
        // only when it carries at most one amount, so a narration that merely
        // mentions "balance" is still read as a transaction.
        const moneyCount = pieces.filter((p) => p.money !== null).length
        const balanceLine = !bankDate(pieces) || moneyCount <= 1
        if (balanceLine && /\b(opening\s+bal(ance)?|balance\s+b\/?f|brought\s+forward|b\/f|balance\s+as\s+on|balance\s+forward)\b/i.test(joined)) {
          // The figure may share a cell with its label: "Balance as on 1 Apr 2026 : 80,000.00".
          const m = bankPieces(pieces.flatMap((p) => p.text.split(/\s+/).map((w) => ({ text: w, x0: p.x0, x1: p.x1 }))))
            .filter((p) => p.money !== null)
          if (m.length) {
            if (raws.length === 0) opening = signed(m[m.length - 1])
            else openingHint ??= signed(m[m.length - 1])
          } else {
            const head = pieces.find((p) => /opening\s+bal/i.test(p.text))
            if (head) summaryOpeningX = head.x0
          }
          continue
        }
        if (balanceLine && /\b(closing\s+bal(ance)?|balance\s+c\/?f|carried\s+forward|c\/f)\b/i.test(joined)) continue
        const dated = bankDate(pieces)
        if (!dated) continue

        // The money run: the last one-to-three amounts on the line. Anything
        // after it (Axis prints the branch code) is not part of the run.
        let last = -1
        for (let k = pieces.length - 1; k > dated.at; k--) if (pieces[k].money !== null) { last = k; break }
        if (last < 0) {
          skipped.push({ row: page.page, reason: `page ${page.page}: a dated line with no amount — "${joined.slice(0, 60)}"` })
          continue
        }
        const run: BankPiece[] = []
        let k = last
        while (k > dated.at && run.length < 3) {
          if (pieces[k].money !== null) run.unshift(pieces[k])
          else if (!pieces[k].marker) break
          k--
        }
        const middle = pieces.slice(dated.at + 1, k + 1)
          .filter((p) => !parseDate(p.text) && p.text !== '-' && p.money === null && !p.marker)
          .map((p) => p.text)
        const ref = middle.find((t) => /^[A-Z0-9/-]{6,}$/.test(t) && /\d/.test(t)) ?? ''
        const narration = middle.filter((t) => t !== ref).join(' ').trim()
        raws.push({ page: page.page, date: dated.date, narration, ref, amts: run.map((p) => ({ v: p.money!, x1: p.x1, mark: p.mark })) })
      }
      onProgress?.(60 + (page.page / pages.length) * 30)
    }

    if (raws.length === 0) {
      throw new ToolError('no_tables', 'No transaction rows were found. This may not be a bank statement, or its layout puts the date somewhere other than the first column.')
    }
    const noBalance = raws.filter((r) => r.amts.length < 2)
    if (noBalance.length === raws.length) {
      throw new ToolError('no_tables', 'This statement has no running balance column, so whether each amount is a debit or a credit cannot be verified. Download the statement with the balance column (the standard "detailed" statement) and try again.')
    }
    if (noBalance.length) {
      const r = noBalance[0]
      throw new ToolError('partial', `The line dated ${r.date} on page ${r.page} has an amount but no running balance, so its direction cannot be checked. Nothing was converted — check that page of the statement.`)
    }

    const fmt = (n: number) => `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    const balOf = (r: Raw) => { const b = r.amts[r.amts.length - 1]; return b.mark === 'dr' ? -b.v : b.v }
    const near = (a: number, b: number) => Math.abs(a - b) < 0.01

    // Pass 1 — direction of single-amount rows from the balance delta, and the
    // x-position of each side's amounts for the row that has no previous balance.
    const dir: ('dr' | 'cr' | null)[] = raws.map((r) => (r.amts.length === 2 ? r.amts[0].mark : null))
    const xs: Record<'dr' | 'cr', number[]> = { dr: [], cr: [] }
    raws.forEach((r, i) => {
      if (r.amts.length !== 2) return
      const prev = i > 0 ? balOf(raws[i - 1]) : opening
      if (dir[i] === null && prev !== null) {
        const delta = round2(balOf(r) - prev)
        if (near(Math.abs(delta), r.amts[0].v)) dir[i] = delta < 0 ? 'dr' : 'cr'
      }
      if (dir[i] && (i > 0 || opening !== null)) xs[dir[i]!].push(r.amts[0].x1)
    })
    if (raws[0].amts.length === 2 && dir[0] === null) {
      const x = raws[0].amts[0].x1
      const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null)
      const dX = mean(xs.dr); const cX = mean(xs.cr)
      if (dX !== null && cX !== null && Math.abs(dX - cX) > 4) dir[0] = Math.abs(x - dX) < Math.abs(x - cX) ? 'dr' : 'cr'
      else if (openingHint !== null) {
        const delta = round2(balOf(raws[0]) - openingHint)
        if (near(Math.abs(delta), raws[0].amts[0].v)) dir[0] = delta < 0 ? 'dr' : 'cr'
      }
      if (dir[0] === null) {
        throw new ToolError('partial', `The first transaction (${raws[0].date}, page ${raws[0].page}) has no opening balance before it, and its column could not be told apart from the others, so it cannot be read as a debit or a credit safely. Nothing was converted.`)
      }
    }

    // Pass 2 — build rows and check the running balance at every line. A
    // three-column layout is read withdrawal-first; only if the whole chain
    // fails that way and ties deposit-first is the other order used.
    const build = (depositFirst: boolean): Txn[] => raws.map((r, i) => {
      const balance = balOf(r)
      if (r.amts.length === 3) {
        const [a0, a1] = depositFirst ? [r.amts[1], r.amts[0]] : [r.amts[0], r.amts[1]]
        return { ...r, debit: a0.v || null, credit: a1.v || null, balance }
      }
      const amt = r.amts[0].v
      return { ...r, debit: dir[i] === 'dr' ? amt : null, credit: dir[i] === 'cr' ? amt : null, balance }
    })
    const openingFor = (t: Txn[]) => opening ?? round2(t[0].balance! - (t[0].credit ?? 0) + (t[0].debit ?? 0))
    const firstBreak = (t: Txn[]) => {
      let prev = openingFor(t)
      for (const x of t) {
        const expected = round2(prev + (x.credit ?? 0) - (x.debit ?? 0))
        if (!near(expected, x.balance!)) return { t: x, prev, expected }
        prev = x.balance!
      }
      return null
    }
    let txns = build(false)
    const broken = firstBreak(txns)
    if (broken) {
      const alt = build(true)
      if (raws.some((r) => r.amts.length === 3) && !firstBreak(alt)) txns = alt
      else {
        const { t, prev, expected } = broken
        throw new ToolError('partial',
          `The running balance does not tie at the line dated ${t.date} on page ${t.page} ("${t.narration.slice(0, 40)}"): ` +
          `${fmt(prev)} plus credits minus debits should give ${fmt(expected)}, but the statement shows ${fmt(t.balance!)}. ` +
          'Nothing was converted, because a statement that does not tie would import with wrong or reversed entries. ' +
          'Check for a line missing from the text layer, a multi-line entry, or a statement that lists the newest transaction first.')
      }
    }
    opening = openingFor(txns)

    const totalDebit = round2(txns.reduce((s, t) => s + (t.debit ?? 0), 0))
    const totalCredit = round2(txns.reduce((s, t) => s + (t.credit ?? 0), 0))
    const closing = txns[txns.length - 1].balance
    const balanced = true

    const wb = newBook()
    const ws = wb.addWorksheet('Transactions')
    ws.columns = [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Narration', key: 'narration', width: 52 },
      { header: 'Reference', key: 'ref', width: 20 },
      { header: 'Debit', key: 'debit', width: 14 },
      { header: 'Credit', key: 'credit', width: 14 },
      { header: 'Balance', key: 'balance', width: 16 },
      { header: 'Page', key: 'page', width: 7 },
    ]
    txns.forEach((t) => ws.addRow(t))
    ;['D', 'E', 'F'].forEach((c) => { ws.getColumn(c).numFmt = '#,##0.00' })
    autoWidth(ws)

    const sum = wb.addWorksheet('Summary')
    sum.columns = [{ header: 'Field', key: 'k', width: 30 }, { header: 'Value', key: 'v', width: 24 }]
    sum.addRow({ k: 'Transactions', v: txns.length })
    sum.addRow({ k: 'Pages read', v: pages.length })
    sum.addRow({ k: 'Opening balance', v: opening ?? '—' })
    sum.addRow({ k: 'Total debit', v: totalDebit })
    sum.addRow({ k: 'Total credit', v: totalCredit })
    sum.addRow({ k: 'Closing balance', v: closing ?? '—' })
    sum.addRow({ k: 'Running balance checked on every line', v: 'Yes' })
    autoWidth(sum)
    addSkippedSheet(wb, skipped)

    return {
      bytes: Buffer.from(await wb.xlsx.writeBuffer()),
      transactions: txns.length, pageCount: pages.length, skipped: skipped.length,
      opening, closing, totalDebit, totalCredit, balanced,
    }
  },

  // ── 3. Form 26AS → Excel ───────────────────────────────────────────────

  /**
   * TRACES exports 26AS as a PDF or a caret-delimited text file. Part I
   * (TDS) and Part II (TDS on 15G/15H) rows carry three amounts — Amount
   * Paid / Credited, Tax Deducted, TDS Deposited — mapped from the section's
   * own header row, never by position from the end. Part VI is tax
   * COLLECTED at source (206C*) and goes to its own sheet: counting it as
   * TDS overstates the credit. Rows in the other parts (194IA buyer side,
   * refunds, …) have different columns and are listed as skipped.
   */
  async form26asToExcel(bytes: Buffer, isText: boolean, onProgress?: (pct: number) => void): Promise<{
    bytes: Buffer; rows: number; deductors: number; totalCredited: number; totalTds: number; totalDeposited: number
    tcsRows: number; totalTcs: number; skipped: number
  }> {
    interface Row { deductor: string; tan: string; part: string; section: string; date: string; status: string; booked: string; paid: number | null; deducted: number | null; deposited: number | null }
    const tds: Row[] = []
    const tcs: Row[] = []
    const skipped: SkipNote[] = []
    const skippedParts = new Map<string, number>()
    let deductor = ''
    let tan = ''
    let part = 'I'
    const SECTION = /^(19[0-9A-Z]{1,4}|206C[A-Z]{0,2}|206[A-Z]{1,3})$/
    // Current statements number parts I–VIII; older ones lettered them
    // (A = TDS, A1 = 15G/15H, B = TCS, A2/C/D… = other layouts).
    const LETTERED: Record<string, string> = { A: 'I', A1: 'II', B: 'VI' }
    const partOf = (t: string) => {
      const m = t.match(/^\s*PART[\s-]*([IVX]+|[A-H]\d?)\b/i)?.[1].toUpperCase()
      return m === undefined ? undefined : /^[IVX]+$/.test(m) ? m : (LETTERED[m] ?? m)
    }
    const place = (r: Row, where: string | number) => {
      // A 206C* section is tax COLLECTED wherever it appears — files without
      // PART headings, or with older "PART A / PART B" headings, included.
      if (/^206C/i.test(r.section)) tcs.push(r)
      else if (part === 'I' || part === 'II') tds.push(r)
      else if (part === 'VI') tcs.push(r)
      else {
        skippedParts.set(part, (skippedParts.get(part) ?? 0) + 1)
        skipped.push({ row: typeof where === 'number' ? where : 0, reason: `${typeof where === 'string' ? `${where}: ` : ''}a Part ${part} row — only Parts I, II (TDS) and VI (TCS) are converted` })
      }
    }

    if (isText) {
      const text = bytes.toString('utf8')
      if (!text.trim()) throw new ToolError('empty', 'This file is empty.')
      // Column positions of the transaction header ("^Sr. No.^Section^…").
      let cols: { paid: number; deducted: number; deposited: number; date: number; booked: number } | null = null
      text.split(/\r?\n/).forEach((line, n) => {
        const p = partOf(line)
        if (p) { part = p; cols = null; return }
        if (!line.includes('^')) return
        const f = line.split('^').map((s) => s.trim())
        if (f.some((v) => /^section$/i.test(v)) && f.some((v) => /amount\s*paid/i.test(v))) {
          const find = (re: RegExp) => f.findIndex((v) => re.test(v))
          cols = {
            paid: find(/amount\s*paid/i), deducted: find(/tax\s*(deducted|collected)/i), deposited: find(/(tds|tcs)\s*deposited/i),
            date: find(/transaction\s*date/i), booked: find(/date\s*of\s*booking/i),
          }
          return
        }
        // A deductor header carries a TAN in its second or third field.
        const tanAt = f.findIndex((v) => /^[A-Z]{4}\d{5}[A-Z]$/.test(v))
        if (tanAt > 0 && !parseDate(f[tanAt + 1] ?? '')) {
          deductor = f[tanAt - 1] || f[1] || deductor
          tan = f[tanAt]
          return
        }
        const dateAt = f.findIndex((v) => parseDate(v) !== null)
        if (dateAt < 0) return
        const c = cols as { paid: number; deducted: number; deposited: number; date: number; booked: number } | null
        let paid: number | null, deducted: number | null, deposited: number | null
        if (c && c.paid >= 0 && c.deducted >= 0 && c.deposited >= 0) {
          paid = parseAmount(f[c.paid] ?? ''); deducted = parseAmount(f[c.deducted] ?? ''); deposited = parseAmount(f[c.deposited] ?? '')
        } else {
          // No header seen: the amounts are the decimal fields in TRACES order —
          // paid / credited, tax deducted, then TDS deposited when printed.
          // (Counting from the left keeps the Sr. No. out and never shifts a column.)
          const money = f.filter((v) => /\.\d{2}$/.test(v)).map(parseAmount).filter((v): v is number => v !== null)
          if (money.length < 2 || money.length > 3) { skipped.push({ row: n + 1, reason: `a dated line without its column header and ${money.length} amounts (expected paid, deducted and deposited)` }); return }
          ;[paid, deducted, deposited = null] = money
        }
        if (paid === null) { skipped.push({ row: n + 1, reason: 'no Amount Paid / Credited on a dated line' }); return }
        const dates = f.map((v) => parseDate(v)).filter((v): v is string => v !== null)
        place({
          deductor, tan, part,
          section: f.find((v) => SECTION.test(v)) ?? '',
          date: (c && c.date >= 0 ? parseDate(f[c.date] ?? '') : null) ?? dates[0],
          status: f.find((v) => /^[FUOPM]$/.test(v)) ?? '',
          booked: (c && c.booked >= 0 ? parseDate(f[c.booked] ?? '') : null) ?? dates[1] ?? '',
          paid, deducted, deposited,
        }, n + 1)
      })
      onProgress?.(70)
    } else {
      const pages = await PDFService.extractText(bytes, (d, t) => onProgress?.((d / t) * 60))
      if (!PDFService.hasTextLayer(pages)) {
        throw new ToolError('no_text_layer', 'This 26AS is a scan with no text layer. Download the text version from TRACES, or run OCR Scan first.')
      }
      let xs: { paid: number; deducted: number; deposited: number } | null = null
      const mid = (c: TextSpan) => (c.x0 + c.x1) / 2
      for (const page of pages) {
        for (const line of page.lines) {
          const cells = line.cells.filter((c) => c.text.trim() !== '')
          if (cells.length === 0) continue
          const texts = cells.map((c) => c.text.trim())
          const joined = texts.join(' ')
          const p = partOf(joined)
          if (p) { part = p; xs = null; continue }
          if (texts.some((t) => /^section$/i.test(t))) {
            const at = (re: RegExp) => cells.find((c) => re.test(c.text))
            const a = at(/amount\s*paid/i); const d = at(/tax\s*(deducted|collected)/i); const dep = at(/(tds|tcs)\s*deposited/i)
            xs = a && d && dep ? { paid: mid(a), deducted: mid(d), deposited: mid(dep) } : null
            continue
          }
          const tanMatch = joined.match(/\b([A-Z]{4}\d{5}[A-Z])\b/)
          if (tanMatch && !parseDate(texts[0])) {
            tan = tanMatch[1]
            deductor = joined.split(tanMatch[1])[0].replace(/^\d+\s*/, '').trim() || deductor
            continue
          }
          if (!parseDate(texts[0]) && !/^\d+$/.test(texts[0])) continue
          const dates = texts.map((t) => parseDate(t)).filter((v): v is string => v !== null)
          if (dates.length === 0) continue
          const money = cells.filter((c) => BANK_MONEY.test(c.text.trim())).map((c) => ({ v: parseAmount(c.text)!, x: mid(c) }))
          let paid: number | null = null, deducted: number | null = null, deposited: number | null = null
          if (xs) {
            const cols = xs
            for (const m of money) {
              const k = (['paid', 'deducted', 'deposited'] as const).reduce((best, key) => (Math.abs(cols[key] - m.x) < Math.abs(cols[best] - m.x) ? key : best), 'paid' as 'paid' | 'deducted' | 'deposited')
              if (k === 'paid') paid = m.v; else if (k === 'deducted') deducted = m.v; else deposited = m.v
            }
          } else if (money.length >= 3) {
            ;[paid, deducted, deposited] = money.slice(-3).map((m) => m.v)
          }
          if (paid === null) { skipped.push({ row: page.page, reason: `page ${page.page}: a dated line whose Amount Paid / Credited could not be placed` }); continue }
          place({
            deductor, tan, part,
            section: texts.find((t) => SECTION.test(t)) ?? '',
            date: dates[0], booked: dates[1] ?? '',
            status: texts.find((t) => /^[FUOPM]$/.test(t)) ?? '',
            paid, deducted, deposited,
          }, `page ${page.page}`)
        }
        onProgress?.(60 + (page.page / pages.length) * 25)
      }
    }

    if (tds.length === 0 && tcs.length === 0) {
      throw new ToolError('no_tables', 'No Part I (TDS) or Part VI (TCS) transaction rows were found. Check this is a Form 26AS export and not another TRACES statement.')
    }

    const sum = (rs: Row[], k: 'paid' | 'deducted' | 'deposited') => round2(rs.reduce((s, r) => s + (r[k] ?? 0), 0))
    const totalCredited = sum(tds, 'paid')
    const totalTds = sum(tds, 'deducted')
    const totalDeposited = sum(tds, 'deposited')
    const totalTcs = sum(tcs, 'deducted')
    const deductors = new Set(tds.map((r) => r.tan || r.deductor)).size

    const wb = newBook()
    const detail = (name: string, who: string, kind: 'TDS' | 'TCS', rs: Row[]) => {
      const ws = wb.addWorksheet(name)
      ws.columns = [
        { header: who, key: 'deductor', width: 40 },
        { header: 'TAN', key: 'tan', width: 14 },
        { header: 'Part', key: 'part', width: 6 },
        { header: 'Section', key: 'section', width: 10 },
        { header: 'Transaction Date', key: 'date', width: 14 },
        { header: 'Status', key: 'status', width: 8 },
        { header: 'Date of Booking', key: 'booked', width: 14 },
        { header: kind === 'TDS' ? 'Amount Paid / Credited' : 'Amount Paid / Debited', key: 'paid', width: 20 },
        { header: kind === 'TDS' ? 'Tax Deducted' : 'Tax Collected', key: 'deducted', width: 16 },
        { header: `${kind} Deposited`, key: 'deposited', width: 16 },
      ]
      rs.forEach((r) => ws.addRow(r))
      ;['H', 'I', 'J'].forEach((c) => { ws.getColumn(c).numFmt = '#,##0.00' })
      autoWidth(ws)
    }
    detail('Part I - TDS', 'Deductor', 'TDS', tds)

    // Per-deductor totals — the sheet the reconciliation actually uses.
    const byTan = new Map<string, { deductor: string; tan: string; count: number; paid: number; deducted: number; deposited: number }>()
    for (const r of tds) {
      const k = r.tan || r.deductor
      const e = byTan.get(k) ?? { deductor: r.deductor, tan: r.tan, count: 0, paid: 0, deducted: 0, deposited: 0 }
      e.paid = round2(e.paid + (r.paid ?? 0))
      e.deducted = round2(e.deducted + (r.deducted ?? 0))
      e.deposited = round2(e.deposited + (r.deposited ?? 0))
      e.count++
      byTan.set(k, e)
    }
    const bd = wb.addWorksheet('By Deductor')
    bd.columns = [
      { header: 'Deductor', key: 'deductor', width: 40 },
      { header: 'TAN', key: 'tan', width: 14 },
      { header: 'Entries', key: 'count', width: 10 },
      { header: 'Amount Paid / Credited', key: 'paid', width: 20 },
      { header: 'Tax Deducted', key: 'deducted', width: 16 },
      { header: 'TDS Deposited', key: 'deposited', width: 16 },
    ]
    ;[...byTan.values()].forEach((e) => bd.addRow(e))
    bd.addRow({ deductor: 'Total', tan: '', count: tds.length, paid: totalCredited, deducted: totalTds, deposited: totalDeposited }).font = { bold: true }
    ;['D', 'E', 'F'].forEach((c) => { bd.getColumn(c).numFmt = '#,##0.00' })
    autoWidth(bd)

    if (tcs.length) detail('Part VI - TCS', 'Collector', 'TCS', tcs)
    addSkippedSheet(wb, skipped)

    return {
      bytes: Buffer.from(await wb.xlsx.writeBuffer()), rows: tds.length, deductors, totalCredited, totalTds, totalDeposited,
      tcsRows: tcs.length, totalTcs, skipped: skipped.length,
    }
  },

  // ── 4. Excel → Tally XML ───────────────────────────────────────────────

  /**
   * Tally imports a `TALLYMESSAGE` per voucher inside an `ENVELOPE` with
   * `VCHTYPE`/`ACTION` headers. Each voucher gets exactly two ledger
   * entries — party and the nominal account — because a two-sided voucher is
   * what a one-row-per-transaction sheet can honestly describe. Which side
   * the party sits on comes from PARTY_DEBITED (Receipt: Cr party, Dr bank;
   * Payment: Dr party, Cr bank), and a money voucher with no bank/cash
   * ledger is skipped rather than defaulted. Tally's sign
   * convention is the trap: a positive AMOUNT is a CREDIT, a negative one a
   * DEBIT, so ISDEEMEDPOSITIVE and the sign must agree or the voucher
   * imports inverted.
   */
  async excelToTallyXml(bytes: Buffer, opts: { companyName?: string } = {}): Promise<{
    bytes: Buffer; vouchers: number; skipped: number; warning?: string; totalAmount: number; voucherTypes: string[]
  }> {
    const sheet = await readSheet(bytes)
    const c = requireCols(sheet, {
      date: ['Date', 'Voucher Date', 'Txn Date'],
      amount: ['Amount', 'Value', 'Debit'],
      party: ['Party Ledger', 'Party', 'Party Name', 'Ledger', 'Account'],
    })
    const cType = col(sheet, 'Voucher Type', 'Type', 'Vch Type')
    const cNo = col(sheet, 'Voucher No', 'Voucher Number', 'Vch No', 'Invoice No')
    const cNarr = col(sheet, 'Narration', 'Particulars', 'Description')
    const cAgainst = col(sheet, 'Ledger Name', 'Against Ledger', 'Sales Ledger', 'Purchase Ledger', 'Nominal Account')
    const cDrCr = col(sheet, 'Dr/Cr', 'DrCr', 'Type of Entry')

    const company = (opts.companyName ?? '').trim()
    const parts: string[] = []
    const skipped: SkipNote[] = []
    const types = new Set<string>()
    let total = 0
    let vouchers = 0

    sheet.rows.forEach((r, i) => {
      const rowNo = sheet.rowNos[i]
      const date = parseDate(at(r, c.date))
      if (!date) { skipped.push({ row: rowNo, reason: `unreadable date "${at(r, c.date)}"` }); return }
      const amount = parseAmount(at(r, c.amount))
      if (amount === null) { skipped.push({ row: rowNo, reason: `unreadable amount "${at(r, c.amount)}"` }); return }
      const party = at(r, c.party)
      if (!party) { skipped.push({ row: rowNo, reason: 'no party ledger' }); return }

      const vchType = at(r, cType) || 'Journal'
      const kind = tallyKind(vchType)
      const drcr = at(r, cDrCr).toLowerCase()
      let against = at(r, cAgainst)
      if (!against) {
        // Money vouchers have no safe default: posting a receipt to "Sales"
        // books the income twice and leaves the bank untouched.
        if (kind === 'receipt' || kind === 'payment') {
          skipped.push({ row: rowNo, reason: `${vchType} needs the Bank or Cash ledger in the Ledger Name column` }); return
        }
        if (kind === 'contra') {
          skipped.push({ row: rowNo, reason: 'Contra needs both ledgers — the Bank or Cash ledger in the Ledger Name column' }); return
        }
        if (kind === 'credit_note' || kind === 'debit_note') {
          skipped.push({ row: rowNo, reason: `${vchType} needs the returns or adjustment ledger in the Ledger Name column` }); return
        }
        against = kind === 'sales' ? 'Sales' : kind === 'purchase' ? 'Purchase' : 'Suspense A/c'
      }
      // Dr/Cr, when given, says which side the PARTY ledger is on. Otherwise
      // the ordinary side for the voucher type: the customer is debited on a
      // sale and credited on a receipt or credit note; the supplier is
      // credited on a purchase and debited on a payment or debit note.
      if (!drcr && kind === 'contra') {
        skipped.push({ row: rowNo, reason: 'Contra needs a Dr/Cr column saying whether the Party Ledger account is debited or credited' }); return
      }
      const partyIsDebit = drcr ? drcr.startsWith('d') : PARTY_DEBITED[kind]
      types.add(vchType)
      const abs = Math.abs(amount)
      const [tallyDate] = [date.split('/').reverse().join('')]

      const entry = (ledger: string, isDebit: boolean) =>
        `      <ALLLEDGERENTRIES.LIST>\n` +
        `       <LEDGERNAME>${xmlEscape(ledger)}</LEDGERNAME>\n` +
        `       <ISDEEMEDPOSITIVE>${isDebit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>\n` +
        `       <AMOUNT>${isDebit ? -abs : abs}</AMOUNT>\n` +
        `      </ALLLEDGERENTRIES.LIST>`

      parts.push(
        `    <TALLYMESSAGE xmlns:UDF="TallyUDF">\n` +
        `     <VOUCHER VCHTYPE="${xmlEscape(vchType)}" ACTION="Create" OBJVIEW="Accounting Voucher View">\n` +
        `      <DATE>${tallyDate}</DATE>\n` +
        `      <EFFECTIVEDATE>${tallyDate}</EFFECTIVEDATE>\n` +
        `      <VOUCHERTYPENAME>${xmlEscape(vchType)}</VOUCHERTYPENAME>\n` +
        (at(r, cNo) ? `      <VOUCHERNUMBER>${xmlEscape(at(r, cNo))}</VOUCHERNUMBER>\n` : '') +
        `      <PARTYLEDGERNAME>${xmlEscape(party)}</PARTYLEDGERNAME>\n` +
        (at(r, cNarr) ? `      <NARRATION>${xmlEscape(at(r, cNarr))}</NARRATION>\n` : '') +
        `      <ISINVOICE>No</ISINVOICE>\n` +
        entry(party, partyIsDebit) + '\n' +
        entry(against, !partyIsDebit) + '\n' +
        `     </VOUCHER>\n` +
        `    </TALLYMESSAGE>`
      )
      vouchers++
      total = round2(total + abs)
    })

    if (vouchers === 0) {
      throw new ToolError('empty', `No voucher could be built. ${skipped.length} ${skipped.length === 1 ? 'row was' : 'rows were'} unreadable — check the Date, Amount and Party Ledger columns.`)
    }

    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<ENVELOPE>\n <HEADER>\n  <TALLYREQUEST>Import Data</TALLYREQUEST>\n </HEADER>\n` +
      ` <BODY>\n  <IMPORTDATA>\n   <REQUESTDESC>\n    <REPORTNAME>Vouchers</REPORTNAME>\n` +
      (company ? `    <STATICVARIABLES>\n     <SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY>\n    </STATICVARIABLES>\n` : '') +
      `   </REQUESTDESC>\n   <REQUESTDATA>\n` +
      parts.join('\n') + '\n' +
      `   </REQUESTDATA>\n  </IMPORTDATA>\n </BODY>\n</ENVELOPE>\n`

    return {
      bytes: Buffer.from(xml, 'utf8'), vouchers, skipped: skipped.length,
      warning: skipWarning(skipped, vouchers, 'vouchers')?.replace(' and listed on the Skipped sheet', ''),
      totalAmount: total, voucherTypes: [...types],
    }
  },

  // ── 5. TDS return text file (Form No. 140, formerly 26Q) ─────────────────

  /**
   * The quarterly non-salary TDS statement in Protean's Form 140 layout
   * (spec v1.1, Tax Year 2026-27 onwards): one FH, one BH, then each CD
   * (challan) followed by its DD (deductee) records, `^`-delimited, CRLF
   * line endings. Rows are grouped into challans by (BSR code, challan
   * serial, challan date).
   *
   * The file is what NSDL's FVU 1.2 validates into the .fvu that gets
   * uploaded. This tool can't make the .fvu itself, and the FVU also
   * checks challans against the .csi file from Challan Status Inquiry.
   * Every rule the spec states per row is checked here, so a row the FVU
   * would reject is skipped with a reason instead.
   */
  async tdsTextFile(bytes: Buffer, opts: TdsStatementOptions): Promise<{
    bytes: Buffer; deductees: number; challans: number; skipped: number; totalTds: number; warning?: string
  }> {
    const d = checkDeductor(opts)
    const { from: qFrom, to: qTo } = F140.quarterRange(d.startYear, d.quarter)
    const today = istToday()
    const earliestChallan = new Date(Date.UTC(d.startYear - 1, 3, 1))

    const sheet = await readSheet(bytes)
    const c = requireCols(sheet, {
      pan: ['PAN', 'Deductee PAN', 'PAN of Deductee'],
      name: ['Name', 'Deductee Name', 'Name of Deductee'],
      section: ['Section Code', 'Section', 'Nature of Payment'],
      date: ['Date of Payment', 'Payment Date', 'Date of Credit', 'Date'],
      paid: ['Amount Paid', 'Amount Credited', 'Amount Paid/Credited', 'Payment Amount', 'Gross Amount', 'Amount'],
      tds: ['TDS', 'TDS Deducted', 'TDS Amount', 'TDS Amt', 'Amount of TDS', 'Tax Deducted', 'Total Tax Deducted'],
      bsr: ['BSR Code', 'BSR'],
      chNo: ['Challan No', 'Challan Serial No', 'Challan Serial', 'Challan Number'],
      chDate: ['Challan Date', 'Date of Deposit', 'Deposit Date'],
    })
    const cDeductDate = col(sheet, 'Date of Deduction', 'Deduction Date')
    const cRate = col(sheet, 'Rate', 'TDS Rate', 'Rate of TDS')
    const cDeposited = col(sheet, 'TDS Deposited', 'Tax Deposited')
    const cRemark = col(sheet, 'Remark', 'Remarks', 'Reason', 'Reason Code', 'Reason for non-deduction')
    const cCert = col(sheet, 'Certificate No', 'Certificate Number', 'Lower Deduction Certificate')
    const cChTax = col(sheet, 'Challan Tax', 'Challan Amount', 'Tax Deposited in Challan')
    const cChInterest = col(sheet, 'Challan Interest', 'Interest')
    const cChFee = col(sheet, 'Challan Fee', 'Fee', 'Late Fee')
    const cChOthers = col(sheet, 'Challan Others', 'Penalty', 'Others')

    interface Deductee {
      pan: string; name: string; section: string; paidOn: string; paid: number
      tds: number; deposited: number; deductedOn: string; rate: number; remark: string; cert: string
    }
    interface Challan {
      bsr: string; serial: string; date: string
      tax: number | null; interest: number; fee: number; others: number
      rows: Deductee[]
    }
    const challans = new Map<string, Challan>()
    const skipped: SkipNote[] = []
    const inQuarter = (dmy: string) => { const t = F140.dmyToDate(dmy); return t >= qFrom && t <= qTo }
    const future = (dmy: string) => F140.dmyToDate(dmy) > today

    sheet.rows.forEach((r, i) => {
      const rowNo = i + 2
      const skip = (reason: string) => { skipped.push({ row: rowNo, reason }) }

      const pan = at(r, c.pan).toUpperCase().replace(/\s/g, '')
      const isDefaultPan = F140.DEFAULT_PANS.has(pan)
      if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan) && !isDefaultPan) return skip(`"${pan || 'blank'}" is not a valid PAN (or PANNOTAVBL / PANAPPLIED / PANINVALID)`)
      const name = F140.text(at(r, c.name), 75)
      if (!/[A-Za-z0-9]/.test(name)) return skip('no deductee name')

      const paid = parseAmount(at(r, c.paid))
      if (paid === null || paid <= 0) return skip(`amount paid "${at(r, c.paid)}" must be more than 0`)
      const tds = parseAmount(at(r, c.tds))
      if (tds === null || tds < 0) return skip(`unreadable TDS "${at(r, c.tds)}"`)
      const rateRaw = at(r, cRate).replace(/%/g, '')
      const givenRate = rateRaw ? parseAmount(rateRaw) : null
      if (rateRaw && givenRate === null) return skip(`unreadable rate "${at(r, cRate)}"`)

      const sec = F140.resolveSection(at(r, c.section), pan, givenRate)
      if ('problem' in sec) return skip(sec.problem)
      if (F140.UNSUPPORTED_SECTIONS.has(sec.code)) return skip(`section ${sec.code} (cash withdrawal) needs the withdrawal amounts — prepare it in the RPU`)
      const inKind = F140.IN_KIND_SECTIONS.has(sec.code)
      if (inKind && isDefaultPan) return skip(`section ${sec.code} does not allow ${pan}`)
      if (inKind && tds !== 0) return skip(`section ${sec.code} is paid in kind, so TDS must be 0.00`)

      const paidOn = parseDate(at(r, c.date))
      if (!paidOn) return skip(`unreadable date of payment "${at(r, c.date)}"`)
      if (!inQuarter(paidOn)) return skip(`date of payment ${paidOn} is outside ${d.quarter} of tax year ${d.fyLabel}`)
      if (future(paidOn)) return skip(`date of payment ${paidOn} is in the future`)

      let deductedOn = ''
      if (tds > 0) {
        deductedOn = parseDate(at(r, cDeductDate)) ?? (at(r, cDeductDate) ? '' : paidOn)
        if (!deductedOn) return skip(`unreadable date of deduction "${at(r, cDeductDate)}"`)
        if (F140.dmyToDate(deductedOn) < qFrom) return skip(`date of deduction ${deductedOn} is before ${d.quarter}`)
        if (future(deductedOn)) return skip(`date of deduction ${deductedOn} is in the future`)
      }

      const deposited = cDeposited >= 0 && at(r, cDeposited) ? parseAmount(at(r, cDeposited)) : tds
      if (deposited === null || deposited < 0) return skip(`unreadable TDS deposited "${at(r, cDeposited)}"`)
      if (inKind && deposited !== 0) return skip(`section ${sec.code} is paid in kind, so TDS deposited must be 0.00`)

      const rate = inKind || tds === 0 ? 0 : givenRate ?? Math.round((tds / paid) * 100 * 10000) / 10000

      const remark = at(r, cRemark).toUpperCase()
      if (remark && !F140.REMARK_CODES.has(remark)) return skip(`remark "${remark}" is not a Form 140 reason code`)
      const cert = at(r, cCert).toUpperCase().replace(/\s/g, '')
      if (remark === 'A' && !/^[A-Z0-9]{10}([A-Z0-9]{5})?$/.test(cert)) return skip('remark A needs the 10 or 15 character certificate number')
      if (tds === 0 && !remark) return skip('TDS is 0.00 but no reason code (A, B, Y…) says why')

      const bsr = at(r, c.bsr).replace(/\s/g, '')
      if (!/^\d{7}$/.test(bsr)) return skip(`BSR code "${bsr || 'blank'}" must be 7 digits`)
      const serial = at(r, c.chNo).replace(/\s/g, '').replace(/^0+(?=\d)/, '')
      if (!/^\d{1,5}$/.test(serial)) return skip(`challan serial "${serial || 'blank'}" must be up to 5 digits`)
      const chDate = parseDate(at(r, c.chDate))
      if (!chDate) return skip(`unreadable challan date "${at(r, c.chDate)}"`)
      if (F140.dmyToDate(chDate) < earliestChallan) return skip(`challan date ${chDate} is before 1 April ${d.startYear - 1}`)
      if (future(chDate)) return skip(`challan date ${chDate} is in the future`)

      const key = `${bsr}|${serial}|${chDate}`
      let ch = challans.get(key)
      if (!ch) {
        const n = (ci: number) => (ci >= 0 && at(r, ci) ? parseAmount(at(r, ci)) : 0) ?? 0
        ch = {
          bsr, serial, date: chDate,
          tax: cChTax >= 0 && at(r, cChTax) ? parseAmount(at(r, cChTax)) : null,
          interest: n(cChInterest), fee: n(cChFee), others: n(cChOthers), rows: [],
        }
        challans.set(key, ch)
      }
      ch.rows.push({ pan, name, section: sec.code, paidOn, paid, tds, deposited, deductedOn, rate, remark, cert })
    })

    // Challan amounts are whole rupees, and the challan has to cover what
    // its deductees say was deposited against it.
    for (const [key, ch] of challans) {
      const depositedSum = round2(ch.rows.reduce((s, x) => s + x.deposited, 0))
      const tax = ch.tax ?? Math.ceil(depositedSum)
      const whole = [tax, ch.interest, ch.fee, ch.others].every((v) => Number.isInteger(v))
      if (!whole || tax < depositedSum) {
        const reason = `challan ${ch.bsr}/${ch.serial} of ${ch.date}: ${!whole ? 'challan amounts must be whole rupees' : `challan tax ₹${tax} is less than the ₹${depositedSum} its deductees deposited`}`
        skipped.push(...ch.rows.map(() => ({ row: 0, reason })))
        challans.delete(key)
        continue
      }
      ch.tax = tax
    }

    const deductees = [...challans.values()].reduce((n, ch) => n + ch.rows.length, 0)
    if (deductees === 0) {
      throw new ToolError('empty', `No deductee row could be used. ${skipped.length} ${skipped.length === 1 ? 'row was' : 'rows were'} skipped — first: ${skipped.slice(0, 3).map((s) => (s.row ? `row ${s.row}: ` : '') + s.reason).join('; ')}.`)
    }

    const { FIELD_COUNT: N, amt, record } = F140
    const L: string[] = []
    const line = () => L.length + 1
    const empty = (k: number) => Array<string>(k).fill('')

    // FH — fields 11–18 (hashes, versions) are left for the FVU.
    L.push(record([line(), 'FH', 'NS1', 'R', F140.ddmmyyyy(fmtDmy(today)), 1, 'D', d.tan, 1, 'AuditOS', ...empty(8)], N.FH))

    const list = [...challans.values()]
    const chTotal = (ch: Challan) => ch.tax! + ch.interest + ch.fee + ch.others
    L.push(record([
      line(), 'BH', 1, list.length, '140',          // 1–5
      '', '', '',                                   // 6–8 not applicable
      d.filedEarlier ? d.previousToken : '',        // 9 previous regular token
      '', '', '', d.tan, '',                        // 10–14
      d.pan, d.ay, d.ty, d.quarter, d.name,         // 15–19
      d.country, d.address[0], d.address[1], d.address[2], d.address[3], d.address[4], // 20–25
      d.state, d.pincode, d.email, d.phoneCc, d.phone, '', // 26–31
      d.type, d.rpName, d.rpDesignation,            // 32–34
      d.rpAddress[0], d.rpAddress[1], d.rpAddress[2], d.rpAddress[3], d.rpAddress[4], // 35–39
      d.rpState, d.rpPincode, d.rpEmail, d.rpCountry, d.rpPhoneCc, d.rpPhone, '', // 40–46
      amt(list.reduce((s, ch) => s + chTotal(ch), 0)), // 47 batch total of deposits
      '', '', '', '',                               // 48–51
      d.filedEarlier ? 'Y' : 'N', '', '',           // 52–54
      '', '', '', '',                               // 55–58 (state/ministry: govt deductors only)
      d.rpPan,                                      // 59
      ...empty(8),                                  // 60–67 fillers
      '', d.gstin, '', '', '',                      // 68–72
    ], N.BH))

    list.forEach((ch, ci) => {
      const deducted = round2(ch.rows.reduce((s, x) => s + x.tds, 0))
      const deposited = round2(ch.rows.reduce((s, x) => s + x.deposited, 0))
      L.push(record([
        line(), 'CD', 1, ci + 1, ch.rows.length, 'N', '', // 1–7
        amt(ch.tax!), amt(ch.interest), amt(ch.fee), amt(ch.others), amt(chTotal(ch)), // 8–12
        'C', '', ch.bsr, '', ch.serial, '', F140.ddmmyyyy(ch.date), '', // 13–20
        amt(deposited), amt(deducted), 200,         // 21–23 (minor head 200: TDS payable by taxpayer)
        amt(ch.interest), amt(ch.others),           // 24–25 allocations, as fields 9 and 11
        ...empty(5),                                // 26–30
      ], N.CD))
      ch.rows.forEach((x, di) => {
        L.push(record([
          line(), 'DD', 1, di + 1, ci + 1, 'O', '', x.pan, x.name, // 1–9
          ...empty(5), x.section, '', '',           // 10–17
          'Y', F140.ddmmyyyy(x.paidOn), amt(x.paid), '', '', '', // 18–23
          amt(x.tds), amt(x.deposited), '',         // 24–26
          x.deductedOn ? F140.ddmmyyyy(x.deductedOn) : '', x.rate.toFixed(4), // 27–28
          '', '', '', x.remark, x.cert,             // 29–33
          ...empty(12),                             // 34–45
        ], N.DD))
      })
    })

    const totalTds = round2(list.reduce((s, ch) => s + ch.rows.reduce((t, x) => t + x.tds, 0), 0))
    return {
      bytes: Buffer.from(L.join('\r\n') + '\r\n', 'ascii'),
      deductees, challans: list.length, skipped: skipped.length, totalTds,
      warning: skipped.length
        ? `${deductees} deductee ${deductees === 1 ? 'row' : 'rows'} written. ${skipped.length} ${skipped.length === 1 ? 'row was' : 'rows were'} skipped: ${skipped.slice(0, 3).map((s) => (s.row ? `row ${s.row} (${s.reason})` : s.reason)).join(', ')}${skipped.length > 3 ? ', …' : ''}.`
        : undefined,
    }
  },

  // ── 6. Invoice (Excel) → e-Invoice JSON ────────────────────────────────

  /**
   * The IRP accepts an array of invoices in schema 1.1. One sheet row is one
   * line item; rows sharing an invoice number become one invoice with an
   * ItemList. ValDtls is summed from the items so the totals always tie.
   *
   * Every row is validated against the schema's mandatory fields before
   * anything is written, and ANY problem refuses the whole file with a
   * row-by-row list: a bulk upload with one bad invoice is rejected by the
   * IRP anyway, and a "completed" job with invalid JSON is worse than none.
   * B2C is not an IRP supply type — an unregistered buyer is refused unless
   * the row is an export (EXPWP/EXPWOP), where the buyer GSTIN is "URP".
   */
  async invoiceToEInvoiceJson(bytes: Buffer): Promise<{
    bytes: Buffer; invoices: number; items: number; skipped: number; totalValue: number; warning?: string
  }> {
    const sheet = await readSheet(bytes)
    const c = requireCols(sheet, {
      invNo: ['Invoice No', 'Invoice Number', 'Doc No'],
      invDate: ['Invoice Date', 'Doc Date', 'Date'],
      sellerGstin: ['Seller GSTIN', 'Supplier GSTIN', 'GSTIN of Supplier'],
      buyerGstin: ['Buyer GSTIN', 'Recipient GSTIN', 'GSTIN of Recipient'],
      taxable: ['Taxable Value', 'Taxable Amount', 'Assessable Value'],
    })
    const g = (...names: string[]) => col(sheet, ...names)
    const cSellerName = g('Seller Name', 'Supplier Name', 'Seller Legal Name'); const cSellerAddr = g('Seller Address', 'Supplier Address')
    const cSellerLoc = g('Seller City', 'Seller Location', 'Supplier City'); const cSellerPin = g('Seller Pincode', 'Supplier Pincode', 'Seller PIN')
    const cSellerState = g('Seller State Code', 'Supplier State Code', 'Seller State')
    const cBuyerName = g('Buyer Name', 'Recipient Name', 'Buyer Legal Name'); const cBuyerAddr = g('Buyer Address', 'Recipient Address')
    const cBuyerLoc = g('Buyer City', 'Buyer Location'); const cBuyerPin = g('Buyer Pincode', 'Buyer PIN')
    const cBuyerState = g('Buyer State Code', 'Buyer State'); const cPos = g('Place of Supply', 'POS')
    const cItemDesc = g('Item Description', 'Description', 'Product'); const cHsn = g('HSN', 'HSN Code', 'HSN/SAC')
    const cQty = g('Quantity', 'Qty'); const cUnit = g('Unit', 'UQC', 'UOM'); const cRate = g('Unit Price', 'Rate', 'Price')
    const cGstRate = g('GST Rate', 'Tax Rate', 'Rate %')
    const cIgst = g('IGST', 'IGST Amount'); const cCgst = g('CGST', 'CGST Amount'); const cSgst = g('SGST', 'SGST Amount')
    const cCess = g('Cess', 'Cess Amount'); const cDocType = g('Document Type', 'Doc Type')
    const cSupTyp = g('Supply Type', 'SupTyp'); const cRev = g('Reverse Charge', 'RegRev')

    const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/
    const SUP_TYPES = ['B2B', 'SEZWP', 'SEZWOP', 'EXPWP', 'EXPWOP', 'DEXP']
    const GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40]
    const fmt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const pin = (v: string) => { const d = v.replace(/\.0+$/, '').replace(/\s/g, ''); return /^[1-9]\d{5}$/.test(d) ? Number(d) : null }
    const stcd = (v: string) => (/^\d{1,2}$/.test(v) && Number(v) > 0 ? v.padStart(2, '0') : null)

    interface Item { SlNo: string; PrdDesc?: string; IsServc: string; HsnCd: string; Qty?: number; Unit?: string; UnitPrice: number; TotAmt: number; AssAmt: number; GstRt: number; IgstAmt: number; CgstAmt: number; SgstAmt: number; CesAmt: number; TotItemVal: number }
    interface Head { rowNo: number; date: string; supTyp: string; regRev: string; docTyp: string; seller: Record<string, unknown>; buyer: Record<string, unknown> }
    const byInvoice = new Map<string, { head: Head; items: Item[] }>()
    const problems: string[] = []

    sheet.rows.forEach((r, i) => {
      const rowNo = sheet.rowNos[i]
      const errs: string[] = []
      const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg) }

      const invNo = at(r, c.invNo)
      need(/^[A-Za-z1-9][A-Za-z0-9/-]{0,15}$/.test(invNo), invNo ? `Invoice No "${invNo}" must be up to 16 letters, digits, / or - and not start with 0, / or -` : 'Invoice No is blank')
      const date = parseDate(at(r, c.invDate))
      need(!!date, `Invoice Date "${at(r, c.invDate)}" is not a date`)
      const docTyp = (at(r, cDocType) || 'INV').toUpperCase()
      need(['INV', 'CRN', 'DBN'].includes(docTyp), `Document Type "${docTyp}" must be INV, CRN or DBN`)

      const sellerGstin = at(r, c.sellerGstin).toUpperCase()
      need(GSTIN.test(sellerGstin), `Seller GSTIN "${sellerGstin || 'blank'}" is not a valid GSTIN`)
      const seller = {
        Gstin: sellerGstin, LglNm: at(r, cSellerName), Addr1: at(r, cSellerAddr), Loc: at(r, cSellerLoc),
        Pin: pin(at(r, cSellerPin)), Stcd: stcd(at(r, cSellerState)) ?? (GSTIN.test(sellerGstin) ? sellerGstin.slice(0, 2) : null),
      }
      need(seller.LglNm.length >= 3, 'Seller Name is required')
      need(seller.Addr1.length >= 1, 'Seller Address is required')
      need(seller.Loc.length >= 3, 'Seller City is required')
      need(seller.Pin !== null, 'Seller Pincode must be 6 digits')
      need(seller.Stcd !== null, 'Seller State Code is required')

      const buyerGstin = at(r, c.buyerGstin).toUpperCase()
      const given = at(r, cSupTyp).toUpperCase()
      const supTyp = given || 'B2B'
      const isExport = supTyp === 'EXPWP' || supTyp === 'EXPWOP'
      if (given === 'B2C' || (!buyerGstin && !isExport) || buyerGstin === 'URP' && !isExport) {
        errs.push('unregistered buyer (B2C) — B2C invoices are not reported to the IRP; leave them out of this sheet')
      } else {
        need(SUP_TYPES.includes(supTyp), `Supply Type "${supTyp}" must be one of ${SUP_TYPES.join(', ')}`)
        need(isExport && (!buyerGstin || buyerGstin === 'URP') || GSTIN.test(buyerGstin), `Buyer GSTIN "${buyerGstin}" is not a valid GSTIN`)
      }
      const buyerReg = GSTIN.test(buyerGstin)
      const buyer = {
        Gstin: buyerReg ? buyerGstin : 'URP', LglNm: at(r, cBuyerName), Addr1: at(r, cBuyerAddr), Loc: at(r, cBuyerLoc),
        Pin: pin(at(r, cBuyerPin)),
        Pos: stcd(at(r, cPos)) ?? (buyerReg ? buyerGstin.slice(0, 2) : null),
        Stcd: stcd(at(r, cBuyerState)) ?? (buyerReg ? buyerGstin.slice(0, 2) : null),
      }
      need(buyer.LglNm.length >= 3, 'Buyer Name is required')
      need(buyer.Addr1.length >= 1, 'Buyer Address is required')
      need(buyer.Loc.length >= 3, 'Buyer City is required')
      need(buyer.Pin !== null, 'Buyer Pincode must be 6 digits (999999 for an export)')
      need(buyer.Pos !== null, 'Place of Supply is required (96 for an export)')
      need(buyer.Stcd !== null, 'Buyer State Code is required (96 for an export)')

      // ── Item
      const hsn = at(r, cHsn).replace(/\s/g, '')
      need(/^\d{4}$|^\d{6}$|^\d{8}$/.test(hsn), hsn ? `HSN "${hsn}" must be 4, 6 or 8 digits` : 'HSN is required')
      const isServc = hsn.startsWith('99')
      const taxable = parseAmount(at(r, c.taxable))
      need(taxable !== null, `Taxable Value "${at(r, c.taxable)}" is not a number`)
      const qty = parseAmount(at(r, cQty))
      const unit = at(r, cUnit).toUpperCase()
      if (!isServc && hsn) need(qty !== null && !!unit, 'Quantity and Unit are mandatory for goods')
      let unitPrice = parseAmount(at(r, cRate))
      if (unitPrice === null && qty && taxable !== null) unitPrice = round2(taxable / qty)
      need(unitPrice !== null, 'Unit Price is required (or a Quantity to work it out from the taxable value)')
      const igst = parseAmount(at(r, cIgst)) ?? 0
      const cgst = parseAmount(at(r, cCgst)) ?? 0
      const sgst = parseAmount(at(r, cSgst)) ?? 0
      const cess = parseAmount(at(r, cCess)) ?? 0
      need(!(igst && (cgst || sgst)), 'a line has both IGST and CGST/SGST')
      need(Math.abs(cgst - sgst) < 0.01, `CGST ${fmt(cgst)} and SGST ${fmt(sgst)} must be equal`)
      const tax = round2(igst + cgst + sgst)
      let rate = parseAmount(at(r, cGstRate))
      if (taxable !== null && taxable > 0) {
        if (rate === null) {
          const derived = Math.round((tax / taxable) * 10000) / 100
          const slab = GST_RATES.find((s) => Math.abs(round2(taxable * s / 100) - tax) <= 1)
          if (slab === undefined) errs.push(`GST Rate is blank and the tax (${fmt(tax)}, ${derived}% of taxable) is not a GST rate`)
          else rate = slab
        } else if (!GST_RATES.includes(rate)) {
          errs.push(`GST Rate ${rate}% is not a GST rate`)
        } else {
          const expected = round2(taxable * rate / 100)
          if (Math.abs(expected - tax) > 1) errs.push(`GST Rate ${rate}% on ${fmt(taxable)} is ${fmt(expected)}, but the row has ${fmt(tax)} tax`)
        }
      }

      if (errs.length === 0 && invNo && byInvoice.has(invNo)) {
        const h = byInvoice.get(invNo)!.head
        if (h.date !== date || (h.seller.Gstin !== seller.Gstin) || (h.buyer.Gstin !== buyer.Gstin)) {
          errs.push(`Invoice ${invNo} has a different date, seller or buyer from its first row (row ${h.rowNo})`)
        }
      }
      if (errs.length) { problems.push(`row ${rowNo}: ${errs.join('; ')}`); return }

      if (!byInvoice.has(invNo)) {
        byInvoice.set(invNo, { head: { rowNo, date: date!, supTyp, regRev: /^y/i.test(at(r, cRev)) ? 'Y' : 'N', docTyp, seller, buyer }, items: [] })
      }
      const entry = byInvoice.get(invNo)!
      entry.items.push({
        SlNo: String(entry.items.length + 1),
        PrdDesc: at(r, cItemDesc) || undefined,
        IsServc: isServc ? 'Y' : 'N',
        HsnCd: hsn,
        Qty: qty ?? undefined,
        Unit: unit || undefined,
        UnitPrice: unitPrice!,
        TotAmt: round2(taxable!),
        AssAmt: round2(taxable!),
        GstRt: rate ?? 0,
        IgstAmt: round2(igst), CgstAmt: round2(cgst), SgstAmt: round2(sgst), CesAmt: round2(cess),
        TotItemVal: round2(taxable! + igst + cgst + sgst + cess),
      })
    })

    if (problems.length) {
      throw new ToolError('invalid_options',
        `No e-invoice JSON was written: ${problems.length} ${problems.length === 1 ? 'row has' : 'rows have'} a problem the IRP would reject — ${problems.slice(0, 15).join(' · ')}${problems.length > 15 ? ` · and ${problems.length - 15} more` : ''}. Fix the sheet and run it again.`,
        { problems })
    }

    const out = [...byInvoice.entries()].map(([invNo, { head: h, items }]) => {
      const sum = (k: keyof Item) => round2(items.reduce((s, it) => s + (Number(it[k]) || 0), 0))
      const assVal = sum('AssAmt')
      const igstVal = sum('IgstAmt'); const cgstVal = sum('CgstAmt'); const sgstVal = sum('SgstAmt'); const cessVal = sum('CesAmt')
      return {
        Version: '1.1',
        TranDtls: { TaxSch: 'GST', SupTyp: h.supTyp, RegRev: h.regRev, IgstOnIntra: 'N' },
        DocDtls: { Typ: h.docTyp, No: invNo, Dt: h.date },
        SellerDtls: h.seller,
        BuyerDtls: h.buyer,
        ItemList: items,
        ValDtls: {
          AssVal: assVal, IgstVal: igstVal, CgstVal: cgstVal, SgstVal: sgstVal, CesVal: cessVal,
          TotInvVal: round2(assVal + igstVal + cgstVal + sgstVal + cessVal),
        },
      }
    })

    const totalValue = round2(out.reduce((s, o) => s + o.ValDtls.TotInvVal, 0))
    const items = out.reduce((n, o) => n + o.ItemList.length, 0)
    return {
      bytes: Buffer.from(JSON.stringify(out, null, 2), 'utf8'),
      invoices: out.length, items, skipped: 0, totalValue,
    }
  },
}
