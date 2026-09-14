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

export const ComplianceService = {
  /** JSON → workbook. One sheet per section present, plus Summary. */
  async gstJsonToExcel(bytes: Buffer): Promise<{ bytes: Buffer; sections: string[]; invoices: number; rows: number }> {
    let doc: Record<string, unknown>
    try {
      doc = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
    } catch {
      throw new ToolError('unreadable', "This file isn't valid JSON. Export it again from the GST offline utility.")
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
        { header: meta.party, key: 'party', width: 20 },
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

  // ── 5. TDS Text / FVU generator ────────────────────────────────────────

  /**
   * The NSDL return text file is `^`-delimited, one line per record, in a
   * fixed order: FH (file header), BH (batch header), CD (challan), DD
   * (deductee). Line 1 of each record is its running number, line 2 its
   * type. This builds that structure from a deductee sheet, grouping rows
   * into challans by (BSR code, challan serial, challan date).
   *
   * It is deliberately NOT called a validated FVU: the .fvu extension is
   * produced by NSDL's own File Validation Utility. This is the input text
   * file that utility consumes, which is the part a firm cannot assemble by
   * hand. The tool says so on screen rather than implying the file is
   * portal-ready.
   */
  async tdsTextFile(bytes: Buffer, opts: { formType?: string; quarter?: string; fy?: string; tan?: string; deductorName?: string } = {}): Promise<{
    bytes: Buffer; deductees: number; challans: number; skipped: number; totalTds: number; warning?: string
  }> {
    const sheet = await readSheet(bytes)
    const c = requireCols(sheet, {
      pan: ['PAN', 'Deductee PAN', 'PAN of Deductee'],
      name: ['Name', 'Deductee Name', 'Name of Deductee'],
      paid: ['Amount Paid', 'Amount Credited', 'Amount'],
      tds: ['TDS', 'TDS Deducted', 'Tax Deducted'],
    })
    const cSection = col(sheet, 'Section', 'Nature of Payment')
    const cDate = col(sheet, 'Date of Payment', 'Payment Date', 'Date')
    const cDeductDate = col(sheet, 'Date of Deduction', 'Deduction Date')
    const cRate = col(sheet, 'Rate', 'TDS Rate')
    const cBsr = col(sheet, 'BSR Code', 'BSR')
    const cChNo = col(sheet, 'Challan No', 'Challan Serial No', 'Challan Serial')
    const cChDate = col(sheet, 'Challan Date', 'Date of Deposit')

    interface Deductee { pan: string; name: string; section: string; paid: number; tds: number; rate: string; paidOn: string; deductedOn: string }
    const challans = new Map<string, { bsr: string; serial: string; date: string; rows: Deductee[] }>()
    const skipped: SkipNote[] = []
    let totalTds = 0

    sheet.rows.forEach((r, i) => {
      const rowNo = i + 2
      const pan = at(r, c.pan).toUpperCase()
      if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) { skipped.push({ row: rowNo, reason: `"${pan || 'blank'}" is not a valid PAN` }); return }
      const paid = parseAmount(at(r, c.paid))
      const tds = parseAmount(at(r, c.tds))
      if (paid === null) { skipped.push({ row: rowNo, reason: `unreadable amount paid "${at(r, c.paid)}"` }); return }
      if (tds === null) { skipped.push({ row: rowNo, reason: `unreadable TDS "${at(r, c.tds)}"` }); return }

      const bsr = at(r, cBsr)
      const serial = at(r, cChNo)
      const chDate = parseDate(at(r, cChDate)) ?? ''
      const key = `${bsr}|${serial}|${chDate}`
      if (!challans.has(key)) challans.set(key, { bsr, serial, date: chDate, rows: [] })
      challans.get(key)!.rows.push({
        pan, name: at(r, c.name), section: at(r, cSection),
        paid, tds, rate: at(r, cRate),
        paidOn: parseDate(at(r, cDate)) ?? '',
        deductedOn: parseDate(at(r, cDeductDate)) ?? parseDate(at(r, cDate)) ?? '',
      })
      totalTds = round2(totalTds + tds)
    })

    const deductees = [...challans.values()].reduce((n, ch) => n + ch.rows.length, 0)
    if (deductees === 0) {
      throw new ToolError('empty', `No deductee row could be read. ${skipped.length} ${skipped.length === 1 ? 'row was' : 'rows were'} skipped — check the PAN, Amount Paid and TDS columns.`)
    }

    const form = (opts.formType ?? '26Q').toUpperCase()
    const quarter = (opts.quarter ?? 'Q1').toUpperCase()
    const fy = opts.fy ?? ''
    const tan = (opts.tan ?? '').toUpperCase()
    const deductor = opts.deductorName ?? ''

    const L: string[] = []
    let n = 0
    const line = (...f: (string | number)[]) => { n++; L.push([n, ...f].join('^')) }

    // FH — file header. Record count is filled in after the body is built.
    const fhIndex = L.length
    line('FH', 'NSDL', 'r1.0', form, '', '', tan, '', deductor, '', '', '', '')
    // BH — one batch.
    line('BH', 1, form, tan, '', deductor, '', '', fy, quarter, '', '', '', '', '')

    let challanNo = 0
    for (const ch of challans.values()) {
      challanNo++
      const chTds = round2(ch.rows.reduce((s, d) => s + d.tds, 0))
      line('CD', 1, challanNo, '', ch.bsr, ch.date, ch.serial, chTds, 0, 0, chTds, '', '', '')
      ch.rows.forEach((d, i) => {
        line('DD', 1, challanNo, i + 1, '', d.pan, d.name, d.paid, d.tds, d.rate, d.section, d.paidOn, d.deductedOn, '', '')
      })
    }

    // FH carries the total record count in its last field.
    L[fhIndex] = `${L[fhIndex]}^${n}`

    const text = L.join('\n') + '\n'
    return {
      bytes: Buffer.from(text, 'utf8'),
      deductees, challans: challans.size, skipped: skipped.length, totalTds,
      warning: skipped.length
        ? `${deductees} deductee ${deductees === 1 ? 'row' : 'rows'} written. ${skipped.length} ${skipped.length === 1 ? 'row was' : 'rows were'} skipped: ${skipped.slice(0, 3).map((s) => `row ${s.row} (${s.reason})`).join(', ')}${skipped.length > 3 ? ', …' : ''}.`
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
