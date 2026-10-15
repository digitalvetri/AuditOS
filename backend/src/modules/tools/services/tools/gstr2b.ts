/**
 * GSTR-2B JSON ⇄ Excel — LOSSLESS.
 *
 * JSON → Excel → JSON reproduces the original key for key and value for
 * value (key order and whitespace aside). How:
 *
 *  - One sheet per section, one row per ITEM (multi-rate invoices work);
 *    a document without `items` is one row.
 *  - Two hidden columns per row carry what a grid cannot show:
 *      _fields  which keys each level had (so absent ≠ empty ≠ zero), and
 *               whether the document had an `items` array;
 *      _extra   any key this layout has no column for (e.g. imsStatus).
 *  - A hidden `_raw` sheet keeps unknown sections, unknown top-level keys
 *    (cpsumm, hash, chksum…) and the original `itcsumm` shape.
 *  - Portal codes are written as codes (R, Y, C, 33); labels typed by a
 *    person ("Regular", "Yes", "33-Tamil Nadu") are mapped back with a
 *    warning.
 *  - Text stays text: GSTINs, periods (092026), document numbers and
 *    dd-mm-yyyy dates are written as text cells, so Excel never reformats
 *    them or drops leading zeros.
 *
 * Excel → JSON rebuilds `itcsumm` from the rows — a summary typed into the
 * sheet is never trusted.
 */
import ExcelJS from 'exceljs'
import { ToolError } from '../errors.js'

type Json = Record<string, unknown>
type Level = 's' | 'd' | 'i'
type Kind = 'text' | 'num' | 'date' | 'gstin' | 'period' | 'pos' | 'yn' | 'invtyp' | 'nttyp' | 'rsn'

interface Col { header: string; key: string; level: Level; kind: Kind; aliases?: string[]; required?: boolean }

interface Section {
  key: string
  sheet: string
  /** supplier → documents (→ items) | flat list of documents | supplier → flat documents */
  shape: 'nested' | 'flat' | 'supplierFlat'
  listKey?: string
  docNumKey: string
  docDateKey: string
  cols: Col[]
}

export interface Issue { severity: 'error' | 'warning'; where: string; message: string }

// ── columns ──────────────────────────────────────────────────────────────

const SUPPLIER: Col[] = [
  // Aliases: the GST portal's own Excel headers, so its downloads read too.
  { header: 'Supplier GSTIN', key: 'ctin', level: 's', kind: 'gstin', required: true, aliases: ['GSTIN of Supplier', 'GSTIN of supplier/UIN', 'Supplier GSTIN/UIN'] },
  { header: 'Supplier Name', key: 'trdnm', level: 's', kind: 'text', aliases: ['Trade / Legal Name', 'Trade Name', 'Trade/Legal name of the Supplier'] },
  { header: 'Supplier Period', key: 'supprd', level: 's', kind: 'period', aliases: ['GSTR-1/5 Period', 'GSTR-1/IFF/GSTR-5 Period', 'Filing Period'] },
  { header: 'Supplier Filing Date', key: 'supfildt', level: 's', kind: 'date', aliases: ['GSTR-1/5 Filing Date', 'GSTR-1/IFF/GSTR-5 Filing Date', 'Filing Date'] },
]
const TAX: Col[] = [
  { header: 'Item No', key: 'num', level: 'i', kind: 'num' },
  { header: 'Rate', key: 'rt', level: 'i', kind: 'num', aliases: ['Rate (%)', 'Tax Rate'] },
  { header: 'Taxable Value', key: 'txval', level: 'i', kind: 'num', aliases: ['Taxable Value (₹)'] },
  { header: 'IGST', key: 'igst', level: 'i', kind: 'num', aliases: ['Integrated Tax', 'Integrated Tax (₹)', 'IGST (₹)'] },
  { header: 'CGST', key: 'cgst', level: 'i', kind: 'num', aliases: ['Central Tax', 'Central Tax (₹)', 'CGST (₹)'] },
  { header: 'SGST', key: 'sgst', level: 'i', kind: 'num', aliases: ['State/UT Tax', 'State/UT Tax (₹)', 'SGST (₹)'] },
  { header: 'Cess', key: 'cess', level: 'i', kind: 'num', aliases: ['Cess (₹)'] },
]
const DOC_TAIL: Col[] = [
  { header: 'ITC Available', key: 'itcavl', level: 'd', kind: 'yn', aliases: ['ITC Availability'] },
  { header: 'Reason Code', key: 'rsn', level: 'd', kind: 'rsn', aliases: ['Reason'] },
  { header: 'IRN', key: 'irn', level: 'd', kind: 'text' },
  { header: 'IRN Date', key: 'irngendate', level: 'd', kind: 'date' },
  { header: 'Source', key: 'srctyp', level: 'd', kind: 'text' },
]

const invoiceCols = (amended: boolean): Col[] => [
  ...SUPPLIER,
  { header: 'Invoice No', key: 'inum', level: 'd', kind: 'text', required: true, aliases: ['Invoice Number', 'Document No', 'Document Number'] },
  ...(amended ? [
    { header: 'Original Invoice No', key: 'oinum', level: 'd', kind: 'text' } as Col,
    { header: 'Original Invoice Date', key: 'oidt', level: 'd', kind: 'date' } as Col,
  ] : []),
  { header: 'Invoice Type', key: 'typ', level: 'd', kind: 'invtyp' },
  { header: 'Invoice Date', key: 'dt', level: 'd', kind: 'date', required: true, aliases: ['Document Date'] },
  { header: 'Invoice Value', key: 'val', level: 'd', kind: 'num', aliases: ['Invoice Value (₹)', 'Document Value'] },
  { header: 'Place of Supply', key: 'pos', level: 'd', kind: 'pos' },
  { header: 'Reverse Charge', key: 'rev', level: 'd', kind: 'yn', aliases: ['Supply Attract Reverse Charge'] },
  { header: 'Diff Percent', key: 'diffprcnt', level: 'd', kind: 'num' },
  ...TAX,
  ...DOC_TAIL,
]
const noteCols = (amended: boolean): Col[] => [
  ...SUPPLIER,
  { header: 'Note No', key: 'ntnum', level: 'd', kind: 'text', required: true, aliases: ['Note Number', 'Credit/Debit Note No', 'Document No', 'Document Number'] },
  ...(amended ? [
    { header: 'Original Note Type', key: 'onttyp', level: 'd', kind: 'nttyp' } as Col,
    { header: 'Original Note No', key: 'ontnum', level: 'd', kind: 'text' } as Col,
    { header: 'Original Note Date', key: 'ontdt', level: 'd', kind: 'date' } as Col,
  ] : []),
  // "Document Type" holding "Credit Note" / "Debit Note" is the note type.
  { header: 'Note Type', key: 'typ', level: 'd', kind: 'nttyp', aliases: ['Document Type', 'Credit/Debit Note Type'] },
  { header: 'Supply Type', key: 'suptyp', level: 'd', kind: 'invtyp' },
  { header: 'Note Date', key: 'dt', level: 'd', kind: 'date', required: true, aliases: ['Document Date'] },
  { header: 'Note Value', key: 'val', level: 'd', kind: 'num', aliases: ['Note Value (₹)', 'Document Value'] },
  { header: 'Place of Supply', key: 'pos', level: 'd', kind: 'pos' },
  { header: 'Reverse Charge', key: 'rev', level: 'd', kind: 'yn', aliases: ['Supply Attract Reverse Charge'] },
  { header: 'Diff Percent', key: 'diffprcnt', level: 'd', kind: 'num' },
  ...TAX,
  ...DOC_TAIL,
]
const isdCols = (amended: boolean): Col[] => [
  { header: 'ISD GSTIN', key: 'ctin', level: 's', kind: 'gstin', required: true },
  { header: 'ISD Name', key: 'trdnm', level: 's', kind: 'text' },
  { header: 'ISD Period', key: 'supprd', level: 's', kind: 'period' },
  { header: 'ISD Filing Date', key: 'supfildt', level: 's', kind: 'date' },
  { header: 'Document Type', key: 'doctyp', level: 'd', kind: 'text' },
  { header: 'Document No', key: 'docnum', level: 'd', kind: 'text', required: true },
  { header: 'Document Date', key: 'docdt', level: 'd', kind: 'date', required: true },
  ...(amended ? [
    { header: 'Original Document No', key: 'odocnum', level: 'd', kind: 'text' } as Col,
    { header: 'Original Document Date', key: 'odocdt', level: 'd', kind: 'date' } as Col,
  ] : []),
  { header: 'Original Invoice No', key: 'oinvnum', level: 'd', kind: 'text' },
  { header: 'Original Invoice Date', key: 'oinvdt', level: 'd', kind: 'date' },
  { header: 'IGST', key: 'igst', level: 'd', kind: 'num' },
  { header: 'CGST', key: 'cgst', level: 'd', kind: 'num' },
  { header: 'SGST', key: 'sgst', level: 'd', kind: 'num' },
  { header: 'Cess', key: 'cess', level: 'd', kind: 'num' },
  { header: 'ITC Eligible', key: 'itcelg', level: 'd', kind: 'yn' },
]
const boeCols: Col[] = [
  { header: 'Reference Date', key: 'refdt', level: 'd', kind: 'date' },
  { header: 'Port Code', key: 'portcode', level: 'd', kind: 'text', aliases: ['Port code'] },
  { header: 'BoE No', key: 'boenum', level: 'd', kind: 'text', required: true, aliases: ['Bill of Entry No', 'Bill of Entry Number', 'BoE Number', 'BE Number'] },
  { header: 'BoE Date', key: 'boedt', level: 'd', kind: 'date', required: true, aliases: ['Bill of Entry Date', 'BE Date'] },
  { header: 'Amended', key: 'isamd', level: 'd', kind: 'yn', aliases: ['Amended (Y/N)', 'Amended (Yes/No)', 'Is Amended'] },
  { header: 'Taxable Value', key: 'txval', level: 'd', kind: 'num' },
  { header: 'IGST', key: 'igst', level: 'd', kind: 'num' },
  { header: 'Cess', key: 'cess', level: 'd', kind: 'num' },
]

