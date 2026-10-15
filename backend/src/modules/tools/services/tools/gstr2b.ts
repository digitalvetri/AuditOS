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
]
const BY_SHEET = new Map(SECTIONS.map((s) => [s.sheet.toUpperCase(), s]))

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

function addSheet(wb: ExcelJS.Workbook, sec: Section, rows: Record<string, unknown>[]) {
  const ws = wb.addWorksheet(sec.sheet)
  const headers = [...sec.cols.map((c) => c.header), ...HIDDEN]
  ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(12, h.length + 2) }))
  sec.cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1)
    // Text cells stay text in Excel: no date parsing, no lost leading zeros.
    col.numFmt = TEXT_KINDS.includes(c.kind) ? '@' : c.key === 'rt' || c.key === 'num' || c.key === 'diffprcnt' ? '0.##' : '0.00'
  })
  HIDDEN.forEach((_, i) => { ws.getColumn(sec.cols.length + i + 1).hidden = true })
  for (const r of rows) {
    const vals = headers.map((h) => {
      const col = sec.cols.find((c) => c.header === h)
      const v = r[h]
      if (v === undefined || v === null) return null
      return col && TEXT_KINDS.includes(col.kind) ? String(v) : v
    })
    ws.addRow(vals)
  }
  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  return ws
}

const colLetter = (n: number) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) } return s }

/** ITC Summary as live formulas over the data sheets (recalculates when rows are edited). */
function addItcSheet(wb: ExcelJS.Workbook, present: Section[], computed: ItcTotals) {
  const ws = wb.addWorksheet('ITC Summary')
  ws.columns = [{ header: 'Part', key: 'p', width: 34 }, { header: 'Section', key: 's', width: 14 },
    { header: 'IGST', key: 'igst', width: 14 }, { header: 'CGST', key: 'cgst', width: 14 }, { header: 'SGST', key: 'sgst', width: 14 }, { header: 'Cess', key: 'cess', width: 14 }]
  const heads = ['igst', 'cgst', 'sgst', 'cess']
  const ref = (sec: Section, key: string) => {
    const i = sec.cols.findIndex((c) => c.key === key)
    return i < 0 ? null : `'${sec.sheet}'!$${colLetter(i + 1)}$2:$${colLetter(i + 1)}$100000`
  }
  const lines: { part: string; sec: string; f: (h: string) => string | null; v: (h: string) => number }[] = []
  const add = (part: string, sec: Section, f: (h: string) => string | null, v: (h: string) => number) => lines.push({ part, sec: sec.sheet, f, v })
  for (const sec of present) {
    const itc = ref(sec, sec.key.startsWith('isd') ? 'itcelg' : 'itcavl')
    if (sec.key === 'b2b' || sec.key === 'b2ba') {
      add('Part A — ITC available', sec, (h) => (ref(sec, h) && itc ? `SUMIFS(${ref(sec, h)},${itc},"Y")` : null), (h) => computed.avl[sec.key]?.[h] ?? 0)
    } else if (sec.key === 'cdnr' || sec.key === 'cdnra') {
      const typ = ref(sec, 'typ')
      add('Part A — credit / debit notes (credit notes negative)', sec,
        (h) => (ref(sec, h) && itc && typ ? `SUMIFS(${ref(sec, h)},${itc},"Y",${typ},"D")-SUMIFS(${ref(sec, h)},${itc},"Y",${typ},"C")` : null),
        (h) => computed.avl[sec.key]?.[h] ?? 0)
    } else if (sec.key === 'impg' || sec.key === 'impgsez') {
      add('Part A — imports', sec, (h) => (ref(sec, h) ? `SUM(${ref(sec, h)})` : null), (h) => computed.avl[sec.key]?.[h] ?? 0)
    } else if (sec.key === 'isd' || sec.key === 'isda') {
      add('Part A — ISD credit', sec, (h) => (ref(sec, h) && itc ? `SUMIFS(${ref(sec, h)},${itc},"Y")` : null), (h) => computed.avl[sec.key]?.[h] ?? 0)
    }
  }
  const firstLine = 2
  for (const l of lines) {
    const r = ws.addRow({ p: l.part, s: l.sec })
    heads.forEach((h, i) => {
      const f = l.f(h)
      r.getCell(3 + i).value = f ? { formula: f, result: l.v(h) } : 0
    })
  }
  const lastLine = firstLine + lines.length - 1
  const net = ws.addRow({ p: 'Net ITC available (Part A)', s: '' })
  heads.forEach((h, i) => { const c = colLetter(3 + i); net.getCell(3 + i).value = lines.length ? { formula: `SUM(${c}${firstLine}:${c}${lastLine})`, result: computed.net[h] } : 0 })
  net.font = { bold: true }
  for (const sec of present.filter((s) => s.key === 'b2b' || s.key === 'b2ba')) {
    const itc = ref(sec, 'itcavl')
    const r = ws.addRow({ p: 'Part B — ITC not available', s: sec.sheet })
    heads.forEach((h, i) => { const rr = ref(sec, h); r.getCell(3 + i).value = rr && itc ? { formula: `SUMIFS(${rr},${itc},"N")`, result: computed.unavl[sec.key]?.[h] ?? 0 } : 0 })
  }
  ws.addRow({})
  ws.addRow({ p: 'Recalculated from the data sheets. On conversion back to JSON, itcsumm is rebuilt from the rows; figures typed here are ignored.' })
  for (let i = 3; i <= 6; i++) ws.getColumn(i).numFmt = '#,##0.00'
  ws.getRow(1).font = { bold: true }
}

