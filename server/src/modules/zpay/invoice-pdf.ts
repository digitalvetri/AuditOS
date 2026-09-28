/**
 * Invoices out of a PDF, as the same string matrix parseCsv returns — so a
 * PDF imports under exactly the CSV rules (invoice_number, issued_on,
 * amount required; due_date optional).
 *
 * Two shapes are read:
 *   • a register / list — a table whose header names the invoice number,
 *     date and amount columns; one row per invoice;
 *   • invoices themselves — one per page (a single invoice, or several
 *     combined into one file): "Invoice No / # : …", "Invoice Date : …",
 *     "Total ₹…".
 *
 * Nothing is guessed: an invoice without all three of number, date and
 * amount is left out and reported, never imported half-read.
 */
import { ApiError } from '../../lib/http.js'
import { PDFService, type PageText } from '../tools/services/tools/PDFService.js'

export interface PdfInvoices {
  rows: string[][]
  /** What was left out, and why — shown to the user. */
  skipped: string[]
  source: 'register' | 'invoices'
}

const HEADER = ['invoice_number', 'issued_on', 'amount', 'due_date']

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DATE_RE = /(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\s-](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s,-]+\d{2,4})/i
const MONEY_RE = /(?:₹|rs\.?|inr)?\s*(-?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)(?![\d/-])/gi

/** A date as the importer takes it: DD-MM-YYYY, or YYYY-MM-DD as given. */
function normDate(raw: string): string | null {
  const s = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/)
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3]
    return `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}-${y}`
  }
  m = s.match(/^(\d{1,2})[\s-]([a-z]{3})[a-z]*[\s,-]+(\d{2,4})$/i)
  if (m) {
    const mo = MONTHS.indexOf(m[2].toLowerCase()) + 1
    if (!mo) return null
    const y = m[3].length === 2 ? `20${m[3]}` : m[3]
    return `${m[1].padStart(2, '0')}-${String(mo).padStart(2, '0')}-${y}`
  }
  return null
}

/** The last money figure in a piece of text, as a plain decimal string. */
function lastMoney(text: string): string | null {
  const found = [...text.matchAll(MONEY_RE)].map((m) => m[1]).filter((v) => /\d/.test(v))
  if (!found.length) return null
  return found[found.length - 1].replace(/,/g, '')
}

const lineText = (l: PageText['lines'][number]) => l.cells.map((c) => c.text.trim()).filter(Boolean).join(' ')

// ── register / list ────────────────────────────────────────────────────