export const SECTIONS: Section[] = [
  { key: 'b2b', sheet: 'B2B', shape: 'nested', listKey: 'inv', docNumKey: 'inum', docDateKey: 'dt', cols: invoiceCols(false) },
  { key: 'b2ba', sheet: 'B2BA', shape: 'nested', listKey: 'inv', docNumKey: 'inum', docDateKey: 'dt', cols: invoiceCols(true) },
  { key: 'cdnr', sheet: 'CDNR', shape: 'nested', listKey: 'nt', docNumKey: 'ntnum', docDateKey: 'dt', cols: noteCols(false) },
  { key: 'cdnra', sheet: 'CDNRA', shape: 'nested', listKey: 'nt', docNumKey: 'ntnum', docDateKey: 'dt', cols: noteCols(true) },
  { key: 'isd', sheet: 'ISD', shape: 'nested', listKey: 'doclist', docNumKey: 'docnum', docDateKey: 'docdt', cols: isdCols(false) },
  { key: 'isda', sheet: 'ISDA', shape: 'nested', listKey: 'doclist', docNumKey: 'docnum', docDateKey: 'docdt', cols: isdCols(true) },
  { key: 'impg', sheet: 'IMPG', shape: 'flat', docNumKey: 'boenum', docDateKey: 'boedt', cols: boeCols },
  { key: 'impgsez', sheet: 'IMPGSEZ', shape: 'supplierFlat', listKey: 'boe', docNumKey: 'boenum', docDateKey: 'boedt',
    cols: [SUPPLIER[0], SUPPLIER[1], ...boeCols] },
  // Supplies through an e-commerce operator under section 9(5): the ECO's GSTIN
  // in the supplier columns. Keys this layout lacks still ride in _extra.
  { key: 'ecom', sheet: 'ECO', shape: 'nested', listKey: 'inv', docNumKey: 'inum', docDateKey: 'dt', cols: invoiceCols(false) },
  { key: 'ecoma', sheet: 'ECOA', shape: 'nested', listKey: 'inv', docNumKey: 'inum', docDateKey: 'dt', cols: invoiceCols(true) },
]
const BY_SHEET = new Map(SECTIONS.map((s) => [s.sheet.toUpperCase(), s]))
/** Sheets this tool writes for reading only; never read back as data. */
const REPORT_SHEETS = ['info', 'itcsummary', 'portalvscomputed', 'suppliersummary', 'flags', 'summary', 'raw', 'validation']
const SORT_DATE = 'Sort Date'

const INFO: [string, string][] = [['GSTIN', 'gstin'], ['Return Period', 'rtnprd'], ['Version', 'version'], ['Generated On', 'gendt']]
const TAX_KEYS = ['txval', 'igst', 'cgst', 'sgst', 'cess'] as const
const HIDDEN = ['_fields', '_extra']

// ── codes ────────────────────────────────────────────────────────────────

const INV_TYPES: Record<string, string> = {
  R: 'Regular', SEWP: 'SEZ supplies with payment', SEWOP: 'SEZ supplies without payment',
  DE: 'Deemed exports', CBW: 'Intra-state supplies attracting IGST / customs bonded warehouse',
}
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/
const DATE_RE = /^(\d{2})-(\d{2})-(\d{4})$/
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const pad2 = (n: number) => String(n).padStart(2, '0')

function validDate(s: string): boolean {
  const m = s.match(DATE_RE)
  if (!m) return false
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]))
  return d.getUTCDate() === +m[1] && d.getUTCMonth() === +m[2] - 1
}
const dateKey = (s: string) => { const m = s.match(DATE_RE); return m ? `${m[3]}${m[2]}${m[1]}` : '' }

// ── cell reading ─────────────────────────────────────────────────────────

/** A cell as text (Excel may have turned a date or a number into a different type). */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return `${pad2(v.getUTCDate())}-${pad2(v.getUTCMonth() + 1)}-${v.getUTCFullYear()}`
  if (typeof v === 'object') {
    const o = v as unknown as Json
    if ('richText' in o) return (o.richText as { text: string }[]).map((r) => r.text).join('')
    if ('result' in o) return o.result === undefined ? '' : cellText(o.result as ExcelJS.CellValue)
    if ('text' in o) return String(o.text ?? '')
    if ('formula' in o || 'sharedFormula' in o) return '0' // a cached 0 is dropped by ExcelJS
    return ''
  }
  return String(v)
}

// ── JSON → Excel ─────────────────────────────────────────────────────────

const TEXT_KINDS: Kind[] = ['text', 'date', 'gstin', 'period', 'pos', 'yn', 'invtyp', 'nttyp', 'rsn']

function rowsOf(sec: Section, arr: Json[]): Record<string, unknown>[] {
  const known = new Set(sec.cols.map((c) => c.key))
  const rows: Record<string, unknown>[] = []
  const pick = (o: Json | undefined, level: Level) => {
    const out: Record<string, unknown> = {}
    const extra: Json = {}
    if (!o) return { out, extra, keys: [] as string[] }
    for (const [k, v] of Object.entries(o)) {
      if (level === 's' && k === sec.listKey) continue
      if (level === 'd' && k === 'items') continue
      const col = sec.cols.find((c) => c.key === k && (c.level === level || (level === 'd' && c.level === 'i' && TAX_KEYS.includes(k as never))))
      if (col && known.has(k)) out[k] = v
      else extra[k] = v
    }
    return { out, extra, keys: Object.keys(o).filter((k) => !(level === 's' && k === sec.listKey) && !(level === 'd' && k === 'items')) }
  }
  const emit = (g: Json | undefined, d: Json, item: Json | undefined) => {
    const s = pick(g, 's'); const dd = pick(d, 'd'); const it = pick(item, 'i')
    const row: Record<string, unknown> = {}
    for (const c of sec.cols) {
      if (c.level === 's') row[c.header] = s.out[c.key]
      else if (c.level === 'd') row[c.header] = dd.out[c.key]
      else row[c.header] = item ? it.out[c.key] : dd.out[c.key]
    }
    row._fields = JSON.stringify({ s: g ? s.keys : undefined, d: dd.keys, i: item ? it.keys : undefined, items: Array.isArray(d.items) })
    const extra = { ...(Object.keys(s.extra).length ? { s: s.extra } : {}), ...(Object.keys(dd.extra).length ? { d: dd.extra } : {}), ...(Object.keys(it.extra).length ? { i: it.extra } : {}) }
    row._extra = Object.keys(extra).length ? JSON.stringify(extra) : ''
    rows.push(row)
  }
  for (const g of arr) {
    if (sec.shape === 'flat') { emit(undefined, g, undefined); continue }
    const docs = (g[sec.listKey!] ?? []) as Json[]
    if (!docs.length) emit(g, {}, undefined)
    for (const d of docs) {
      const items = sec.shape === 'nested' && Array.isArray(d.items) && d.items.length ? d.items as Json[] : null
      if (items) for (const it of items) emit(g, d, it)
      else emit(g, d, undefined)
    }
  }
  return rows
}

