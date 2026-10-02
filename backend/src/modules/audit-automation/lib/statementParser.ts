/**
 * Bank statement → transaction rows.
 *
 * Indian bank statements (PDF and Excel/CSV downloads alike) are tables:
 * a header row naming Date / Narration / Ref / Withdrawal / Deposit /
 * Balance (or a single Amount with a Dr/Cr column), one transaction per
 * row, long narrations wrapping onto continuation lines. This reads that
 * table generically — the header's words decide the columns — so it does
 * not depend on one bank's exact layout.
 *
 * What makes it trustworthy is the check afterwards, not the reading:
 * every row's running balance must equal the previous balance − debit +
 * credit. A row that breaks the chain is flagged for review; a row whose
 * debit and credit were plainly read the wrong way round (swapping them
 * restores the chain) is corrected and flagged AUTO_SWAPPED so a person
 * sees it.
 */
import type { ExtractedPage, ExtractedTextItem } from './pdfInspect.js'

export interface ParsedTxn {
  seq: number
  page: number | null
  txnDate: string          // YYYY-MM-DD
  valueDate: string | null
  narration: string
  reference: string | null
  debitPaise: bigint
  creditPaise: bigint
  balancePaise: bigint | null
  flags: string[]
}

export interface ParseResult {
  rows: ParsedTxn[]
  openingBalancePaise: bigint | null
  closingBalancePaise: bigint | null
  periodFrom: string | null
  periodTo: string | null
  /** Header columns that were recognised, e.g. ['date','narration','debit','credit','balance']. */
  columns: string[]
  /** Statement-level problems (no header found, closing balance mismatch…). */
  warnings: string[]
}

type Col = 'date' | 'valueDate' | 'narration' | 'reference' | 'debit' | 'credit' | 'amount' | 'drcr' | 'balance'

// ── cell text → values ────────────────────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Any common Indian statement date → YYYY-MM-DD, or null. */
export function parseStatementDate(raw: string): string | null {
  const s = raw.trim()
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return iso(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/)
  if (m) return iso(year(m[3]), +m[2], +m[1])
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s,-]+(\d{2,4})\b/)
  if (m) {
    const mo = MONTHS.indexOf(m[2].toLowerCase()) + 1
    return mo ? iso(year(m[3]), mo, +m[1]) : null
  }
  return null
}
const year = (y: string) => (y.length === 2 ? 2000 + +y : +y)
function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCMonth() !== m - 1) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * "1,23,456.78" / "(500.00)" / "500.00 Dr" / "-500" → signed paise.
 * `drIsNegative` makes a trailing Dr negative (balances in overdraft).
 */
export function parseMoney(raw: string, drIsNegative = false): bigint | null {
  let s = raw.replace(/[₹\s]/g, '').replace(/^(rs\.?|inr)/i, '')
  if (!s || s === '-' || s === '--') return null
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }
  const suffix = s.match(/(dr|cr)\.?$/i)
  if (suffix) { if (drIsNegative && /dr/i.test(suffix[1])) neg = true; s = s.slice(0, suffix.index) }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1) }
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1) }
  if (!/^\d{1,3}(,\d{2,3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(s)) return null
  const [whole, frac = ''] = s.replace(/,/g, '').split('.')
  const paise = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2))
  return neg ? -paise : paise
}

// ── header recognition ────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[.:#*_]/g, ' ').replace(/\s+/g, ' ').trim()

function colOf(text: string): Col | null {
  const t = norm(text)
  if (!t || t.length > 40) return null
  if (/^value\s*(dt|date)$/.test(t)) return 'valueDate'
  if (/^(txn|tran|trans|transaction|posting|post|book|entry)?\s*(dt|date)$/.test(t)) return 'date'
  if (/narration|description|particulars|details|remarks|transaction remarks/.test(t)) return 'narration'
  if (/^(dr\s*\/\s*cr|cr\s*\/\s*dr|dr cr|type|txn type)$/.test(t)) return 'drcr'
  if (/balance|^bal\b/.test(t)) return 'balance'
  if (/withdrawal|^debit|^dr\b|paid out|^payments?\b/.test(t)) return 'debit'
  if (/deposit|^credit|^cr\b|paid in|^receipts?\b/.test(t)) return 'credit'
  if (/(chq|cheque|ref|reference|instrument|utr)/.test(t)) return 'reference'
  if (/^(transaction\s*)?(amount|amt)\b/.test(t)) return 'amount'
  return null
}

interface HeaderCol { col: Col; left: number; right: number }

