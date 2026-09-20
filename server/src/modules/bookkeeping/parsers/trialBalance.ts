/**
 * TRIAL-BALANCE parser (spec §6.5).
 *
 * A trial balance file is the ONE truthful source we get from the client's
 * books each month. The parser is the sole boundary between "text on disk"
 * and BigInt paise in the database — nothing downstream ever sees a float,
 * a comma-formatted string, or a Rupee-symbol prefix. Grep the codebase for
 * `parseFloat`, `Number(`, `.toFixed(` on amount fields and you must find
 * nothing outside this file.
 *
 * INPUT FORMAT
 *   A CSV with a header row and one row per ledger. Column order is not
 *   required — the header names steer the mapping. Every header string is
 *   trimmed + lowercased before matching, so "Ledger Name", "ledger_name"
 *   and "Ledger  Name" all resolve to the same column.
 *
 *   Required columns (any of the accepted spellings):
 *     ledger  — "ledger name", "particulars", "name"
 *     group   — "parent group", "group", "under"
 *
 *   At least one amount column, from:
 *     opening — "opening", "opening balance", "op balance"
 *     debit   — "debit", "debit amount"
 *     credit  — "credit", "credit amount"
 *     closing — "closing", "closing balance", "balance"
 *
 * MONEY
 *   Values may be plain integers ("150000"), decimals ("150000.50"),
 *   Indian-formatted ("1,50,000.50"), or negative ("-1,50,000.50"). Empty
 *   or "—" is treated as zero. Every value is normalised to paise (BigInt),
 *   so a value with three or more fractional digits (rare in accounting
 *   files) rounds half-away-from-zero. `parseAmount` is exported so tests
 *   can drive it directly.
 *
 * UNKNOWN GROUPS
 *   A parent group we've never classified is not fatal — the row still
 *   lands with `category='other'`, `subtype='other'` and the raw dictionary
 *   in `raw`, so a reviewer can either classify it (add a
 *   BookkeepingLedgerGroup row) and re-import, or leave it for a future
 *   pass. Refusing the file on an unknown group would be worse than
 *   accepting it — the raw is still auditable.
 */

export interface ParsedRow {
  ledgerName: string
  parentGroup: string
  openingPaise: bigint
  debitPaise: bigint
  creditPaise: bigint
  closingPaise: bigint
  raw: Record<string, string>
}

export interface TrialBalanceParseResult {
  rows: ParsedRow[]
  rowCount: number
}

const LEDGER_HEADERS = ['ledger name', 'ledger_name', 'ledger', 'particulars', 'name']
const GROUP_HEADERS = ['parent group', 'parent_group', 'group', 'under']
const OPENING_HEADERS = ['opening', 'opening balance', 'opening_balance', 'op balance', 'op_balance']
const DEBIT_HEADERS = ['debit', 'debit amount', 'debit_amount', 'dr']
const CREDIT_HEADERS = ['credit', 'credit amount', 'credit_amount', 'cr']
const CLOSING_HEADERS = ['closing', 'closing balance', 'closing_balance', 'balance']

/**
 * Parse `"1,50,000.50"` → 15_000_050n paise. Empty / dash → 0n. Negative
 * numbers keep their sign. Rounding is half-away-from-zero on the third
 * decimal, so "0.005" → 1n and "-0.005" → -1n.
 */
export function parseAmount(input: string | undefined | null): bigint {
  if (input === undefined || input === null) return 0n
  const s = String(input).trim()
  if (s === '' || s === '—' || s === '-' || s === '–') return 0n
  // Strip currency symbols, Indian comma group separators and stray Unicode
  // spaces. What must remain is [-]digits[.digits].
  const cleaned = s
    .replace(/[₹$€£]/g, '')
    .replace(/[,\s ]/g, '')
    .replace(/^\+/, '')
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error(`Amount "${input}" is not a number`)
  }
  const negative = cleaned.startsWith('-')
  const magnitude = negative ? cleaned.slice(1) : cleaned
  const [rupees, fraction = ''] = magnitude.split('.')
  const twoDigit = (fraction + '00').slice(0, 2)
  const thirdDigit = fraction.length >= 3 ? Number(fraction[2]) : 0
  let paise = BigInt(rupees) * 100n + BigInt(twoDigit)
  if (thirdDigit >= 5) paise += 1n
  return negative ? -paise : paise
}

export function parseTrialBalanceCsv(text: string): TrialBalanceParseResult {
  const lines = splitCsvLines(text)
  if (lines.length === 0) {
    throw new Error('The file has no rows.')
  }
  const headerCells = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase())
  if (headerCells.length === 0) throw new Error('The header row is empty.')

  const idx = {
    ledger: findColumn(headerCells, LEDGER_HEADERS),
    group: findColumn(headerCells, GROUP_HEADERS),
    opening: findColumn(headerCells, OPENING_HEADERS),
    debit: findColumn(headerCells, DEBIT_HEADERS),
    credit: findColumn(headerCells, CREDIT_HEADERS),
    closing: findColumn(headerCells, CLOSING_HEADERS),
  }
  if (idx.ledger < 0) throw new Error('Header row must include a "Ledger Name" column.')
  if (idx.group < 0) throw new Error('Header row must include a "Parent Group" column.')
  if (idx.opening < 0 && idx.debit < 0 && idx.credit < 0 && idx.closing < 0) {
    throw new Error('Header row must include at least one of Opening, Debit, Credit or Closing.')
  }

  const rows: ParsedRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    // Blank lines and Tally-style totals ("Total:") are quietly skipped —
    // the reports recompute totals from the classified rows anyway, so
    // trusting a file's own totals row would just create a chance for the
    // two to disagree.
    if (line.trim() === '') continue
    const cells = parseCsvLine(line)
    const ledgerName = cell(cells, idx.ledger).trim()
    if (!ledgerName || /^total\b/i.test(ledgerName) || /^grand total\b/i.test(ledgerName)) continue
    const parentGroup = cell(cells, idx.group).trim()
    if (!parentGroup) throw new Error(`Row ${i + 1} ("${ledgerName}") has no Parent Group.`)

    rows.push({
      ledgerName,
      parentGroup,
      openingPaise: parseAmount(cell(cells, idx.opening)),
      debitPaise: parseAmount(cell(cells, idx.debit)),
      creditPaise: parseAmount(cell(cells, idx.credit)),
      closingPaise: parseAmount(cell(cells, idx.closing)),
      raw: Object.fromEntries(headerCells.map((h, ci) => [h, cell(cells, ci)])),
    })
  }
  return { rows, rowCount: rows.length }
}

function cell(cells: string[], i: number): string {
  return i < 0 || i >= cells.length ? '' : cells[i]
}

function findColumn(headers: string[], accepts: readonly string[]): number {
  return headers.findIndex((h) => accepts.includes(h))
}

/** Split raw CSV text into physical lines. Handles \r\n, \r and \n. */
function splitCsvLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

/**
 * Minimal RFC-4180-ish CSV line parser. Enough for the trial-balance files
 * the firm exports today: quoted fields, escaped `""` inside quotes, commas
 * outside quotes. No cross-line quoted fields (a Tally trial balance never
 * has them; add support here if a real file demands it).
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue }
      if (ch === '"') { inQuotes = false; continue }
      cur += ch
      continue
    }
    if (ch === '"') { inQuotes = true; continue }
    if (ch === ',') { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}