/** dd-mm-yyyy → a real Excel date (UTC midnight), or null. */
const toDate = (s: unknown): Date | null => {
  const t = String(s ?? '')
  if (!validDate(t)) return null
  const [d, m, y] = t.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

function addSheet(wb: ExcelJS.Workbook, sec: Section, rows: Record<string, unknown>[]) {
  const ws = wb.addWorksheet(sec.sheet)
  // Sort Date: the document date as a real date so the sheet sorts and filters
  // by date; the text column beside it is what converts back.
  const dateHeader = sec.cols.find((c) => c.key === sec.docDateKey)?.header
  const headers = [...sec.cols.map((c) => c.header), SORT_DATE, ...HIDDEN]
  ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(12, h.length + 2) }))
  sec.cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1)
    // Text cells stay text in Excel: no date parsing, no lost leading zeros.
    col.numFmt = TEXT_KINDS.includes(c.kind) ? '@' : c.key === 'rt' || c.key === 'num' || c.key === 'diffprcnt' ? '0.##' : '#,##0.00'
  })
  ws.getColumn(sec.cols.length + 1).numFmt = 'dd-mm-yyyy'
  HIDDEN.forEach((_, i) => { ws.getColumn(sec.cols.length + i + 2).hidden = true })
  for (const r of rows) {
    const vals = headers.map((h) => {
      if (h === SORT_DATE) return dateHeader ? toDate(r[dateHeader]) : null
      const col = sec.cols.find((c) => c.header === h)
      const v = r[h]
      if (v === undefined || v === null) return null
      return col && TEXT_KINDS.includes(col.kind) ? String(v) : v
    })
    ws.addRow(vals)
  }
  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sec.cols.length + 1 } }
  return ws
}

// ── ITC: classification shared by the JS totals and the sheet formulas ────

type Heads = Record<string, number>
type Group = 'imports' | 'revsup' | 'isdsup' | 'nonrevsup'
/** itcsumm groups AuditOS computes; any other portal group is shown as-is. */
const GROUPS: Group[] = ['imports', 'revsup', 'isdsup', 'nonrevsup']
const HEADS = ['igst', 'cgst', 'sgst', 'cess'] as const
interface ItcTotals { avl: Record<string, Record<string, Heads>>; unavl: Record<string, Record<string, Heads>>; net: Heads }

const isNote = (sec: string) => sec === 'cdnr' || sec === 'cdnra'
const isIsd = (sec: string) => sec.startsWith('isd')
const isImport = (sec: string) => sec.startsWith('impg')
const groupsOf = (sec: string): Group[] => isImport(sec) ? ['imports'] : isIsd(sec) ? ['isdsup'] : ['revsup', 'nonrevsup']

/**
 * Where one document's tax lands: imports and ISD have their own groups;
 * everything else is reverse charge (rev = Y, GSTR-3B 4A(3)) or all other
 * ITC (4A(5)). Credit notes and ISD credit notes reduce ITC.
 */
function classify(sec: string, d: Json): { group: Group; avail: boolean; sign: 1 | -1 } {
  if (isImport(sec)) return { group: 'imports', avail: true, sign: 1 }
  if (isIsd(sec)) return { group: 'isdsup', avail: d.itcelg !== 'N', sign: String(d.doctyp ?? '').toUpperCase().startsWith('ISDC') ? -1 : 1 }
  return { group: d.rev === 'Y' ? 'revsup' : 'nonrevsup', avail: d.itcavl !== 'N', sign: isNote(sec) && d.typ === 'C' ? -1 : 1 }
}

const docsOf = (sec: Section, docdata: Json): Json[] => {
  const arr = docdata[sec.key]
  if (!Array.isArray(arr)) return []
  return sec.shape === 'flat' ? arr as Json[] : (arr as Json[]).flatMap((g) => (g[sec.listKey!] ?? []) as Json[])
}

function computeItc(docdata: Json): ItcTotals {
  const z = (): Heads => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 })
  const avl: ItcTotals['avl'] = {}
  const unavl: ItcTotals['unavl'] = {}
  // A document's tax is its own total, or the sum of its items when it carries none.
  const taxOf = (d: Json, h: string) => d[h] !== undefined ? Number(d[h]) || 0
    : Array.isArray(d.items) ? (d.items as Json[]).reduce((a, it) => a + (Number(it[h]) || 0), 0) : 0
  for (const sec of SECTIONS) {
    if (!Array.isArray(docdata[sec.key])) continue
    for (const d of docsOf(sec, docdata)) {
      const c = classify(sec.key, d)
      const t = (((c.avail ? avl : unavl)[c.group] ??= {})[sec.key] ??= z())
      for (const h of HEADS) t[h] = round2(t[h] + c.sign * taxOf(d, h))
    }
  }
  const net = z()
  for (const g of Object.values(avl)) for (const t of Object.values(g)) for (const h of HEADS) net[h] = round2(net[h] + t[h])
  return { avl, unavl, net }
}

const sumHeads = (secs: Record<string, Heads> | undefined): Heads => {
  const o: Heads = { igst: 0, cgst: 0, sgst: 0, cess: 0 }
  for (const v of Object.values(secs ?? {})) for (const h of HEADS) o[h] = round2(o[h] + v[h])
  return o
}

/** itcsumm in the portal's shape, for a workbook that never had one. */
function itcsummFrom(t: ItcTotals): Json {
  const part = (b: ItcTotals['avl']) => Object.fromEntries(Object.entries(b).map(([g, secs]) => [g, { ...sumHeads(secs), ...secs }]))
  const out: Json = { itcavl: part(t.avl) }
  if (Object.keys(t.unavl).length) out.itcunavl = part(t.unavl)
  return out
}

interface ReconRow { path: string; portal: number; computed: number }

/**
 * The portal's itcsumm against AuditOS's totals, leaf by leaf, for the
 * groups AuditOS computes. The portal's figures are never changed: a gap is
 * shown (Portal vs Computed sheet) and reported, for the auditor to explain.
 */
function reconcileItc(original: unknown, t: ItcTotals): ReconRow[] {
  const rows: ReconRow[] = []
  const known = new Set(SECTIONS.map((s) => s.key))
  const computedAt = (path: string[]): number | undefined => {
    const [part, group, a, b] = path
    const bucket = part === 'itcavl' ? t.avl : part === 'itcunavl' ? t.unavl : null
    if (!bucket || !GROUPS.includes(group as Group)) return undefined
    const g = bucket[group] ?? {}
    if (path.length === 3 && (HEADS as readonly string[]).includes(a)) return sumHeads(g)[a]
    if (path.length === 4 && known.has(a) && (HEADS as readonly string[]).includes(b)) return g[a]?.[b] ?? 0
    return undefined
  }
  const walk = (node: unknown, path: string[]) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node as Json)) walk(v, [...path, k])
    } else if (typeof node === 'number') {
      const c = computedAt(path)
      if (c !== undefined) rows.push({ path: path.join('.'), portal: node, computed: c })
    }
  }
  walk(original, [])
  return rows
}