function isHeader(cols: HeaderCol[]): boolean {
  const has = (c: Col) => cols.some((h) => h.col === c)
  const money = (has('debit') && has('credit')) || has('amount')
  return has('date') && has('narration') && (money || has('balance'))
}

// ── PDF: items → lines → cells ────────────────────────────────────────

interface Line { y: number; page: number; items: ExtractedTextItem[] }

function linesOf(page: ExtractedPage): Line[] {
  const items = page.items.filter((i) => i.str.trim() !== '').sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: Line[] = []
  for (const it of items) {
    const tol = Math.max(2, (it.height || 8) * 0.45)
    const line = lines.find((l) => Math.abs(l.y - it.y) <= tol)
    if (line) line.items.push(it)
    else lines.push({ y: it.y, page: page.pageNumber, items: [it] })
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x)
  return lines.sort((a, b) => b.y - a.y)
}

/** Neighbouring words close together become one cell ("Value" "Date" → "Value Date"). */
function cellsOf(items: ExtractedTextItem[]): { text: string; left: number; right: number }[] {
  const cells: { text: string; left: number; right: number }[] = []
  for (const it of items) {
    const last = cells[cells.length - 1]
    const gap = last ? it.x - last.right : Infinity
    if (last && gap < Math.max(4, (it.height || 8) * 0.9)) {
      last.text += (gap > 0.5 ? ' ' : '') + it.str.trim()
      last.right = Math.max(last.right, it.x + it.width)
    } else {
      cells.push({ text: it.str.trim(), left: it.x, right: it.x + it.width })
    }
  }
  return cells
}

/** Every text line of a PDF as its cells, top to bottom, page by page — for other statement readers (26AS). */
export function pdfRows(pages: ExtractedPage[]): { page: number; cells: string[] }[] {
  return pages.flatMap((p) => linesOf(p).map((l) => ({ page: p.pageNumber, cells: cellsOf(l.items).map((c) => c.text).filter(Boolean) })))
}

function headerFromCells(cells: { text: string; left: number; right: number }[]): HeaderCol[] {
  const out: HeaderCol[] = []
  for (const c of cells) {
    const col = colOf(c.text)
    if (col && !out.some((h) => h.col === col)) out.push({ col, left: c.left, right: c.right })
  }
  return out
}

/** Two stacked header lines ("Withdrawal" over "Amt.") read as one. */
function mergeLines(a: Line, b: Line): Line {
  const cells = [...cellsOf(a.items), ...cellsOf(b.items)].sort((x, y) => x.left - y.left)
  const merged: { text: string; left: number; right: number }[] = []
  for (const c of cells) {
    const over = merged.find((m) => c.left < m.right && c.right > m.left)
    if (over) { over.text += ' ' + c.text; over.left = Math.min(over.left, c.left); over.right = Math.max(over.right, c.right) }
    else merged.push({ ...c })
  }
  return { y: a.y, page: a.page, items: merged.map((m) => ({ str: m.text, x: m.left, y: a.y, width: m.right - m.left, height: 8, fontName: '' })) }
}

/** Column bands: halfway between neighbouring header cells. */
function bands(header: HeaderCol[]): { col: Col; from: number; to: number }[] {
  const h = [...header].sort((a, b) => a.left - b.left)
  return h.map((c, i) => ({
    col: c.col,
    from: i === 0 ? -Infinity : (h[i - 1].right + c.left) / 2,
    to: i === h.length - 1 ? Infinity : (c.right + h[i + 1].left) / 2,
  }))
}

// Lines that are statement furniture, not transactions.
const SKIP = /^(opening|closing)\s*balance|statement summary|^total\b|grand total|page\s*\d+\s*(of|\/)\s*\d+|end of statement|computer generated|^\*+|carried forward|brought forward|b\/f|c\/f/i

/** `cont`: a line that may only continue the row above (no date of its own, directly under it). */
type Raw = Partial<Record<Col, string>> & { page: number | null; cont?: boolean }
/** "Opening Balance : 50,000.00" — a figure on the line, so a "Closing Balance" column header is not one. */
const BALANCE_NOTE = /^(opening|closing)\s*balance\b.*\d[\d,]*\.\d{1,2}/i