const isNumberHead = (h: string) => /^(invoice|inv|bill)\s*(no|number|#|num)\.?$|^(invoice|bill)$|^#$|^voucher\s*no\.?$/i.test(h)
const isDateHead = (h: string) => /^(invoice\s*)?date$|^(issued?|issue)\s*(on|date)?$|^bill\s*date$/i.test(h)
const isAmountHead = (h: string) => /^(amount|total|invoice\s*(amount|total|value)|grand\s*total|net\s*amount|value)(\s*\(.*\))?$/i.test(h)
const isDueHead = (h: string) => /^due(\s*date|\s*on)?$/i.test(h)

function fromRegister(pages: PageText[]): PdfInvoices | null {
  const rows: string[][] = [HEADER]
  const skipped: string[] = []
  let found = false
  for (const page of pages) {
    for (const table of PDFService.detectTables(page)) {
      const hi = table.findIndex((r) => r.some((c) => isNumberHead(c.trim())) && r.some((c) => isDateHead(c.trim())) && r.some((c) => isAmountHead(c.trim())))
      if (hi < 0) continue
      found = true
      const head = table[hi].map((c) => c.trim())
      const col = { no: head.findIndex(isNumberHead), date: head.findIndex(isDateHead), amt: head.findIndex(isAmountHead), due: head.findIndex(isDueHead) }
      for (const r of table.slice(hi + 1)) {
        const no = (r[col.no] ?? '').trim()
        if (!no || /^(total|grand\s*total|sub\s*total)$/i.test(no)) continue
        const date = normDate((r[col.date] ?? '').trim())
        const amt = lastMoney(r[col.amt] ?? '')
        if (!date || !amt) { skipped.push(`${no} on page ${page.page}: ${!date ? 'no readable date' : 'no readable amount'}`); continue }
        rows.push([no, date, amt, col.due >= 0 ? normDate((r[col.due] ?? '').trim()) ?? '' : ''])
      }
    }
  }
  return found ? { rows, skipped, source: 'register' } : null
}

// ── invoice documents ─────────────────────────────────────────────────

const NUMBER_LABEL = /(?:^|\b)(?:tax\s+)?(?:invoice|bill)\s*(?:no|number|#|num)\.?\s*[:\-]?\s*|^#\s*[:\-]?\s*/i
const TOKEN_RE = /^[A-Z0-9][A-Z0-9/\-_.]{1,40}$/i

function fromInvoicePage(page: PageText): { row?: string[]; missing?: string } {
  const lines = page.lines.map(lineText).filter(Boolean)
  let no: string | null = null
  let date: string | null = null
  let due: string | null = null
  let total: string | null = null
  let fallbackTotal: string | null = null
  let draft = false

  for (const t of lines) {
    if (!no && NUMBER_LABEL.test(t)) {
      const after = t.replace(NUMBER_LABEL, '').trim()
      // A print of an unsaved invoice: "Invoice # : Draft — number on save".
      if (/^draft\b/i.test(after)) draft = true
      const rest = after.split(/\s+/)[0] ?? ''
      if (TOKEN_RE.test(rest) && /\d/.test(rest)) no = rest
    }
    if (!date && /\b(invoice\s*date|date\s*of\s*invoice|bill\s*date|dated)\b/i.test(t)) {
      const m = t.match(DATE_RE); if (m) date = normDate(m[1])
    }
    if (!due && /\bdue\s*date\b/i.test(t)) {
      const m = t.match(DATE_RE); if (m) due = normDate(m[1])
    }
    // The invoice total: "Grand Total" first, then a plain "Total" line —
    // never Sub Total, Total Tax, Total Qty or "Total In Words".
    if (/\bgrand\s*total\b/i.test(t)) total = lastMoney(t) ?? total
    else if (!total && /^(invoice\s*)?total\b/i.test(t) && !/\b(in\s*words|tax|qty|quantity|items?)\b/i.test(t)) total = lastMoney(t)
    else if (/\b(amount\s*due|balance\s*due|total\s*amount|net\s*payable|amount\s*payable)\b/i.test(t)) fallbackTotal ??= lastMoney(t)
  }
  // A document dated only by a bare "Date :" line.
  if (!date) {
    const t = lines.find((x) => /^date\b/i.test(x))
    const m = t?.match(DATE_RE); if (m) date = normDate(m[1])
  }
  const amount = total ?? fallbackTotal
  if (draft && !no) {
    return { missing: `page ${page.page}: this is an unsaved draft ("Draft — number on save"), so it has no invoice number yet. Save the invoice, then download its PDF again` }
  }
  if (no && amount !== null && Number(amount) === 0) {
    return { missing: `page ${page.page} (${no}): the total is 0.00 — the invoice has no amount` }
  }
  if (no && date && amount) return { row: [no, date, amount, due ?? ''] }
  if (!no && !date && !amount) return {}
  const missing = [!no && 'invoice number', !date && 'invoice date', !amount && 'total'].filter(Boolean).join(', ')
  return { missing: `page ${page.page}${no ? ` (${no})` : ''}: couldn't find the ${missing}` }
}

function fromInvoices(pages: PageText[]): PdfInvoices {
  const rows: string[][] = [HEADER]
  const skipped: string[] = []
  const seen = new Set<string>()
  for (const page of pages) {
    const r = fromInvoicePage(page)
    if (r.missing) skipped.push(r.missing)
    // A multi-page invoice repeats its number on later pages: keep the first.
    if (r.row && !seen.has(r.row[0])) { seen.add(r.row[0]); rows.push(r.row) }
  }
  return { rows, skipped, source: 'invoices' }
}

export async function pdfInvoiceRows(buffer: Buffer): Promise<PdfInvoices> {
  const pages = await PDFService.extractText(buffer).catch((e: unknown) => {
    const msg = (e as { message?: string }).message ?? ''
    if (/password/i.test(msg)) throw ApiError.badRequest('This PDF is password-protected. Unlock it first (Tools → Unlock PDF), then upload it.')
    throw ApiError.badRequest("This PDF couldn't be read. It may be damaged.")
  })
  if (!PDFService.hasTextLayer(pages)) {
    throw ApiError.badRequest('This PDF is a scan with no text to read. Run it through Tools → OCR Scan first, or upload the invoices as CSV/Excel.')
  }
  const out = fromRegister(pages) ?? fromInvoices(pages)
  if (out.rows.length === 1) {
    const why = out.skipped.slice(0, 3).join('; ')
    throw ApiError.badRequest(`No invoice could be read from this PDF${why ? ` — ${why}` : ''}.${/draft|0\.00/.test(why) ? '' : ' It needs an invoice number, invoice date and total, or a table with those columns.'}`)
  }
  return out
}