const reconIssues = (rows: ReconRow[]): Issue[] => rows.filter((r) => Math.abs(r.portal - r.computed) > 0.005).map((r) => ({
  severity: 'warning', where: `itcsumm.${r.path}`,
  message: `The portal says ${r.portal}; the documents add up to ${r.computed}. The portal's figure is kept — see Portal vs Computed.`,
}))

// ── report sheets ────────────────────────────────────────────────────────

const colLetter = (n: number) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) } return s }

const GROUP_LABEL: Record<Group, string> = {
  imports: '4A(1) Import of goods',
  revsup: '4A(3) Inward supplies liable to reverse charge',
  isdsup: '4A(4) Inward supplies from ISD',
  nonrevsup: '4A(5) All other ITC',
}

/**
 * ITC Summary in GSTR-3B Table 4 order, as live SUMIFS over the data sheets
 * (it recalculates when rows are edited); the cached results are the JS
 * totals, so viewers that do not calculate still show the figures.
 */
function addItcSheet(wb: ExcelJS.Workbook, present: Section[], t: ItcTotals) {
  const ws = wb.addWorksheet('ITC Summary')
  ws.columns = [{ header: 'GSTR-3B Table 4', key: 'p', width: 46 }, { header: 'Section', key: 's', width: 12 },
    { header: 'IGST', key: 'igst', width: 15 }, { header: 'CGST', key: 'cgst', width: 15 }, { header: 'SGST', key: 'sgst', width: 15 }, { header: 'Cess', key: 'cess', width: 15 }]
  const ref = (sec: Section, key: string) => {
    const i = sec.cols.findIndex((c) => c.key === key)
    return i < 0 ? null : `'${sec.sheet}'!$${colLetter(i + 1)}$2:$${colLetter(i + 1)}$200000`
  }
  const sumifs = (sec: Section, h: string, conds: [string, string][]): string | null => {
    const r = ref(sec, h)
    if (!r) return null
    const cs = conds.filter(([k]) => ref(sec, k)).map(([k, v]) => `,${ref(sec, k)},"${v}"`)
    return cs.length ? `SUMIFS(${r}${cs.join('')})` : `SUM(${r})`
  }
  const formula = (sec: Section, h: string, group: Group, avail: boolean): string | null => {
    const conds: [string, string][] = []
    if (!isImport(sec.key)) conds.push([isIsd(sec.key) ? 'itcelg' : 'itcavl', avail ? '<>N' : 'N'])
    if (group === 'revsup') conds.push(['rev', 'Y'])
    if (group === 'nonrevsup') conds.push(['rev', '<>Y'])
    if (isNote(sec.key)) {
      const pos = sumifs(sec, h, [...conds, ['typ', '<>C']]); const neg = sumifs(sec, h, [...conds, ['typ', 'C']])
      return pos && neg ? `${pos}-${neg}` : null
    }
    if (isIsd(sec.key)) {
      const all = sumifs(sec, h, conds); const cn = sumifs(sec, h, [...conds, ['doctyp', 'ISDC*']])
      return all && cn ? `${all}-2*${cn}` : null
    }
    return sumifs(sec, h, conds)
  }
  const block = (avail: boolean, title: string) => {
    const first = ws.rowCount + 1
    for (const group of GROUPS) {
      for (const sec of present.filter((s) => groupsOf(s.key).includes(group))) {
        const cached = (avail ? t.avl : t.unavl)[group]?.[sec.key]
        if (!cached) continue // no document of this section lands in this line
        const r = ws.addRow({ p: GROUP_LABEL[group], s: sec.sheet })
        HEADS.forEach((h, i) => {
          const f = formula(sec, h, group, avail)
          r.getCell(3 + i).value = f ? { formula: f, result: cached?.[h] ?? 0 } : 0
        })
      }
    }
    const last = ws.rowCount
    const tot = ws.addRow({ p: title, s: '' })
    const totals = sumHeads(Object.fromEntries(Object.entries(avail ? t.avl : t.unavl).flatMap(([g, secs]) => Object.entries(secs).map(([s, v]) => [`${g}.${s}`, v]))))
    HEADS.forEach((h, i) => { const c = colLetter(3 + i); tot.getCell(3 + i).value = last >= first ? { formula: `SUM(${c}${first}:${c}${last})`, result: totals[h] } : 0 })
    tot.font = { bold: true }
  }
  block(true, 'Total ITC available — 4A')
  ws.addRow({})
  ws.addRow({ p: 'ITC not available (itcavl / itcelg = N)' }).font = { italic: true }
  block(false, 'Total ITC not available')
  ws.addRow({})
  ws.addRow({ p: 'Recalculated from the data sheets. Credit notes and ISD credit notes are negative. The portal\'s own figures are on Portal vs Computed and are what converts back to JSON.' })
  for (let i = 3; i <= 6; i++) ws.getColumn(i).numFmt = '#,##0.00;[Red]-#,##0.00'
  ws.getRow(1).font = { bold: true }
}

function addReconSheet(wb: ExcelJS.Workbook, rows: ReconRow[], hadSummary: boolean) {
  const ws = wb.addWorksheet('Portal vs Computed')
  ws.columns = [{ header: 'itcsumm path', key: 'p', width: 40 }, { header: 'Portal', key: 'a', width: 16 },
    { header: 'Computed from documents', key: 'b', width: 24 }, { header: 'Difference', key: 'd', width: 16 }]
  if (!hadSummary) ws.addRow({ p: 'This file carries no portal itcsumm — nothing to compare.' })
  for (const r of rows) {
    const row = ws.addRow({ p: r.path, a: r.portal, b: r.computed })
    row.getCell(4).value = { formula: `B${row.number}-C${row.number}`, result: round2(r.portal - r.computed) }
    if (Math.abs(r.portal - r.computed) > 0.005) row.font = { color: { argb: 'FFC00000' } }
  }
  for (let i = 2; i <= 4; i++) ws.getColumn(i).numFmt = '#,##0.00;[Red]-#,##0.00'
  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
}

/** One row per supplier per section: documents, taxable value, tax, ITC not available. */
function addSupplierSheet(wb: ExcelJS.Workbook, docdata: Json) {
  const ws = wb.addWorksheet('Supplier Summary')
  ws.columns = [
    { header: 'Section', key: 'sec', width: 10 }, { header: 'Supplier GSTIN', key: 'ctin', width: 18 }, { header: 'Supplier Name', key: 'nm', width: 30 },
    { header: 'Documents', key: 'n', width: 11 }, { header: 'Taxable Value', key: 'txval', width: 16 },
    { header: 'IGST', key: 'igst', width: 14 }, { header: 'CGST', key: 'cgst', width: 14 }, { header: 'SGST', key: 'sgst', width: 14 }, { header: 'Cess', key: 'cess', width: 12 },
    { header: 'Reverse charge docs', key: 'rc', width: 12 }, { header: 'ITC not available docs', key: 'na', width: 14 },
  ]
  ws.getColumn(2).numFmt = '@'
  const amt = (d: Json, k: string) => d[k] !== undefined ? Number(d[k]) || 0 : Array.isArray(d.items) ? (d.items as Json[]).reduce((a, it) => a + (Number(it[k]) || 0), 0) : 0
  for (const sec of SECTIONS.filter((s) => s.shape !== 'flat')) {
    const arr = docdata[sec.key]
    if (!Array.isArray(arr)) continue
    const by = new Map<string, { nm: string; n: number; rc: number; na: number; t: Record<string, number> }>()
    for (const g of arr as Json[]) {
      const ctin = String(g.ctin ?? '')
      const e = by.get(ctin) ?? { nm: String(g.trdnm ?? ''), n: 0, rc: 0, na: 0, t: { txval: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 } }
      for (const d of (g[sec.listKey!] ?? []) as Json[]) {
        const sign = classify(sec.key, d).sign
        e.n++
        if (d.rev === 'Y') e.rc++
        if (d.itcavl === 'N' || d.itcelg === 'N') e.na++
        for (const k of TAX_KEYS) e.t[k] = round2(e.t[k] + sign * amt(d, k))
      }
      by.set(ctin, e)
    }
    for (const [ctin, e] of [...by].sort((a, b) => b[1].t.txval - a[1].t.txval)) {
      ws.addRow({ sec: sec.sheet, ctin, nm: e.nm, n: e.n, ...e.t, rc: e.rc || null, na: e.na || null })
    }
  }
  for (let i = 5; i <= 9; i++) ws.getColumn(i).numFmt = '#,##0.00;[Red]-#,##0.00'
  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 11 } }
}