/** Rows of cells keyed by column, from a PDF's pages. */
function rawRowsFromPdf(pages: ExtractedPage[]): { raws: Raw[]; columns: Col[]; notes: string[] } {
  let active: ReturnType<typeof bands> | null = null
  let columns: Col[] = []
  const raws: Raw[] = []
  const notes: string[] = []
  const headerAt = (lines: Line[], i: number): { hdr: HeaderCol[]; span: number } | null => {
    const one = headerFromCells(cellsOf(lines[i].items))
    if (lines[i + 1]) {
      const two = headerFromCells(cellsOf(mergeLines(lines[i], lines[i + 1]).items))
      if (isHeader(two) && two.length > one.length) return { hdr: two, span: 2 }
    }
    return isHeader(one) ? { hdr: one, span: 1 } : null
  }
  for (const page of pages) {
    const lines = linesOf(page)
    // Letterhead above this page's header is not table content.
    let start = 0
    for (let i = 0; i < lines.length; i++) if (headerAt(lines, i)) { start = i; break }
    let lastRowY: number | null = null
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const text = line.items.map((x) => x.str).join(' ').trim()
      if (BALANCE_NOTE.test(text)) { notes.push(text); continue }
      if (i < start) continue
      const h = headerAt(lines, i)
      if (h) { active = bands(h.hdr); columns = h.hdr.map((x) => x.col); i += h.span - 1; lastRowY = null; continue }
      if (!active) continue
      if (SKIP.test(text)) { notes.push(text); continue }

      const row: Raw = { page: page.pageNumber }
      for (const it of line.items) {
        const cx = it.x + it.width / 2
        const b = active.find((x) => cx >= x.from && cx < x.to)
        if (!b) continue
        row[b.col] = row[b.col] ? `${row[b.col]} ${it.str.trim()}` : it.str.trim()
      }
      const lineH = Math.max(...line.items.map((x) => x.height || 8))
      if (row.date && parseStatementDate(row.date)) lastRowY = line.y
      else {
        // Continuation only straight under a row, and never a line carrying amounts.
        const near = lastRowY !== null && lastRowY - line.y <= lineH * 3.2
        const hasMoney = [row.debit, row.credit, row.amount, row.balance].some((v) => v && parseMoney(v) !== null)
        if (!near || hasMoney) continue
        row.cont = true
        lastRowY = line.y
      }
      raws.push(row)
    }
  }
  return { raws, columns, notes }
}

/** Rows of cells keyed by column, from a spreadsheet's rows. */
function rawRowsFromTable(table: string[][]): { raws: Raw[]; columns: Col[]; notes: string[] } {
  const hi = table.findIndex((r) => isHeader(r.map((c, i) => ({ col: colOf(c) as Col, left: i, right: i })).filter((h) => h.col)))
  if (hi < 0) return { raws: [], columns: [], notes: [] }
  const map: { col: Col; idx: number }[] = []
  table[hi].forEach((c, idx) => { const col = colOf(c); if (col && !map.some((m) => m.col === col)) map.push({ col, idx }) })
  const raws: Raw[] = []
  const notes: string[] = []
  for (const r of table.slice(hi + 1)) {
    const joined = r.join(' ').trim()
    if (!joined) continue
    if (SKIP.test(joined)) { notes.push(joined); continue }
    const row: Raw = { page: null }
    for (const m of map) if ((r[m.idx] ?? '').trim()) row[m.col] = r[m.idx].trim()
    raws.push(row)
  }
  return { raws, columns: map.map((m) => m.col), notes }
}

// ── rows → transactions ───────────────────────────────────────────────

function assemble(raws: Raw[]): ParsedTxn[] {
  const out: ParsedTxn[] = []
  let cur: ParsedTxn | null = null
  for (const r of raws) {
    const date = r.date ? parseStatementDate(r.date) : null
    if (!date) {
      // A continuation line: more narration (or reference) for the row above.
      if (cur && (r.narration || r.reference)) {
        if (r.narration) cur.narration = `${cur.narration} ${r.narration}`.trim()
        if (r.reference) cur.reference = `${cur.reference ?? ''}${r.reference}`.trim()
      }
      continue
    }
    let debit = r.debit ? parseMoney(r.debit) : null
    let credit = r.credit ? parseMoney(r.credit) : null
    if (debit === null && credit === null && r.amount) {
      const amt = parseMoney(r.amount)
      if (amt !== null) {
        const ind = (r.drcr ?? r.amount).toLowerCase()
        if (/\bcr\b|credit|cr$/.test(ind)) credit = amt < 0n ? -amt : amt
        else if (/\bdr\b|debit|dr$/.test(ind)) debit = amt < 0n ? -amt : amt
        else if (amt < 0n) debit = -amt
        else credit = amt
      }
    }
    const flags: string[] = []
    if (debit !== null && debit < 0n) debit = -debit
    if (credit !== null && credit < 0n) credit = -credit
    if (!debit && !credit) flags.push('NO_AMOUNT')
    if (debit && credit) flags.push('BOTH_AMOUNTS')
    const balance = r.balance ? parseMoney(r.balance, true) : null
    if (balance === null) flags.push('NO_BALANCE')
    cur = {
      seq: 0,
      page: r.page,
      txnDate: date,
      valueDate: r.valueDate ? parseStatementDate(r.valueDate) : null,
      narration: (r.narration ?? '').trim(),
      reference: r.reference?.trim() || null,
      debitPaise: debit ?? 0n,
      creditPaise: credit ?? 0n,
      balancePaise: balance,
      flags,
    }
    out.push(cur)
  }
  return out
}