// ── itcsumm ──────────────────────────────────────────────────────────────

type Heads = Record<string, number>
interface ItcTotals { avl: Record<string, Heads>; unavl: Record<string, Heads>; net: Heads }

function computeItc(docdata: Json): ItcTotals {
  const z = (): Heads => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 })
  const avl: Record<string, Heads> = {}
  const unavl: Record<string, Heads> = {}
  // A document's tax is its own total, or the sum of its items when it carries none.
  const taxOf = (d: Json, h: string) => d[h] !== undefined ? Number(d[h]) || 0
    : Array.isArray(d.items) ? (d.items as Json[]).reduce((a, it) => a + (Number(it[h]) || 0), 0) : 0
  const addTo = (bucket: Record<string, Heads>, sec: string, d: Json, sign = 1) => {
    const t = (bucket[sec] ??= z())
    for (const h of ['igst', 'cgst', 'sgst', 'cess']) t[h] = round2(t[h] + sign * taxOf(d, h))
  }
  const docs = (sec: string, list: string) => ((docdata[sec] ?? []) as Json[]).flatMap((g) => (g[list] ?? []) as Json[])
  for (const sec of ['b2b', 'b2ba']) {
    if (!Array.isArray(docdata[sec])) continue
    avl[sec] = z(); unavl[sec] = z()
    for (const d of docs(sec, 'inv')) addTo(d.itcavl === 'N' ? unavl : avl, sec, d)
  }
  for (const sec of ['cdnr', 'cdnra']) {
    if (!Array.isArray(docdata[sec])) continue
    avl[sec] = z(); unavl[sec] = z()
    for (const d of docs(sec, 'nt')) addTo(d.itcavl === 'N' ? unavl : avl, sec, d, d.typ === 'C' ? -1 : 1)
  }
  for (const sec of ['isd', 'isda']) {
    if (!Array.isArray(docdata[sec])) continue
    avl[sec] = z(); unavl[sec] = z()
    for (const d of docs(sec, 'doclist')) addTo(d.itcelg === 'N' ? unavl : avl, sec, d, String(d.doctyp ?? '').toUpperCase().startsWith('ISDC') ? -1 : 1)
  }
  if (Array.isArray(docdata.impg)) { avl.impg = z(); for (const d of docdata.impg as Json[]) addTo(avl, 'impg', d) }
  if (Array.isArray(docdata.impgsez)) { avl.impgsez = z(); for (const d of docs('impgsez', 'boe')) addTo(avl, 'impgsez', d) }
  const net = z()
  for (const t of Object.values(avl)) for (const h of Object.keys(net)) net[h] = round2(net[h] + t[h])
  return { avl, unavl, net }
}

/** itcsumm in the portal's shape, from computed totals. */
function itcsummFrom(t: ItcTotals): Json {
  const out: Json = { itcavl: { nonrevsup: { ...t.avl } } }
  if (t.unavl.b2b) out.itcunavl = { nonrevsup: { b2b: t.unavl.b2b } }
  return out
}

/**
 * Every leaf of the ORIGINAL itcsumm that AuditOS can compute is replaced by
 * the computed value; leaves it cannot compute (portal-only figures) are
 * kept. Differences are reported, never silently accepted.
 */
function mergeItc(original: unknown, t: ItcTotals, issues: Issue[]): unknown {
  const nonrevTotals = (bucket: Record<string, Heads>): Heads => {
    const o: Heads = { igst: 0, cgst: 0, sgst: 0, cess: 0 }
    for (const v of Object.values(bucket)) for (const h of Object.keys(o)) o[h] = round2(o[h] + v[h])
    return o
  }
  const computedAt = (path: string[]): number | undefined => {
    const [part, nrs, a, b] = path
    if (nrs !== 'nonrevsup') return undefined
    const bucket = part === 'itcavl' ? t.avl : part === 'itcunavl' ? t.unavl : null
    if (!bucket) return undefined
    if (path.length === 3) return nonrevTotals(bucket)[a]
    if (path.length === 4 && bucket[a]) return bucket[a][b]
    return undefined
  }
  const walk = (node: unknown, path: string[]): unknown => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      return Object.fromEntries(Object.entries(node as Json).map(([k, v]) => [k, walk(v, [...path, k])]))
    }
    if (typeof node === 'number') {
      const c = computedAt(path)
      if (c === undefined) return node
      if (Math.abs(c - node) > 0.005) {
        issues.push({ severity: 'warning', where: `itcsumm.${path.join('.')}`, message: `Recomputed from the rows as ${c}; the original said ${node}. The recomputed figure is used.` })
      }
      return c
    }
    return node
  }
  return walk(original, [])
}