/** Every check that did not stop the conversion, one per row, for review. */
function addFlagsSheet(wb: ExcelJS.Workbook, issues: Issue[]) {
  const ws = wb.addWorksheet('Flags')
  ws.columns = [{ header: 'Where', key: 'w', width: 44 }, { header: 'Flag', key: 'm', width: 110 }]
  if (!issues.length) ws.addRow({ w: 'No flags', m: 'Every document passed the checks.' })
  for (const i of issues) ws.addRow({ w: i.where, m: i.message })
  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 2 } }
}

// ── validation ───────────────────────────────────────────────────────────

interface DocCheck { sec: Section; where: string; doc: Json; items: Json[] | null; supplierGstin: string | null }

function periodEnd(rtnprd: string): string | null {
  const m = rtnprd.match(/^(\d{2})(\d{4})$/)
  if (!m || +m[1] < 1 || +m[1] > 12) return null
  const last = new Date(Date.UTC(+m[2], +m[1], 0)).getUTCDate()
  return `${m[2]}${m[1]}${pad2(last)}`
}

/**
 * Checks on every document. A GSTR-2B is what suppliers filed, so its data
 * problems are the auditor's findings, not a reason to refuse the file: they
 * are flags (warnings, listed on the Flags sheet). Only `strict` — a workbook
 * on its way to JSON — makes a malformed GSTIN or date an error, since the
 * JSON would be broken.
 */
function validateDocs(checks: DocCheck[], rtnprd: string | null, issues: Issue[], strict = false) {
  const warn = (where: string, message: string) => issues.push({ severity: 'warning', where, message })
  const format = (where: string, message: string) => issues.push({ severity: strict ? 'error' : 'warning', where, message })
  const end = rtnprd ? periodEnd(rtnprd) : null
  const seen = new Map<string, string>()
  for (const c of checks) {
    const { sec, doc, where } = c
    if (c.supplierGstin !== null && !GSTIN_RE.test(c.supplierGstin)) {
      format(where, `Supplier GSTIN "${c.supplierGstin}" is not a valid GSTIN (15 characters, e.g. 33AABCS1234L1Z5).`)
    }
    const num = String(doc[sec.docNumKey] ?? '')
    if (num) {
      // A credit and a debit note may share a number; same type + number is the duplicate.
      const k = `${sec.key}|${c.supplierGstin ?? ''}|${isNote(sec.key) ? `${doc.typ ?? ''}|` : ''}${num.toUpperCase()}`
      if (seen.has(k)) warn(where, `Possible duplicate: ${c.supplierGstin ? `${c.supplierGstin} / ` : ''}${num} also appears at ${seen.get(k)}.`)
      else seen.set(k, where)
    }
    for (const dk of ['dt', 'boedt', 'docdt', 'oidt', 'ontdt', 'refdt', 'supfildt', 'irngendate', 'oinvdt']) {
      const v = doc[dk]
      if (v === undefined || v === '' || v === null) continue
      if (!validDate(String(v))) { format(where, `${dk} "${v}" is not a valid date (dd-mm-yyyy).`); continue }
    }
    const dt = String(doc[sec.docDateKey] ?? '')
    if (end && validDate(dt) && dateKey(dt) > end) warn(where, `Document date ${dt} is after the return period ${rtnprd}.`)

    // Amounts: the document's own totals when there are no items.
    const lines = c.items ?? [doc]
    const sum = (k: string) => round2(lines.reduce((a, l) => a + (Number(l[k]) || 0), 0))
    if (doc.val !== undefined && doc.val !== '' && 'txval' in (c.items?.[0] ?? doc)) {
      const val = Number(doc.val)
      const total = round2(sum('txval') + sum('igst') + sum('cgst') + sum('sgst') + sum('cess'))
      // Under reverse charge the supplier's invoice usually carries no tax.
      const rcmOk = doc.rev === 'Y' && (Math.abs(val - sum('txval')) <= 1 || Math.abs(val - round2(sum('txval') + sum('cess'))) <= 1)
      if (Math.abs(val - total) > 1 && !rcmOk) {
        warn(where, `Value ${doc.val} ≠ taxable + IGST + CGST + SGST + cess (${total}); difference ${round2(val - total)} (rounding, TCS, non-GST charges or a supplier error).`)
      }
    }
    const typ = String(doc.typ ?? doc.suptyp ?? 'R')
    const igstOnly = ['SEWP', 'SEWOP', 'CBW'].includes(typ) // SEZ / bonded warehouse: IGST even within the state
    // diffprcnt 0.65: the 65% concessional rate — tax is rate × 65%.
    const dp = Number(doc.diffprcnt)
    const factor = dp > 0 && dp < 1 ? dp : 1
    for (const [i, l] of lines.entries()) {
      const at = c.items ? `${where}, item ${i + 1}` : where
      const igst = Number(l.igst) || 0
      const cs = (Number(l.cgst) || 0) + (Number(l.sgst) || 0)
      if (igst && cs) warn(at, 'Both IGST and CGST/SGST on the same line.')
      if (l.rt !== undefined && l.rt !== '' && l.txval !== undefined) {
        const expect = round2((Number(l.txval) || 0) * (Number(l.rt) || 0) / 100 * factor)
        if (Math.abs(expect - (igst + cs)) > 1) warn(at, `Tax ${round2(igst + cs)} ≠ taxable ${l.txval} × ${l.rt}%${factor !== 1 ? ` × ${factor * 100}%` : ''} (${expect}).`)
      }
      const pos = String(doc.pos ?? '')
      if (c.supplierGstin && pos && !igstOnly && sec.key !== 'impg') {
        const intra = c.supplierGstin.slice(0, 2) === pos
        if (intra && igst) warn(at, `Intra-state supply (supplier state ${pos} = place of supply) carries IGST.`)
        if (!intra && cs) warn(at, `Inter-state supply (supplier state ${c.supplierGstin.slice(0, 2)} ≠ place of supply ${pos}) carries CGST/SGST.`)
      }
    }
    if (c.items) {
      for (const k of TAX_KEYS) {
        if (doc[k] !== undefined && Math.abs(Number(doc[k]) - sum(k)) > 0.005) warn(where, `Document ${k} ${doc[k]} ≠ sum of its items (${sum(k)}); the sum is used.`)
      }
    }
  }
}

function checksFromJson(docdata: Json): DocCheck[] {
  const out: DocCheck[] = []
  for (const sec of SECTIONS) {
    const arr = docdata[sec.key]
    if (!Array.isArray(arr)) continue
    arr.forEach((g: Json, gi) => {
      if (sec.shape === 'flat') { out.push({ sec, where: `docdata.${sec.key}[${gi}]`, doc: g, items: null, supplierGstin: null }); return }
      ;((g[sec.listKey!] ?? []) as Json[]).forEach((d, di) => out.push({
        sec, where: `docdata.${sec.key}[${gi}].${sec.listKey}[${di}]`, doc: d,
        items: Array.isArray(d.items) && d.items.length ? d.items as Json[] : null, supplierGstin: String(g.ctin ?? ''),
      }))
    })
  }
  return out
}

// ── public: JSON → Excel ─────────────────────────────────────────────────

export interface Gstr2bExcelResult {
  bytes: Buffer
  sections: { section: string; suppliers: number; documents: number; rows: number }[]
  issues: Issue[]
  selfTest: { pass: boolean; diffs: string[] }
}