const abs = (n: bigint) => (n < 0n ? -n : n)

/**
 * Put rows in date order, then walk the balance chain: flag breaks, and
 * fix a debit/credit read the wrong way round when swapping them makes
 * the chain hold.
 */
export function validateChain(rows: ParsedTxn[]): { opening: bigint | null; closing: bigint | null } {
  // Newest-first statements: reverse when the dates run backwards.
  if (rows.length > 1 && rows[0].txnDate > rows[rows.length - 1].txnDate) rows.reverse()
  rows.forEach((r, i) => { r.seq = i + 1 })

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]
    const r = rows[i]
    if (r.txnDate < prev.txnDate) r.flags.push('DATE_ORDER')
    if (prev.balancePaise === null || r.balancePaise === null) continue
    const expected = prev.balancePaise - r.debitPaise + r.creditPaise
    if (abs(expected - r.balancePaise) <= 1n) continue
    const swapped = prev.balancePaise - r.creditPaise + r.debitPaise
    if (!r.flags.includes('BOTH_AMOUNTS') && abs(swapped - r.balancePaise) <= 1n) {
      ;[r.debitPaise, r.creditPaise] = [r.creditPaise, r.debitPaise]
      r.flags.push('AUTO_SWAPPED')
      continue
    }
    r.flags.push('BALANCE_BREAK')
  }
  const first = rows[0]
  const last = rows[rows.length - 1]
  const opening = first && first.balancePaise !== null ? first.balancePaise + first.debitPaise - first.creditPaise : null
  return { opening, closing: last?.balancePaise ?? null }
}

/** The statement's own "Opening/Closing Balance" figure, if it prints one. */
function statedBalance(notes: string[], kind: 'opening' | 'closing'): bigint | null {
  const line = notes.find((n) => new RegExp(`^${kind}\\s*balance`, 'i').test(n))
  if (!line) return null
  const nums = line.match(/-?[\d,]+\.\d{1,2}\s*(dr|cr)?/gi)
  return nums ? parseMoney(nums[nums.length - 1], true) : null
}

function finish(raws: Raw[], columns: Col[], notes: string[]): ParseResult {
  const warnings: string[] = []
  if (!columns.length) {
    return { rows: [], openingBalancePaise: null, closingBalancePaise: null, periodFrom: null, periodTo: null, columns: [], warnings: ['NO_HEADER'] }
  }
  const rows = assemble(raws)
  const chain = validateChain(rows)
  const statedOpen = statedBalance(notes, 'opening')
  const statedClose = statedBalance(notes, 'closing')
  if (statedOpen !== null && chain.opening !== null && abs(statedOpen - chain.opening) > 1n) warnings.push('OPENING_BALANCE_MISMATCH')
  if (statedClose !== null && chain.closing !== null && abs(statedClose - chain.closing) > 1n) warnings.push('CLOSING_BALANCE_MISMATCH')
  if (!rows.length) warnings.push('NO_ROWS')
  return {
    rows,
    openingBalancePaise: statedOpen ?? chain.opening,
    closingBalancePaise: statedClose ?? chain.closing,
    periodFrom: rows[0]?.txnDate ?? null,
    periodTo: rows[rows.length - 1]?.txnDate ?? null,
    columns,
    warnings,
  }
}

/** Height of the table header on a page (its baseline y), or null when the page has none. */
export function tableHeaderY(page: ExtractedPage): number | null {
  const lines = linesOf(page)
  for (let i = 0; i < lines.length; i++) {
    const one = headerFromCells(cellsOf(lines[i].items))
    const two = lines[i + 1] ? headerFromCells(cellsOf(mergeLines(lines[i], lines[i + 1]).items)) : []
    if (isHeader(one) || isHeader(two)) return lines[i].y
  }
  return null
}

export function parseStatementPdf(pages: ExtractedPage[]): ParseResult {
  const { raws, columns, notes } = rawRowsFromPdf(pages)
  return finish(raws, columns, notes)
}

export function parseStatementTable(table: string[][]): ParseResult {
  const { raws, columns, notes } = rawRowsFromTable(table)
  return finish(raws, columns, notes)
}