// ── validation ───────────────────────────────────────────────────────────

interface DocCheck { sec: Section; where: string; doc: Json; items: Json[] | null; supplierGstin: string | null }

function periodEnd(rtnprd: string): string | null {
  const m = rtnprd.match(/^(\d{2})(\d{4})$/)
  if (!m || +m[1] < 1 || +m[1] > 12) return null
  const last = new Date(Date.UTC(+m[2], +m[1], 0)).getUTCDate()
  return `${m[2]}${m[1]}${pad2(last)}`
}

function validateDocs(checks: DocCheck[], rtnprd: string | null, issues: Issue[]) {
  const err = (where: string, message: string) => issues.push({ severity: 'error', where, message })
  const warn = (where: string, message: string) => issues.push({ severity: 'warning', where, message })
  const end = rtnprd ? periodEnd(rtnprd) : null
  const seen = new Map<string, string>()
  for (const c of checks) {
    const { sec, doc, where } = c
    if (c.supplierGstin !== null && !GSTIN_RE.test(c.supplierGstin)) {
      err(where, `Supplier GSTIN "${c.supplierGstin}" is not a valid GSTIN (15 characters, e.g. 33AABCS1234L1Z5).`)
    }
    const num = String(doc[sec.docNumKey] ?? '')
    if (num) {
      const k = `${sec.key}|${c.supplierGstin ?? ''}|${num.toUpperCase()}`
      if (seen.has(k)) err(where, `Duplicate document: ${c.supplierGstin ? `${c.supplierGstin} / ` : ''}${num} also appears at ${seen.get(k)}.`)
      else seen.set(k, where)
    }
    for (const dk of ['dt', 'boedt', 'docdt', 'oidt', 'ontdt', 'refdt', 'supfildt', 'irngendate', 'oinvdt']) {
      const v = doc[dk]
      if (v === undefined || v === '' || v === null) continue
      if (!validDate(String(v))) { err(where, `${dk} "${v}" is not a valid date (dd-mm-yyyy).`); continue }
    }
    const dt = String(doc[sec.docDateKey] ?? '')
    if (end && validDate(dt) && dateKey(dt) > end) err(where, `Document date ${dt} is after the return period ${rtnprd}.`)

    // Amounts: the document's own totals when there are no items.
    const lines = c.items ?? [doc]
    const sum = (k: string) => round2(lines.reduce((a, l) => a + (Number(l[k]) || 0), 0))
    if (doc.val !== undefined && doc.val !== '' && 'txval' in (c.items?.[0] ?? doc)) {
      const total = sum('txval') + sum('igst') + sum('cgst') + sum('sgst') + sum('cess')
      if (Math.abs(Number(doc.val) - total) > 1) err(where, `Value ${doc.val} ≠ taxable + IGST + CGST + SGST + cess (${round2(total)}).`)
    }
    const typ = String(doc.typ ?? doc.suptyp ?? 'R')
    const igstOnly = ['SEWP', 'SEWOP', 'CBW'].includes(typ) // SEZ / bonded warehouse: IGST even within the state
    for (const [i, l] of lines.entries()) {
      const at = c.items ? `${where}, item ${i + 1}` : where
      const igst = Number(l.igst) || 0
      const cs = (Number(l.cgst) || 0) + (Number(l.sgst) || 0)
      if (igst && cs) err(at, 'Both IGST and CGST/SGST on the same line.')
      if (l.rt !== undefined && l.rt !== '' && l.txval !== undefined) {
        const expect = (Number(l.txval) || 0) * (Number(l.rt) || 0) / 100
        if (Math.abs(expect - (igst + cs)) > 1) err(at, `Tax ${round2(igst + cs)} ≠ taxable ${l.txval} × ${l.rt}% (${round2(expect)}).`)
      }
      const pos = String(doc.pos ?? '')
      if (c.supplierGstin && pos && !igstOnly && sec.key !== 'impg') {
        const intra = c.supplierGstin.slice(0, 2) === pos
        if (intra && igst) err(at, `Intra-state supply (supplier state ${pos} = place of supply) carries IGST.`)
        if (!intra && cs) err(at, `Inter-state supply (supplier state ${c.supplierGstin.slice(0, 2)} ≠ place of supply ${pos}) carries CGST/SGST.`)
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

export async function gstr2bJsonToExcel(bytes: Buffer): Promise<Gstr2bExcelResult> {
  let root: Json
  try {
    root = JSON.parse(bytes.toString('utf8')) as Json
  } catch {
    throw new ToolError('unreadable', "This file isn't valid JSON. Download the GSTR-2B JSON again from the GST portal.")
  }
  const wrapped = root && typeof root.data === 'object' && root.data !== null
  const data = (wrapped ? root.data : root) as Json
  const docdata = data.docdata as Json | undefined
  if (!docdata || typeof docdata !== 'object') {
    throw new ToolError('empty', 'This is not a GSTR-2B JSON (no data.docdata found).')
  }
  const issues: Issue[] = []
  const rtnprd = typeof data.rtnprd === 'string' ? data.rtnprd : null
  if (rtnprd !== null && !/^(0[1-9]|1[0-2])\d{4}$/.test(rtnprd)) issues.push({ severity: 'error', where: 'rtnprd', message: `Return period "${rtnprd}" is not MMYYYY.` })
  if (typeof data.gstin === 'string' && !GSTIN_RE.test(data.gstin)) issues.push({ severity: 'error', where: 'gstin', message: `GSTIN "${data.gstin}" is not a valid GSTIN.` })
  normaliseCodes(docdata, issues)
  validateDocs(checksFromJson(docdata), rtnprd, issues)

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Audit OS'
  const info = wb.addWorksheet('Info')
  info.columns = [{ header: 'Field', key: 'k', width: 18 }, { header: 'Value', key: 'v', width: 24 }]
  info.getColumn(2).numFmt = '@'
  for (const [label, key] of INFO) if (data[key] !== undefined) info.addRow({ k: label, v: String(data[key]) })
  info.getRow(1).font = { bold: true }

  const present: Section[] = []
  const stats: Gstr2bExcelResult['sections'] = []
  for (const sec of SECTIONS) {
    const arr = docdata[sec.key]
    if (!Array.isArray(arr)) continue
    present.push(sec)
    const rows = rowsOf(sec, arr as Json[])
    addSheet(wb, sec, rows)
    const docs = sec.shape === 'flat' ? arr.length : (arr as Json[]).reduce((a, g) => a + ((g[sec.listKey!] as unknown[] | undefined)?.length ?? 0), 0)
    stats.push({ section: sec.sheet, suppliers: sec.shape === 'flat' ? 0 : arr.length, documents: docs, rows: rows.length })
  }
  addItcSheet(wb, present, computeItc(docdata))

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
    issues.push({ severity: 'warning', where: `docdata.${k}`, message: `Section "${k}" has no sheet in this layout; it is kept in the hidden _raw sheet and restored on conversion back.` })
  }

  const errors = issues.filter((i) => i.severity === 'error')
  if (errors.length) throw invalid(errors)

  const out = Buffer.from(await wb.xlsx.writeBuffer())
  // Self-test: back to JSON and compare with the original.
  const back = await gstr2bExcelToJson(out)
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

export async function gstr2bExcelToJson(bytes: Buffer): Promise<Gstr2bJsonResult> {
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
  if (typeof data.rtnprd === 'string' && !/^(0[1-9]|1[0-2])\d{4}$/.test(data.rtnprd)) err('Info: Return Period', `"${data.rtnprd}" is not MMYYYY (e.g. 092026).`)
  if (typeof data.gstin === 'string' && data.gstin && !GSTIN_RE.test(data.gstin.toUpperCase())) err('Info: GSTIN', `"${data.gstin}" is not a valid GSTIN.`)

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
    if (!BY_SHEET.has(ws.name.toUpperCase()) && !['info', 'itcsummary', 'summary', 'raw', 'validation'].includes(norm(ws.name)) && ws.rowCount > 1) {
      warn(ws.name, 'Sheet not recognised as a GSTR-2B section — ignored.')
    }
  }
  if (!Object.keys(docdata).length && issues.some((i) => i.severity === 'error')) throw invalid(issues.filter((i) => i.severity === 'error'))
  if (!Object.keys(docdata).length) throw new ToolError('empty', 'No GSTR-2B sheets found. Use the sheet names B2B, B2BA, CDNR, CDNRA, ISD, ISDA, IMPG or IMPGSEZ with this tool\'s column headers.')

  validateDocs(checks, typeof data.rtnprd === 'string' ? data.rtnprd : null, issues)
  const errors = issues.filter((i) => i.severity === 'error')
  if (errors.length) throw invalid(errors)

  data.docdata = docdata
  // itcsumm: rebuilt from the rows; the original's shape is kept when it had one.
  const totals = computeItc(docdata)
  if (raw.has('itcsumm')) data.itcsumm = mergeItc(raw.get('itcsumm'), totals, issues)
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