const dataOf = (root: Json): Json => (root && typeof root.data === 'object' && root.data !== null ? root.data : root) as Json

/**
 * A large GSTR-2B downloads from the portal as several JSON files. Parts of
 * the same GSTIN and period merge into one: section lists concatenate, and a
 * supplier split across parts becomes one supplier. The first part's header,
 * itcsumm and other keys are kept.
 */
function mergeParts(roots: Json[], names: string[]): Json {
  const base = structuredClone(roots[0])
  const bd = dataOf(base)
  const bdoc = (bd.docdata ??= {}) as Json
  roots.slice(1).forEach((r, i) => {
    const d = dataOf(r)
    if (d.gstin !== bd.gstin || d.rtnprd !== bd.rtnprd) {
      throw new ToolError('invalid_options', `${names[i + 1]} is GSTIN ${d.gstin ?? '?'} / period ${d.rtnprd ?? '?'}, but ${names[0]} is ${bd.gstin ?? '?'} / ${bd.rtnprd ?? '?'}. Upload the parts of one GSTR-2B together.`)
    }
    for (const [k, v] of Object.entries((d.docdata ?? {}) as Json)) {
      if (!Array.isArray(v)) continue
      const target = (bdoc[k] ??= []) as Json[]
      const sec = SECTIONS.find((s) => s.key === k)
      if (!sec || sec.shape === 'flat') { target.push(...(v as Json[])); continue }
      for (const g of v as Json[]) {
        const same = target.find((t) => t.ctin === g.ctin && t.supprd === g.supprd && t.supfildt === g.supfildt)
        if (same) (same[sec.listKey!] = [...((same[sec.listKey!] ?? []) as Json[]), ...((g[sec.listKey!] ?? []) as Json[])])
        else target.push(g)
      }
    }
  })
  return base
}

export async function gstr2bJsonToExcel(input: Buffer | Buffer[], names?: string[]): Promise<Gstr2bExcelResult> {
  const parts = Array.isArray(input) ? input : [input]
  const labels = parts.map((_, i) => names?.[i] ?? `File ${i + 1}`)
  const roots = parts.map((b, i) => {
    try {
      return JSON.parse(b.toString('utf8')) as Json
    } catch {
      throw new ToolError('unreadable', `${parts.length > 1 ? `${labels[i]}: ` : ''}This file isn't valid JSON. Download the GSTR-2B JSON again from the GST portal.`)
    }
  })
  roots.forEach((r, i) => {
    const dd = dataOf(r).docdata
    if (!dd || typeof dd !== 'object') throw new ToolError('empty', `${parts.length > 1 ? `${labels[i]}: ` : ''}This is not a GSTR-2B JSON (no data.docdata found).`)
  })
  const root = roots.length > 1 ? mergeParts(roots, labels) : roots[0]
  const wrapped = root && typeof root.data === 'object' && root.data !== null
  const data = dataOf(root)
  const docdata = data.docdata as Json
  const issues: Issue[] = []
  if (roots.length > 1) issues.push({ severity: 'warning', where: 'files', message: `${roots.length} parts merged into one GSTR-2B (${labels.join(', ')}).` })
  const rtnprd = typeof data.rtnprd === 'string' ? data.rtnprd : null
  if (rtnprd !== null && !/^(0[1-9]|1[0-2])\d{4}$/.test(rtnprd)) issues.push({ severity: 'warning', where: 'rtnprd', message: `Return period "${rtnprd}" is not MMYYYY.` })
  if (typeof data.gstin === 'string' && !GSTIN_RE.test(data.gstin)) issues.push({ severity: 'warning', where: 'gstin', message: `GSTIN "${data.gstin}" is not a valid GSTIN.` })
  normaliseCodes(docdata, issues)
  validateDocs(checksFromJson(docdata), rtnprd, issues)

  const present = SECTIONS.filter((sec) => Array.isArray(docdata[sec.key]))
  const totals = computeItc(docdata)
  const recon = data.itcsumm !== undefined ? reconcileItc(data.itcsumm, totals) : []
  issues.push(...reconIssues(recon))
  for (const k of Object.keys(docdata)) {
    if (!SECTIONS.some((s) => s.key === k)) issues.push({ severity: 'warning', where: `docdata.${k}`, message: `Section "${k}" has no sheet in this layout; it is kept in the hidden _raw sheet and restored on conversion back.` })
  }

  // Sheet order: what the auditor reads first, then the data, then _raw.
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Audit OS'
  // Excel recalculates the summary formulas on open (a cached 0 is not stored).
  wb.calcProperties = { fullCalcOnLoad: true }
  const info = wb.addWorksheet('Info')
  info.columns = [{ header: 'Field', key: 'k', width: 18 }, { header: 'Value', key: 'v', width: 24 }]
  info.getColumn(2).numFmt = '@'
  for (const [label, key] of INFO) if (data[key] !== undefined) info.addRow({ k: label, v: String(data[key]) })
  info.getRow(1).font = { bold: true }
  addItcSheet(wb, present, totals)
  addReconSheet(wb, recon, data.itcsumm !== undefined)
  addSupplierSheet(wb, docdata)
  addFlagsSheet(wb, issues)

  const stats: Gstr2bExcelResult['sections'] = []
  for (const sec of present) {
    const arr = docdata[sec.key] as Json[]
    const rows = rowsOf(sec, arr)
    addSheet(wb, sec, rows)
    const docs = sec.shape === 'flat' ? arr.length : arr.reduce((a, g) => a + ((g[sec.listKey!] as unknown[] | undefined)?.length ?? 0), 0)
    stats.push({ section: sec.sheet, suppliers: sec.shape === 'flat' ? 0 : arr.length, documents: docs, rows: rows.length })
  }

  // Anything the layout has no sheet for, kept verbatim.
  const raw = wb.addWorksheet('_raw')
  raw.state = 'hidden'
  raw.columns = [{ header: 'Key', key: 'k', width: 30 }, { header: 'JSON', key: 'v', width: 80 }]
  raw.addRow({ k: 'wrapped', v: JSON.stringify(wrapped) })
  if (wrapped) for (const [k, v] of Object.entries(root)) if (k !== 'data') raw.addRow({ k: `outer:${k}`, v: JSON.stringify(v) })
  for (const [k, v] of Object.entries(data)) {
    if (k === 'docdata' || INFO.some(([, key]) => key === k)) continue
    raw.addRow({ k: k === 'itcsumm' ? 'itcsumm' : `top:${k}`, v: JSON.stringify(v) })
  }
  if (data.itcsumm === undefined) raw.addRow({ k: 'itcsumm_absent', v: 'true' })
  for (const [k, v] of Object.entries(docdata)) {
    if (SECTIONS.some((s) => s.key === k)) continue
    raw.addRow({ k: `section:${k}`, v: JSON.stringify(v) })
  }

  const out = Buffer.from(await wb.xlsx.writeBuffer())
  // Self-test: back to JSON and compare with the original.
  const back = await gstr2bExcelToJson(out, { strict: false })
  const diffs = deepDiff(root, JSON.parse(back.bytes.toString('utf8')))
  return { bytes: out, sections: stats, issues, selfTest: { pass: diffs.length === 0, diffs: diffs.slice(0, 20) } }
}

function invalid(errors: Issue[]): ToolError {
  const list = errors.slice(0, 8).map((e) => `${e.where}: ${e.message}`).join(' · ')
  return new ToolError('invalid_options', `${errors.length} error${errors.length === 1 ? '' : 's'} — fix ${errors.length === 1 ? 'it' : 'them'} and convert again. ${list}${errors.length > 8 ? ' · …' : ''}`, { issues: errors.slice(0, 200) })
}

// ── public: Excel → JSON ─────────────────────────────────────────────────

export interface Gstr2bJsonResult {
  bytes: Buffer
  sections: { section: string; suppliers: number; documents: number; rows: number }[]
  issues: Issue[]
}

/**
 * `strict` (the default, a workbook someone edited) refuses a malformed GSTIN
 * or date. The self-test of a portal file passes false: it re-reads exactly
 * what the portal sent, flags and all.
 */
