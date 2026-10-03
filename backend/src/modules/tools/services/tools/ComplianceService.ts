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
import { PDFService, type PageText } from './PDFService.js'
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
  ws.eachRow({ includeEmpty: false }, (row) => {
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
  const rows = matrix.slice(headerAt + 1).filter((r) => r.some((c) => c !== ''))
  if (rows.length === 0) throw new ToolError('empty', 'This sheet has a header but no data rows.')
  return { headers, index, rows, sheetName: ws.name }
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
 * The GSTR-1 offline utility's JSON keeps each section as an array of
 * invoices, every invoice carrying its own line items (`itms`). Analysts
 * read it as flat rows, so each section becomes one sheet with the invoice
 * fields repeated down its item rows — and the same shape rebuilds the JSON
 * on the way back, grouping rows by invoice number again.
 */
const GST_SECTIONS: Record<string, { label: string; key: string; party: string; flat?: boolean }> = {
  b2b: { label: 'B2B', key: 'ctin', party: 'Recipient GSTIN' },
  b2cl: { label: 'B2CL', key: 'pos', party: 'Place of supply' },
  // b2cs carries no invoice wrapper — each entry IS a rate line, so it is
  // rebuilt flat. Wrapping it in `inv` produces JSON the offline utility
  // rejects, which is invisible until upload.
  b2cs: { label: 'B2CS', key: 'pos', party: 'Place of supply', flat: true },
  cdnr: { label: 'CDNR', key: 'ctin', party: 'Recipient GSTIN' },
  cdnur: { label: 'CDNUR', key: 'pos', party: 'Place of supply' },
  exp: { label: 'EXP', key: 'exp_typ', party: 'Export type' },
}

/**
 * GSTR-2B (the portal's ITC download) nests its sections under
 * `data.docdata` and spells the fields differently — `dt`/`ntnum`/`rev`,
 * and tax amounts on the invoice itself (or in `items[]`) rather than in
 * `itms[].itm_det`. Reshape it into the GSTR-1 layout so one flattener
 * serves both; returns null when the file is not a 2B.
 */
function gstr2bAsGstr1(doc: Record<string, unknown>): Record<string, unknown> | null {
  const data = doc.data as Record<string, unknown> | undefined
  const docdata = data?.docdata as Record<string, Record<string, unknown>[]> | undefined
  if (!docdata || typeof docdata !== 'object') return null
  const lines = (inv: Record<string, unknown>) =>
    (Array.isArray(inv.items) && inv.items.length ? inv.items as Record<string, unknown>[] : [inv]).map((d) => ({
      itm_det: { rt: d.rt, txval: d.txval, iamt: d.igst, camt: d.cgst, samt: d.sgst, csamt: d.cess },
    }))
  const out: Record<string, unknown> = { gstin: data!.gstin, fp: data!.rtnprd, version: data!.version }
  if (Array.isArray(docdata.b2b)) {
    out.b2b = docdata.b2b.map((g) => ({
      ctin: g.ctin,
      inv: ((g.inv ?? []) as Record<string, unknown>[]).map((i) => ({
        inum: i.inum, idt: i.dt, val: i.val, pos: i.pos, rchrg: i.rev, itms: lines(i),
      })),
    }))
  }
  if (Array.isArray(docdata.cdnr)) {
    out.cdnr = docdata.cdnr.map((g) => ({
      ctin: g.ctin,
      nt: ((g.nt ?? []) as Record<string, unknown>[]).map((n) => ({
        nt_num: n.ntnum, nt_dt: n.dt, val: n.val, pos: n.pos, rchrg: n.rev, itms: lines(n),
      })),
    }))
  }
  return out
}

/** Whether a parsed JSON carries any top-level GSTR-1 section. */
const GST_SECTIONS_PRESENT = (doc: Record<string, unknown>) =>
  Object.keys(GST_SECTIONS).some((s) => Array.isArray(doc[s]) && (doc[s] as unknown[]).length > 0)

interface GstFlatRow {
  section: string
  party: string
  invoiceNo: string
  invoiceDate: string
  invoiceValue: string
  pos: string
  reverseCharge: string
  rate: string
  taxableValue: string
  igst: string
  cgst: string
  sgst: string
  cess: string
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

export const ComplianceService = {
  /** JSON → workbook. One sheet per section present, plus Summary. */
  async gstJsonToExcel(bytes: Buffer): Promise<{ bytes: Buffer; sections: string[]; invoices: number; rows: number }> {
    let doc: Record<string, unknown>
    try {
      doc = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
    } catch {
      throw new ToolError('unreadable', "This file isn't valid JSON. Export it again from the GST offline utility.")
    }
    const from2b = gstr2bAsGstr1(doc)
    if (from2b) doc = from2b
    const wb = newBook()
    const sections: string[] = []
    let invoices = 0
    let rows = 0

    const summary = wb.addWorksheet('Summary')
    summary.columns = [
      { header: 'Field', key: 'k', width: 24 },
      { header: 'Value', key: 'v', width: 34 },
    ]
    for (const [k, label] of [['gstin', 'GSTIN'], ['fp', 'Return period'], ['gt', 'Gross turnover'], ['cur_gt', 'Current turnover'], ['version', 'Version']] as const) {
      if (doc[k] !== undefined) summary.addRow({ k: label, v: String(doc[k]) })
    }

    for (const [sec, meta] of Object.entries(GST_SECTIONS)) {
      const raw = doc[sec]
      if (!Array.isArray(raw) || raw.length === 0) continue
      sections.push(meta.label)
      const flat: GstFlatRow[] = []

      for (const group of raw as Record<string, unknown>[]) {
        const party = String(group[meta.key] ?? '')
        // b2cs has no invoice wrapper — the group IS the rate line.
        const invList = Array.isArray(group.inv) ? group.inv as Record<string, unknown>[]
          : Array.isArray(group.nt) ? group.nt as Record<string, unknown>[]
          : [group]
        for (const inv of invList) {
          invoices++
          const itms = Array.isArray(inv.itms) ? inv.itms as Record<string, unknown>[] : [inv]
          for (const itm of itms) {
            const d = (itm.itm_det ?? itm) as Record<string, unknown>
            flat.push({
              section: meta.label,
              party,
              invoiceNo: String(inv.inum ?? inv.nt_num ?? ''),
              invoiceDate: String(inv.idt ?? inv.nt_dt ?? ''),
              invoiceValue: inv.val !== undefined ? String(inv.val) : '',
              pos: String(inv.pos ?? group.pos ?? ''),
              reverseCharge: String(inv.rchrg ?? ''),
              rate: d.rt !== undefined ? String(d.rt) : '',
              taxableValue: d.txval !== undefined ? String(d.txval) : '',
              igst: d.iamt !== undefined ? String(d.iamt) : '',
              cgst: d.camt !== undefined ? String(d.camt) : '',
              sgst: d.samt !== undefined ? String(d.samt) : '',
              cess: d.csamt !== undefined ? String(d.csamt) : '',
            })
            rows++
          }
        }
      }

      const ws = wb.addWorksheet(meta.label)
      ws.columns = [
        { header: from2b && meta.key === 'ctin' ? 'Supplier GSTIN' : meta.party, key: 'party', width: 20 },
        { header: 'Invoice No', key: 'invoiceNo', width: 16 },
        { header: 'Invoice Date', key: 'invoiceDate', width: 14 },
        { header: 'Invoice Value', key: 'invoiceValue', width: 14 },
        { header: 'Place of Supply', key: 'pos', width: 14 },
        { header: 'Reverse Charge', key: 'reverseCharge', width: 14 },
        { header: 'Rate', key: 'rate', width: 8 },
        { header: 'Taxable Value', key: 'taxableValue', width: 14 },
        { header: 'IGST', key: 'igst', width: 12 },
        { header: 'CGST', key: 'cgst', width: 12 },
        { header: 'SGST', key: 'sgst', width: 12 },
        { header: 'Cess', key: 'cess', width: 12 },
      ]
      flat.forEach((r) => ws.addRow(r))
      autoWidth(ws)
    }

    if (sections.length === 0) {
      throw new ToolError('empty', 'No GSTR sections (b2b, b2cl, b2cs, cdnr, cdnur, exp) were found in this JSON.')
    }
    summary.addRow({ k: 'Sections', v: sections.join(', ') })
    summary.addRow({ k: 'Invoices', v: String(invoices) })
    summary.addRow({ k: 'Line rows', v: String(rows) })
    autoWidth(summary)
    return { bytes: Buffer.from(await wb.xlsx.writeBuffer()), sections, invoices, rows }
  },

  /** Workbook → GSTR-1 JSON. Reverses gstJsonToExcel sheet for sheet. */
  async gstExcelToJson(bytes: Buffer): Promise<{ bytes: Buffer; sections: string[]; invoices: number; rows: number }> {
    const wb = new ExcelJS.Workbook()
    try {
      await wb.xlsx.load(bytes as unknown as ArrayBuffer)
    } catch {
      throw new ToolError('unreadable', "We couldn't open this spreadsheet. It may be corrupted or not a real Excel file.")
    }
    const out: Record<string, unknown> = { version: 'GST3.1.6', hash: 'hash' }
    const summary = wb.getWorksheet('Summary')
    if (summary) {
      summary.eachRow((row) => {
        const k = norm(cellText(row.getCell(1).value))
        const v = cellText(row.getCell(2).value).trim()
        if (!v) return
        if (k === 'gstin') out.gstin = v
        if (k === 'returnperiod') out.fp = v
        if (k === 'grossturnover') out.gt = Number(v) || v
        if (k === 'currentturnover') out.cur_gt = Number(v) || v
      })
    }

    const sections: string[] = []
    let invoices = 0
    let rows = 0

    for (const [sec, meta] of Object.entries(GST_SECTIONS)) {
      const ws = wb.getWorksheet(meta.label)
      if (!ws) continue
      // Re-read through the shared reader so header matching is identical.
      const sub = newBook()
      const copy = sub.addWorksheet(meta.label)
      ws.eachRow({ includeEmpty: false }, (row) => {
        copy.addRow(row.values as ExcelJS.CellValue[])
      })
      let sheet: SheetRows
      try {
        sheet = await readSheet(Buffer.from(await sub.xlsx.writeBuffer()), meta.label)
      } catch {
        continue
      }

      const c = {
        party: col(sheet, meta.party, 'ctin', 'gstin', 'pos'),
        inum: col(sheet, 'Invoice No', 'invoice number', 'inum', 'note no'),
        idt: col(sheet, 'Invoice Date', 'idt', 'note date'),
        val: col(sheet, 'Invoice Value', 'val'),
        pos: col(sheet, 'Place of Supply', 'pos'),
        rchrg: col(sheet, 'Reverse Charge', 'rchrg'),
        rt: col(sheet, 'Rate', 'rt'),
        txval: col(sheet, 'Taxable Value', 'txval'),
        iamt: col(sheet, 'IGST', 'iamt'),
        camt: col(sheet, 'CGST', 'camt'),
        samt: col(sheet, 'SGST', 'samt'),
        csamt: col(sheet, 'Cess', 'csamt'),
      }

      if (meta.flat) {
        const lines: Record<string, unknown>[] = []
        for (const r of sheet.rows) {
          const line: Record<string, unknown> = { pos: at(r, c.pos) || at(r, c.party), typ: 'OE' }
          for (const [k, i] of [['rt', c.rt], ['txval', c.txval], ['iamt', c.iamt], ['camt', c.camt], ['samt', c.samt], ['csamt', c.csamt]] as const) {
            const v = parseAmount(at(r, i))
            if (v !== null) line[k] = v
          }
          // INTER when the tax is IGST, INTRA when it is split CGST/SGST.
          line.sply_ty = line.iamt !== undefined && line.camt === undefined ? 'INTER' : 'INTRA'
          lines.push(line)
          rows++
          invoices++
        }
        if (lines.length) { out[sec] = lines; sections.push(meta.label) }
        continue
      }

      // party → invoice no → line items, preserving first-seen order.
      const byParty = new Map<string, Map<string, { inv: Record<string, unknown>; itms: Record<string, unknown>[] }>>()
      for (const r of sheet.rows) {
        const party = at(r, c.party)
        const inum = at(r, c.inum)
        if (!byParty.has(party)) byParty.set(party, new Map())
        const invs = byParty.get(party)!
        if (!invs.has(inum)) {
          invs.set(inum, {
            inv: {
              inum,
              idt: at(r, c.idt),
              val: parseAmount(at(r, c.val)) ?? undefined,
              pos: at(r, c.pos) || undefined,
              rchrg: at(r, c.rchrg) || undefined,
            },
            itms: [],
          })
          invoices++
        }
        const entry = invs.get(inum)!
        const det: Record<string, unknown> = {}
        for (const [k, i] of [['rt', c.rt], ['txval', c.txval], ['iamt', c.iamt], ['camt', c.camt], ['samt', c.samt], ['csamt', c.csamt]] as const) {
          const n = parseAmount(at(r, i))
          if (n !== null) det[k] = n
        }
        entry.itms.push({ num: entry.itms.length + 1, itm_det: det })
        rows++
      }

      const groups: Record<string, unknown>[] = []
      for (const [party, invs] of byParty) {
        const invArr = [...invs.values()].map((e) => {
          const inv: Record<string, unknown> = { ...e.inv, itms: e.itms }
          for (const k of Object.keys(inv)) if (inv[k] === undefined || inv[k] === '') delete inv[k]
          return inv
        })
        groups.push({ [meta.key]: party, inv: invArr })
      }
      if (groups.length) { out[sec] = groups; sections.push(meta.label) }
    }

    if (sections.length === 0) {
      throw new ToolError('empty', 'No sheet named B2B, B2CL, B2CS, CDNR, CDNUR or EXP was found in this workbook.')
    }
    return { bytes: Buffer.from(JSON.stringify(out, null, 2), 'utf8'), sections, invoices, rows }
  },

  // ── 2. Bank statement (PDF) → Excel ────────────────────────────────────

  /**
   * Bank PDFs share no layout, so this reads structurally rather than per
   * bank: a transaction line starts with a date and ends with one to three
   * money columns. The right-most is the running balance when it tracks the
   * previous balance; what remains is debit/credit, assigned by whether the
   * balance went down or up. When the balance column is absent the two
   * amounts are read in column order.
   */
  async bankStatementToExcel(bytes: Buffer, onProgress?: (pct: number) => void): Promise<{
    bytes: Buffer; transactions: number; pageCount: number; skipped: number
    opening: number | null; closing: number | null; totalDebit: number; totalCredit: number; balanced: boolean
  }> {
    const pages: PageText[] = await PDFService.extractText(bytes, (d, t) => onProgress?.((d / t) * 60))
    if (!PDFService.hasTextLayer(pages)) {
      throw new ToolError('no_text_layer', 'This statement is a scan with no text layer. Run OCR Scan on it first, then try again.')
    }

    interface Txn { page: number; date: string; narration: string; ref: string; debit: number | null; credit: number | null; balance: number | null }
    const txns: Txn[] = []
    const skipped: SkipNote[] = []
    let prevBalance: number | null = null
    let opening: number | null = null

    for (const page of pages) {
      for (const line of page.lines) {
        const cells = line.cells.map((c) => c.text.trim()).filter((t) => t !== '')
        if (cells.length < 2) continue
        const joined = cells.join(' ')
        // An opening / brought-forward line carries a date and one amount,
        // and looks exactly like a transaction. Treated as one it becomes a
        // phantom debit AND leaves the running balance unseeded, which then
        // mis-splits every two-column row after it — so it is matched first,
        // whether or not it is dated.
        if (/\b(opening\s+balance|balance\s+b\/?f|brought\s+forward|b\/f)\b/i.test(joined)) {
          const amounts = cells.map(parseAmount).filter((v): v is number => v !== null)
          if (amounts.length) { opening = amounts[amounts.length - 1]; prevBalance = opening }
          continue
        }
        // A closing / carried-forward line is a total, not a transaction.
        if (/\b(closing\s+balance|balance\s+c\/?f|carried\s+forward|c\/f)\b/i.test(joined)) continue

        const date = parseDate(cells[0])
        if (!date) continue

        // Trailing money columns.
        const money: number[] = []
        let i = cells.length - 1
        while (i > 0 && money.length < 3) {
          const n = parseAmount(cells[i])
          if (n === null) break
          money.unshift(n)
          i--
        }
        if (money.length === 0) {
          skipped.push({ row: page.page, reason: `page ${page.page}: a dated line with no amount — "${cells.join(' ').slice(0, 60)}"` })
          continue
        }

        const middle = cells.slice(1, i + 1)
        const ref = middle.find((t) => /^[A-Z0-9/-]{6,}$/.test(t) && /\d/.test(t)) ?? ''
        const narration = middle.filter((t) => t !== ref).join(' ').trim()

        let debit: number | null = null
        let credit: number | null = null
        let balance: number | null = null

        if (money.length === 3) {
          debit = money[0] || null; credit = money[1] || null; balance = money[2]
        } else if (money.length === 2) {
          // Is the last column a running balance?
          const delta = prevBalance === null ? null : round2(money[1] - prevBalance)
          if (delta !== null && Math.abs(Math.abs(delta) - money[0]) < 0.02) {
            balance = money[1]
            if (delta < 0) debit = money[0]; else credit = money[0]
          } else {
            debit = money[0] || null; credit = money[1] || null
          }
        } else {
          // A single amount with no balance: direction from the narration.
          if (/\b(cr|credit|deposit|by )\b/i.test(narration)) credit = money[0]
          else debit = money[0]
        }

        if (balance !== null) prevBalance = balance
        if (opening === null && balance !== null) {
          opening = round2(balance - (credit ?? 0) + (debit ?? 0))
        }
        txns.push({ page: page.page, date, narration, ref, debit, credit, balance })
      }
      onProgress?.(60 + (page.page / pages.length) * 30)
    }

    if (txns.length === 0) {
      throw new ToolError('no_tables', 'No transaction rows were found. This may not be a bank statement, or its layout puts the date somewhere other than the first column.')
    }

    const totalDebit = round2(txns.reduce((s, t) => s + (t.debit ?? 0), 0))
    const totalCredit = round2(txns.reduce((s, t) => s + (t.credit ?? 0), 0))
    const closing = txns[txns.length - 1].balance
    const balanced = opening !== null && closing !== null
      && Math.abs(round2(opening + totalCredit - totalDebit) - closing) < 0.05

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
    sum.addRow({ k: 'Opening + credits − debits ties to closing', v: balanced ? 'Yes' : 'Not verified' })
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
   * TRACES exports 26AS as a PDF or a caret-delimited text file. Part A
   * (TDS from deductors) is the part firms reconcile, so its transaction
   * rows are lifted with the deductor they sit under; the text export is
   * parsed by its `^` fields, the PDF by the same date-led line shape the
   * bank reader uses.
   */
  async form26asToExcel(bytes: Buffer, isText: boolean, onProgress?: (pct: number) => void): Promise<{
    bytes: Buffer; rows: number; deductors: number; totalCredited: number; totalTds: number; skipped: number
  }> {
    interface Row { deductor: string; tan: string; section: string; date: string; status: string; credited: number | null; tds: number | null }
    const rows: Row[] = []
    const skipped: SkipNote[] = []
    let deductor = ''
    let tan = ''

    if (isText) {
      const text = bytes.toString('utf8')
      if (!text.trim()) throw new ToolError('empty', 'This file is empty.')
      const lines = text.split(/\r?\n/)
      lines.forEach((line, n) => {
        if (!line.includes('^')) return
        const f = line.split('^').map((s) => s.trim())
        // A deductor header carries a TAN in its second or third field.
        const tanAt = f.findIndex((v) => /^[A-Z]{4}\d{5}[A-Z]$/.test(v))
        if (tanAt > 0 && !parseDate(f[tanAt + 1] ?? '')) {
          deductor = f[tanAt - 1] || f[1] || deductor
          tan = f[tanAt]
          return
        }
        const dateAt = f.findIndex((v) => parseDate(v) !== null)
        if (dateAt < 0) return
        const nums = f.map(parseAmount)
        const money = nums.filter((v): v is number => v !== null)
        if (money.length < 2) { skipped.push({ row: n + 1, reason: 'a dated line with fewer than two amounts' }); return }
        rows.push({
          deductor, tan,
          section: f.find((v) => /^19[0-9A-Z]{1,3}$|^194[A-Z]{0,2}$/.test(v)) ?? '',
          date: parseDate(f[dateAt])!,
          status: f.find((v) => /^[FUOP]$/.test(v)) ?? '',
          credited: money[money.length - 2] ?? null,
          tds: money[money.length - 1] ?? null,
        })
      })
      onProgress?.(70)
    } else {
      const pages = await PDFService.extractText(bytes, (d, t) => onProgress?.((d / t) * 60))
      if (!PDFService.hasTextLayer(pages)) {
        throw new ToolError('no_text_layer', 'This 26AS is a scan with no text layer. Download the text version from TRACES, or run OCR Scan first.')
      }
      for (const page of pages) {
        for (const line of page.lines) {
          const cells = line.cells.map((c) => c.text.trim()).filter((t) => t !== '')
          if (cells.length === 0) continue
          const joined = cells.join(' ')
          const tanMatch = joined.match(/\b([A-Z]{4}\d{5}[A-Z])\b/)
          if (tanMatch && !parseDate(cells[0])) {
            tan = tanMatch[1]
            deductor = joined.split(tanMatch[1])[0].replace(/^\d+\s*/, '').trim() || deductor
            continue
          }
          if (!parseDate(cells[0]) && !/^\d+$/.test(cells[0])) continue
          const dateCell = cells.find((c) => parseDate(c) !== null)
          if (!dateCell) continue
          const money = cells.map(parseAmount).filter((v): v is number => v !== null)
          if (money.length < 2) { skipped.push({ row: page.page, reason: `page ${page.page}: a dated line with fewer than two amounts` }); continue }
          rows.push({
            deductor, tan,
            section: cells.find((c) => /^19[0-9A-Z]{1,3}$|^194[A-Z]{0,2}$/.test(c)) ?? '',
            date: parseDate(dateCell)!,
            status: cells.find((c) => /^[FUOP]$/.test(c)) ?? '',
            credited: money[money.length - 2] ?? null,
            tds: money[money.length - 1] ?? null,
          })
        }
        onProgress?.(60 + (page.page / pages.length) * 25)
      }
    }

    if (rows.length === 0) {
      throw new ToolError('no_tables', 'No Part A transaction rows were found. Check this is a Form 26AS export and not another TRACES statement.')
    }

    const totalCredited = round2(rows.reduce((s, r) => s + (r.credited ?? 0), 0))
    const totalTds = round2(rows.reduce((s, r) => s + (r.tds ?? 0), 0))
    const deductors = new Set(rows.map((r) => r.tan || r.deductor)).size

    const wb = newBook()
    const ws = wb.addWorksheet('Part A - TDS')
    ws.columns = [
      { header: 'Deductor', key: 'deductor', width: 40 },
      { header: 'TAN', key: 'tan', width: 14 },
      { header: 'Section', key: 'section', width: 10 },
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Status', key: 'status', width: 8 },
      { header: 'Amount Credited', key: 'credited', width: 18 },
      { header: 'TDS Deducted', key: 'tds', width: 16 },
    ]
    rows.forEach((r) => ws.addRow(r))
    ;['F', 'G'].forEach((c) => { ws.getColumn(c).numFmt = '#,##0.00' })
    autoWidth(ws)

    // Per-deductor totals — the sheet the reconciliation actually uses.
    const byTan = new Map<string, { deductor: string; tan: string; credited: number; tds: number; count: number }>()
    for (const r of rows) {
      const k = r.tan || r.deductor
      const e = byTan.get(k) ?? { deductor: r.deductor, tan: r.tan, credited: 0, tds: 0, count: 0 }
      e.credited = round2(e.credited + (r.credited ?? 0))
      e.tds = round2(e.tds + (r.tds ?? 0))
      e.count++
      byTan.set(k, e)
    }
    const bd = wb.addWorksheet('By Deductor')
    bd.columns = [
      { header: 'Deductor', key: 'deductor', width: 40 },
      { header: 'TAN', key: 'tan', width: 14 },
      { header: 'Entries', key: 'count', width: 10 },
      { header: 'Amount Credited', key: 'credited', width: 18 },
      { header: 'TDS Deducted', key: 'tds', width: 16 },
    ]
    ;[...byTan.values()].forEach((e) => bd.addRow(e))
    bd.addRow({ deductor: 'Total', tan: '', count: rows.length, credited: totalCredited, tds: totalTds }).font = { bold: true }
    ;['D', 'E'].forEach((c) => { bd.getColumn(c).numFmt = '#,##0.00' })
    autoWidth(bd)
    addSkippedSheet(wb, skipped)

    return { bytes: Buffer.from(await wb.xlsx.writeBuffer()), rows: rows.length, deductors, totalCredited, totalTds, skipped: skipped.length }
  },

  // ── 4. Excel → Tally XML ───────────────────────────────────────────────

  /**
   * Tally imports a `TALLYMESSAGE` per voucher inside an `ENVELOPE` with
   * `VCHTYPE`/`ACTION` headers. Each voucher gets exactly two ledger
   * entries — party and the nominal account — because a two-sided voucher is
   * what a one-row-per-transaction sheet can honestly describe. Tally's sign
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
      const rowNo = i + 2
      const date = parseDate(at(r, c.date))
      if (!date) { skipped.push({ row: rowNo, reason: `unreadable date "${at(r, c.date)}"` }); return }
      const amount = parseAmount(at(r, c.amount))
      if (amount === null) { skipped.push({ row: rowNo, reason: `unreadable amount "${at(r, c.amount)}"` }); return }
      const party = at(r, c.party)
      if (!party) { skipped.push({ row: rowNo, reason: 'no party ledger' }); return }

      const vchType = at(r, cType) || 'Journal'
      types.add(vchType)
      const against = at(r, cAgainst) || (/(sales|receipt)/i.test(vchType) ? 'Sales' : /purchase|payment/i.test(vchType) ? 'Purchase' : 'Suspense A/c')
      // Dr/Cr describes the PARTY side. Default: the party is debited on a
      // sale, credited on a purchase — the ordinary direction for each.
      const drcr = at(r, cDrCr).toLowerCase()
      const partyIsDebit = drcr ? drcr.startsWith('d') : !/purchase|payment/i.test(vchType)
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
   * ItemList. ValDtls is summed from the items rather than read from the
   * sheet, so the totals always tie to the lines the IRP will see — a
   * mismatch there is the single most common rejection.
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
    const cSellerName = g('Seller Name', 'Supplier Name'); const cSellerAddr = g('Seller Address', 'Supplier Address')
    const cSellerLoc = g('Seller City', 'Seller Location', 'Supplier City'); const cSellerPin = g('Seller Pincode', 'Supplier Pincode')
    const cSellerState = g('Seller State Code', 'Supplier State Code', 'Seller State')
    const cBuyerName = g('Buyer Name', 'Recipient Name'); const cBuyerAddr = g('Buyer Address', 'Recipient Address')
    const cBuyerLoc = g('Buyer City', 'Buyer Location'); const cBuyerPin = g('Buyer Pincode')
    const cBuyerState = g('Buyer State Code', 'Buyer State'); const cPos = g('Place of Supply', 'POS')
    const cItemDesc = g('Item Description', 'Description', 'Product'); const cHsn = g('HSN', 'HSN Code', 'HSN/SAC')
    const cQty = g('Quantity', 'Qty'); const cUnit = g('Unit', 'UQC', 'UOM'); const cRate = g('Unit Price', 'Rate', 'Price')
    const cGstRate = g('GST Rate', 'Tax Rate', 'Rate %')
    const cIgst = g('IGST', 'IGST Amount'); const cCgst = g('CGST', 'CGST Amount'); const cSgst = g('SGST', 'SGST Amount')
    const cCess = g('Cess', 'Cess Amount'); const cDocType = g('Document Type', 'Doc Type')

    interface Item { SlNo: string; PrdDesc?: string; IsServc: string; HsnCd: string; Qty?: number; Unit?: string; UnitPrice?: number; TotAmt: number; AssAmt: number; GstRt: number; IgstAmt: number; CgstAmt: number; SgstAmt: number; CesAmt: number; TotItemVal: number }
    const byInvoice = new Map<string, { row: string[]; items: Item[] }>()
    const skipped: SkipNote[] = []

    sheet.rows.forEach((r, i) => {
      const rowNo = i + 2
      const invNo = at(r, c.invNo)
      if (!invNo) { skipped.push({ row: rowNo, reason: 'no invoice number' }); return }
      const date = parseDate(at(r, c.invDate))
      if (!date) { skipped.push({ row: rowNo, reason: `unreadable invoice date "${at(r, c.invDate)}"` }); return }
      const taxable = parseAmount(at(r, c.taxable))
      if (taxable === null) { skipped.push({ row: rowNo, reason: `unreadable taxable value "${at(r, c.taxable)}"` }); return }
      const seller = at(r, c.sellerGstin).toUpperCase()
      if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(seller)) {
        skipped.push({ row: rowNo, reason: `"${seller || 'blank'}" is not a valid seller GSTIN` }); return
      }

      if (!byInvoice.has(invNo)) byInvoice.set(invNo, { row: r, items: [] })
      const entry = byInvoice.get(invNo)!
      const igst = parseAmount(at(r, cIgst)) ?? 0
      const cgst = parseAmount(at(r, cCgst)) ?? 0
      const sgst = parseAmount(at(r, cSgst)) ?? 0
      const cess = parseAmount(at(r, cCess)) ?? 0
      const qty = parseAmount(at(r, cQty))
      const rate = parseAmount(at(r, cRate))
      entry.items.push({
        SlNo: String(entry.items.length + 1),
        PrdDesc: at(r, cItemDesc) || undefined,
        IsServc: at(r, cHsn).startsWith('99') ? 'Y' : 'N',
        HsnCd: at(r, cHsn),
        Qty: qty ?? undefined,
        Unit: at(r, cUnit) || undefined,
        UnitPrice: rate ?? undefined,
        TotAmt: round2(taxable),
        AssAmt: round2(taxable),
        GstRt: parseAmount(at(r, cGstRate)) ?? 0,
        IgstAmt: round2(igst), CgstAmt: round2(cgst), SgstAmt: round2(sgst), CesAmt: round2(cess),
        TotItemVal: round2(taxable + igst + cgst + sgst + cess),
      })
    })

    if (byInvoice.size === 0) {
      throw new ToolError('empty', `No invoice could be built. ${skipped.length} ${skipped.length === 1 ? 'row was' : 'rows were'} skipped — check the Invoice No, Invoice Date, Seller GSTIN and Taxable Value columns.`)
    }

    const stateOf = (gstin: string) => gstin.slice(0, 2)
    const out = [...byInvoice.entries()].map(([invNo, { row: r, items }]) => {
      const seller = at(r, c.sellerGstin).toUpperCase()
      const buyer = at(r, c.buyerGstin).toUpperCase()
      const sum = (k: keyof Item) => round2(items.reduce((s, it) => s + (Number(it[k]) || 0), 0))
      const assVal = sum('AssAmt')
      const igstVal = sum('IgstAmt'); const cgstVal = sum('CgstAmt'); const sgstVal = sum('SgstAmt'); const cessVal = sum('CesAmt')
      return {
        Version: '1.1',
        TranDtls: { TaxSch: 'GST', SupTyp: buyer ? 'B2B' : 'B2C', RegRev: 'N', IgstOnIntra: 'N' },
        DocDtls: { Typ: (at(r, cDocType) || 'INV').toUpperCase(), No: invNo, Dt: parseDate(at(r, c.invDate))! },
        SellerDtls: {
          Gstin: seller,
          LglNm: at(r, cSellerName) || undefined,
          Addr1: at(r, cSellerAddr) || undefined,
          Loc: at(r, cSellerLoc) || undefined,
          Pin: parseAmount(at(r, cSellerPin)) ?? undefined,
          Stcd: at(r, cSellerState) || stateOf(seller),
        },
        BuyerDtls: {
          Gstin: buyer || 'URP',
          LglNm: at(r, cBuyerName) || undefined,
          Addr1: at(r, cBuyerAddr) || undefined,
          Loc: at(r, cBuyerLoc) || undefined,
          Pin: parseAmount(at(r, cBuyerPin)) ?? undefined,
          Pos: at(r, cPos) || (buyer ? stateOf(buyer) : undefined),
          Stcd: at(r, cBuyerState) || (buyer ? stateOf(buyer) : undefined),
        },
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
      invoices: out.length, items, skipped: skipped.length, totalValue,
      warning: skipped.length
        ? `${out.length} ${out.length === 1 ? 'invoice' : 'invoices'} built from ${items} line ${items === 1 ? 'item' : 'items'}. ${skipped.length} ${skipped.length === 1 ? 'row was' : 'rows were'} skipped: ${skipped.slice(0, 3).map((s) => `row ${s.row} (${s.reason})`).join(', ')}${skipped.length > 3 ? ', …' : ''}.`
        : undefined,
    }
  },
}