export async function gstr2bExcelToJson(bytes: Buffer, opts: { strict?: boolean } = {}): Promise<Gstr2bJsonResult> {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer)
  } catch {
    throw new ToolError('unreadable', "We couldn't open this spreadsheet. It may be corrupted or not a real Excel file.")
  }
  const issues: Issue[] = []
  const warn = (where: string, message: string) => issues.push({ severity: 'warning', where, message })
  const err = (where: string, message: string) => issues.push({ severity: 'error', where, message })

  // _raw first: it says what the original looked like.
  const raw = new Map<string, unknown>()
  const rawWs = wb.worksheets.find((w) => w.name === '_raw')
  rawWs?.eachRow((row, i) => {
    if (i === 1) return
    const k = cellText(row.getCell(1).value)
    try { raw.set(k, JSON.parse(cellText(row.getCell(2).value))) } catch { /* ignore */ }
  })

  const data: Json = {}
  const infoWs = wb.worksheets.find((w) => norm(w.name) === 'info')
  infoWs?.eachRow((row, i) => {
    if (i === 1) return
    const label = norm(cellText(row.getCell(1).value))
    // "Return Period (MMYYYY)" and the like: the label's start is enough.
    const hit = INFO.find(([l]) => label === norm(l) || label.startsWith(norm(l)))
    if (!hit) return
    let v = cellText(row.getCell(2).value).trim()
    if (hit[1] === 'rtnprd' && /^\d{5}$/.test(v)) v = `0${v}` // Excel turned 092026 into 92026
    data[hit[1]] = v
  })
  if (typeof data.rtnprd === 'string' && !/^(0[1-9]|1[0-2])\d{4}$/.test(data.rtnprd)) (opts.strict === false ? warn : err)('Info: Return Period', `"${data.rtnprd}" is not MMYYYY (e.g. 092026).`)
  if (typeof data.gstin === 'string' && data.gstin && !GSTIN_RE.test(data.gstin.toUpperCase())) (opts.strict === false ? warn : err)('Info: GSTIN', `"${data.gstin}" is not a valid GSTIN.`)

  const docdata: Json = {}
  const stats: Gstr2bJsonResult['sections'] = []
  const checks: DocCheck[] = []

  for (const ws of wb.worksheets) {
    const sec = BY_SHEET.get(ws.name.toUpperCase())
    if (!sec) continue
    const header = (ws.getRow(1).values as ExcelJS.CellValue[]).slice(1).map((v) => cellText(v).trim())
    const idx = new Map<string, number>()
    header.forEach((h, i) => { if (h) idx.set(norm(h), i + 1) })
    const colOf = (c: Col) => [c.header, ...(c.aliases ?? [])].map((h) => idx.get(norm(h))).find((x) => x !== undefined)
    const missing = sec.cols.filter((c) => c.required && colOf(c) === undefined)
    if (missing.length) { err(`${ws.name}`, `Required column missing: ${missing.map((c) => c.header).join(', ')}.`); continue }
    const fieldsCol = idx.get('fields'); const extraCol = idx.get('extra')

    // Read and normalise every row.
    type Row = { n: number; v: Record<string, unknown>; fields: { s?: string[]; d?: string[]; i?: string[]; items?: boolean } | null; extra: { s?: Json; d?: Json; i?: Json } }
    const rows: Row[] = []
    const emptyCols = new Set(sec.cols.filter((c) => colOf(c) !== undefined).map((c) => c.key))
    ws.eachRow((row, n) => {
      if (n === 1) return
      const v: Record<string, unknown> = {}
      let any = false
      for (const c of sec.cols) {
        const ci = colOf(c)
        if (ci === undefined) continue
        const cell = row.getCell(ci)
        const where = `${ws.name} row ${n}, ${c.header}`
        const value = readValue(cell.value, c, where, warn, err)
        if (value !== undefined) { v[c.key + '|' + c.level] = value; any = true; if (value !== '') emptyCols.delete(c.key) }
      }
      if (!any) return
      let fields = null; let extra = {}
      try { fields = fieldsCol ? JSON.parse(cellText(row.getCell(fieldsCol).value) || 'null') : null } catch { fields = null }
      try { extra = extraCol ? JSON.parse(cellText(row.getCell(extraCol).value) || '{}') : {} } catch { extra = {} }
      rows.push({ n, v, fields, extra })
    })
    for (const k of emptyCols) {
      const c = sec.cols.find((x) => x.key === k)!
      if (!c.required) warn(`${ws.name}: ${c.header}`, 'Column is empty in every row.')
    }

    const val = (r: Row, key: string, level: Level) => r.v[`${key}|${level}`]
    const has = (r: Row, key: string, level: Level) => `${key}|${level}` in r.v
    // Default shape for sheets typed by hand (no _fields): every column present.
    const keysAt = (r: Row, level: Level): string[] => {
      const listed = r.fields?.[level]
      if (listed) return listed
      return sec.cols.filter((c) => (c.level === level || (level === 'd' && c.level === 'i' && TAX_KEYS.includes(c.key as never))) && has(r, c.key, c.level) && (val(r, c.key, c.level) !== '' || c.kind !== 'num')).map((c) => c.key)
        .filter((k) => !(level === 'd' && (k === 'num' || k === 'rt')))
    }
    const pickLevel = (r: Row, level: Level, keys: string[], extra?: Json): Json => {
      const o: Json = {}
      for (const k of keys) {
        const c = sec.cols.find((x) => x.key === k && (x.level === level || (level === 'd' && x.level === 'i')))
        if (c) {
          const v = val(r, k, c.level)
          o[k] = v === undefined || v === '' ? (c.kind === 'num' ? 0 : '') : v
        } else if (extra && k in extra) o[k] = extra[k]
      }
      for (const [k, v] of Object.entries(extra ?? {})) if (!(k in o)) o[k] = v
      return o
    }

    if (sec.shape === 'flat') {
      const list = rows.map((r) => {
        const d = pickLevel(r, 'd', keysAt(r, 'd'), r.extra.d)
        checks.push({ sec, where: `${ws.name} row ${r.n}`, doc: d, items: null, supplierGstin: null })
        return d
      })
      docdata[sec.key] = list
      stats.push({ section: sec.sheet, suppliers: 0, documents: list.length, rows: rows.length })
      continue
    }

    // Group: supplier (GSTIN + period + filing date) → document number → item rows.
    const suppliers: { head: Json; docs: Map<string, { rows: Row[] }>; firstRow: number }[] = []
    const supIndex = new Map<string, number>()
    for (const r of rows) {
      const ctin = String(val(r, 'ctin', 's') ?? '').toUpperCase()
      const sk = [ctin, val(r, 'supprd', 's') ?? '', val(r, 'supfildt', 's') ?? ''].join('|')
      let si = supIndex.get(sk)
      if (si === undefined) {
        si = suppliers.length
        supIndex.set(sk, si)
        const head = pickLevel(r, 's', keysAt(r, 's'), r.extra.s)
        if ('ctin' in head) head.ctin = ctin
        suppliers.push({ head, docs: new Map(), firstRow: r.n })
      }
      const num = String(val(r, sec.docNumKey, 'd') ?? '')
      if (!num && !r.fields) { err(`${ws.name} row ${r.n}`, `No ${sec.cols.find((c) => c.key === sec.docNumKey)!.header}.`); continue }
      const docs = suppliers[si].docs
      if (!docs.has(num)) docs.set(num, { rows: [] })
      docs.get(num)!.rows.push(r)
    }
    let docCount = 0
    docdata[sec.key] = suppliers.map((s) => {
      const docs = [...s.docs.values()].filter((d) => d.rows.some((r) => !r.fields || (r.fields.d?.length ?? 1) > 0))
      const out: Json = { ...s.head }
      out[sec.listKey!] = docs.map(({ rows: dr }) => {
        docCount++
        const first = dr[0]
        const dKeys = keysAt(first, 'd')
        const doc = pickLevel(first, 'd', dKeys, first.extra.d)
        const hasItems = first.fields ? !!first.fields.items : dr.some((r) => has(r, 'rt', 'i') && val(r, 'rt', 'i') !== '') || dr.length > 1
        let items: Json[] | null = null
        if (hasItems && sec.cols.some((c) => c.level === 'i')) {
          items = dr.map((r, i) => {
            const it = pickLevel(r, 'i', r.fields?.i ?? ['num', 'rt', ...TAX_KEYS], r.extra.i)
            if (!r.fields && (it.num === 0 || it.num === '')) it.num = i + 1
            return it
          })
          // Document totals are the sum of the items.
          for (const k of TAX_KEYS) if (k in doc) doc[k] = round2(items.reduce((a, it) => a + (Number(it[k]) || 0), 0))
          doc.items = items
        }
        checks.push({ sec, where: `${ws.name} row ${first.n}`, doc, items, supplierGstin: String(s.head.ctin ?? '') })
        return doc
      })
      return out
    })
    stats.push({ section: sec.sheet, suppliers: suppliers.length, documents: docCount, rows: rows.length })
  }

  // Unknown sections and top-level keys from _raw.
  for (const [k, v] of raw) {
    if (k.startsWith('section:')) docdata[k.slice(8)] = v
    else if (k.startsWith('top:')) data[k.slice(4)] = v
  }
  for (const ws of wb.worksheets) {
    if (!BY_SHEET.has(ws.name.toUpperCase()) && !REPORT_SHEETS.includes(norm(ws.name)) && ws.rowCount > 1) {
      warn(ws.name, 'Sheet not recognised as a GSTR-2B section — ignored.')
    }
  }
  if (!Object.keys(docdata).length && issues.some((i) => i.severity === 'error')) throw invalid(issues.filter((i) => i.severity === 'error'))
  if (!Object.keys(docdata).length) throw new ToolError('empty', 'No GSTR-2B sheets found. Use the sheet names B2B, B2BA, CDNR, CDNRA, ISD, ISDA, IMPG or IMPGSEZ with this tool\'s column headers.')

  validateDocs(checks, typeof data.rtnprd === 'string' ? data.rtnprd : null, issues, opts.strict ?? true)
  const errors = issues.filter((i) => i.severity === 'error')
  if (errors.length) throw invalid(errors)

  data.docdata = docdata
  // itcsumm: the portal's own, unchanged (a gap to the rows is reported, not
  // written over); built from the rows only for a workbook that never had one.
  const totals = computeItc(docdata)
  if (raw.has('itcsumm')) { data.itcsumm = raw.get('itcsumm'); issues.push(...reconIssues(reconcileItc(data.itcsumm, totals))) }
  else if (!raw.has('itcsumm_absent')) data.itcsumm = itcsummFrom(totals)

  const root: Json = raw.get('wrapped') === false ? data : { data }
  if (raw.get('wrapped') !== false) for (const [k, v] of raw) if (k.startsWith('outer:')) root[k.slice(6)] = v
  return { bytes: Buffer.from(JSON.stringify(root, null, 2)), sections: stats, issues }
}

/**
 * A JSON that carries labels where the portal puts codes ("Regular" for R,
 * "Yes" for Y) is normalised before it is written — the sheet holds codes —
 * and each change is reported. The self-test compares against this.
 */
function normaliseCodes(docdata: Json, issues: Issue[]) {
  const warn = (where: string, message: string) => issues.push({ severity: 'warning', where, message })
  const err = () => undefined
  for (const sec of SECTIONS) {
    const arr = docdata[sec.key]
    if (!Array.isArray(arr)) continue
    const fix = (o: Json, level: Level, where: string) => {
      for (const c of sec.cols) {
        if (c.level !== level || !['yn', 'invtyp', 'nttyp', 'pos', 'rsn'].includes(c.kind) || typeof o[c.key] !== 'string') continue
        const before = o[c.key] as string
        const after = readValue(before, c, `${where}.${c.key}`, warn, err)
        if (after !== before && after !== '') o[c.key] = after
      }
    }
    arr.forEach((g: Json, gi) => {
      if (sec.shape === 'flat') { fix(g, 'd', `docdata.${sec.key}[${gi}]`); return }
      ;((g[sec.listKey!] ?? []) as Json[]).forEach((d, di) => fix(d, 'd', `docdata.${sec.key}[${gi}].${sec.listKey}[${di}]`))
    })
  }
}

/** A cell → the JSON value for its column, normalising labels to portal codes. */
function readValue(v: ExcelJS.CellValue, c: Col, where: string, warn: (w: string, m: string) => void, err: (w: string, m: string) => void): unknown {
  if (v === null || v === undefined) return ''
  if (c.kind === 'num') {
    if (typeof v === 'number') return round2(v)
    const t = cellText(v).replace(/[₹,\s]/g, '')
    if (t === '') return ''
    const n = Number(t)
    if (!Number.isFinite(n)) { err(where, `"${cellText(v)}" is not a number.`); return '' }
    return round2(n)
  }
  let t = cellText(v).trim()
  if (t === '') return ''
  switch (c.kind) {
    case 'gstin': return t.toUpperCase()
    case 'period': return /^\d{5}$/.test(t) ? `0${t}` : t
    case 'date': {
      if (/^\d{4}-\d{2}-\d{2}/.test(t)) { const [y, m, d] = t.slice(0, 10).split('-'); t = `${d}-${m}-${y}` }
      t = t.replace(/[/.]/g, '-')
      return t
    }
    case 'pos': {
      const m = t.match(/^(\d{1,2})\b/)
      if (m && t !== m[1]) { warn(where, `"${t}" read as state code ${m[1].padStart(2, '0')}.`); return m[1].padStart(2, '0') }
      return m ? m[1].padStart(2, '0') : t
    }
    case 'yn': {
      const s = norm(t)
      if (s === 'y' || s === 'n') return s.toUpperCase()
      if (s === 'yes') { warn(where, '"Yes" written as Y.'); return 'Y' }
      if (s === 'no') { warn(where, '"No" written as N.'); return 'N' }
      return t
    }
    case 'invtyp': {
      const up = t.toUpperCase()
      if (up in INV_TYPES) return up
      const hit = Object.entries(INV_TYPES).find(([, label]) => norm(label) === norm(t) || norm(label).startsWith(norm(t)))
      if (hit) { warn(where, `"${t}" written as the code ${hit[0]}.`); return hit[0] }
      return t
    }
    case 'nttyp': {
      const up = t.toUpperCase()
      if (up === 'C' || up === 'D') return up
      if (/credit/i.test(t)) { warn(where, `"${t}" written as C.`); return 'C' }
      if (/debit/i.test(t)) { warn(where, `"${t}" written as D.`); return 'D' }
      return t
    }
    case 'rsn': {
      if (t.length <= 3) return t
      if (/17\s*\(5\)|blocked/i.test(t)) { warn(where, `"${t}" written as the reason code C.`); return 'C' }
      warn(where, `"${t}" is not a portal reason code — kept as typed.`)
      return t
    }
    default: return t
  }
}

/** Paths where two JSON values differ (key order ignored). */
export function deepDiff(a: unknown, b: unknown, path = '$'): string[] {
  if (a === b) return []
  if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9) return []
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: string[] = []
    if (a.length !== b.length) out.push(`${path} (length ${a.length} vs ${b.length})`)
    for (let i = 0; i < Math.min(a.length, b.length); i++) out.push(...deepDiff(a[i], b[i], `${path}[${i}]`))
    return out
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: string[] = []
    const ka = Object.keys(a as Json); const kb = Object.keys(b as Json)
    for (const k of ka) if (!(k in (b as Json))) out.push(`${path}.${k} (missing after round trip)`)
    for (const k of kb) if (!(k in (a as Json))) out.push(`${path}.${k} (added by round trip)`)
    for (const k of ka) if (k in (b as Json)) out.push(...deepDiff((a as Json)[k], (b as Json)[k], `${path}.${k}`))
    return out
  }
  return [`${path} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`]
}
