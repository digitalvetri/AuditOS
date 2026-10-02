import ExcelJS from 'exceljs'
import { type NormalizedEntry, type ParsedFiling2B, toPaise, toIsoDate } from './types.js'

/**
 * Parser for GSTR-2B Excel downloads from the GSTN portal.
 *
 * Multi-sheet workbook — one sheet per section (B2B, B2BA, CDNR, CDNRA,
 * ISD, ISDA, IMPG, IMPS). The GSTN template puts a title in row 1 and
 * column headers on row 2 (or row 3 in some downloads). We detect the
 * header row by scanning for a known column name ("GSTIN of supplier",
 * "Invoice number", etc.).
 *
 * Amounts are in rupees decimals; toPaise() converts.
 *
 * Header aliases below cover both the offline-utility Excel (short
 * headers) and the online-portal Excel (long headers).
 */

interface SheetSpec {
  section: string
  matchers: RegExp[] // sheet name aliases (case-insensitive)
}

const SHEETS: SheetSpec[] = [
  { section: 'b2b', matchers: [/^b2b$/i, /b2b.*invoices?$/i] },
  { section: 'b2ba', matchers: [/^b2ba$/i, /amendments.*b2b/i] },
  { section: 'cdnr', matchers: [/^cdnr$/i, /credit\/debit notes?/i] },
  { section: 'cdnra', matchers: [/^cdnra$/i, /amendments.*cdnr/i] },
  { section: 'isd', matchers: [/^isd$/i, /^isd.*invoices?$/i] },
  { section: 'isda', matchers: [/^isda$/i, /amendments.*isd/i] },
  { section: 'impg', matchers: [/^impg$/i, /import.*goods/i] },
  { section: 'imps', matchers: [/^imps$/i, /import.*services/i] },
]

/** Header aliases → normalized target field. Case + whitespace insensitive. */
/**
 * Column recognition on the full header text. GSTN's workbook has a
 * two-row header ("Invoice details" over "Invoice number"), so each
 * column is known by "<group> <name>". Order matters: the first alias
 * list a column matches claims it.
 */
const HEADER_ALIASES: [FieldKey, RegExp, RegExp?][] = [
  ['supplierGstin', /gstin.*(supplier|isd)|supplier.*gstin|^gstin$|^ctin$/i],
  ['supplierName', /trade.*name|legal.*name|supplier.*name|isd.*name|^trdnm$/i],
  // Amendments: the "Original details" group is what is being replaced.
  ['originalInvoiceNumber', /original.*(invoice|note|document).*(number|no)|^oinum$/i],
  ['invoiceNumber', /(invoice|note|document|boe|bill of entry).*(number|no\b|num)|^inum$|^ntnum$/i, /original/i],
  ['invoiceDate', /(invoice|note|document|boe|bill of entry).*date|^idt$|^dt$/i, /original/i],
  ['noteType', /(note|document).*type|^typ$/i, /original/i],
  ['taxableValue', /taxable|^txval$/i],
  ['invoiceValue', /(invoice|note|document).*value|^val$/i, /original|taxable/i],
  ['reverseCharge', /reverse\s*charge|^rev$/i],
  ['igst', /^igst|integrated.*tax/i],
  ['cgst', /^cgst|central.*tax/i],
  ['sgst', /^sgst|state.*tax|ut.*tax/i],
  ['cess', /cess/i],
  ['itcAvailable', /itc.*avail|gstr-?3b.*itc|^itcavl$|itc.*eligib/i],
  ['itcReason', /reason|^rsn$/i],
]
type FieldKey = 'supplierGstin' | 'supplierName' | 'originalInvoiceNumber' | 'invoiceNumber' | 'invoiceDate' | 'noteType' | 'taxableValue' | 'invoiceValue' | 'reverseCharge' | 'igst' | 'cgst' | 'sgst' | 'cess' | 'itcAvailable' | 'itcReason'

function colsFor(texts: string[]): Partial<Record<FieldKey, number>> {
  const cols: Partial<Record<FieldKey, number>> = {}
  texts.forEach((t, idx) => {
    if (!t) return
    for (const [key, re, not] of HEADER_ALIASES) {
      if (cols[key]) continue
      if (re.test(t) && !(not && not.test(t))) { cols[key] = idx; break }
    }
  })
  return cols
}

/** The header: one row, or a group row over a name row read as one. */
function findHeaderRow(ws: ExcelJS.Worksheet): { row: number; cols: Partial<Record<FieldKey, number>> } | null {
  const text = (r: number, c: number) => String(ws.getRow(r).getCell(c).text ?? '').replace(/\s+/g, ' ').trim()
  for (let r = 1; r <= Math.min(ws.rowCount, 12); r++) {
    const one: string[] = []
    const two: string[] = []
    for (let c = 1; c <= ws.columnCount; c++) {
      one[c] = text(r, c)
      const below = text(r + 1, c)
      two[c] = below && below !== one[c] ? `${one[c]} ${below}`.trim() : one[c]
    }
    const c2 = colsFor(two)
    if (c2.supplierGstin && c2.invoiceNumber && (c2.taxableValue || c2.igst)) return { row: r + 1, cols: c2 }
    const c1 = colsFor(one)
    if (c1.supplierGstin && c1.invoiceNumber) return { row: r, cols: c1 }
  }
  return null
}

function classifySheet(name: string): string | null {
  for (const s of SHEETS) if (s.matchers.some((re) => re.test(name.trim()))) return s.section
  return null
}

export async function parseGstr2BExcel(bytes: Buffer): Promise<ParsedFiling2B> {
  const wb = new ExcelJS.Workbook()
  try { await wb.xlsx.load(bytes as unknown as ArrayBuffer) } catch {
    throw new Error('gstr2b_excel_invalid')
  }
  const entries: NormalizedEntry[] = []
  let gstin: string | undefined
  let generatedAt: string | undefined

  // Some GSTN downloads have a metadata sheet named "About this file" or
  // "Home" with GSTIN + generated-on. Best-effort pull.
  for (const ws of wb.worksheets) {
    const text = (ws.getCell('A1').text ?? '') + ' ' + (ws.getCell('A2').text ?? '') + ' ' + (ws.getCell('A3').text ?? '')
    const g = /(\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1})/.exec(text)
    if (g && !gstin) gstin = g[1]
    const d = /generated on[:\s]+([\d\-\/\.]+)/i.exec(text)
    if (d && !generatedAt) generatedAt = toIsoDate(d[1])
  }

  for (const ws of wb.worksheets) {
    const section = classifySheet(ws.name)
    if (!section) continue
    const header = findHeaderRow(ws)
    if (!header) continue
    for (let r = header.row + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r)
      const get = (k: FieldKey) => header.cols[k] ? row.getCell(header.cols[k]!) : null
      const gstin = String(get('supplierGstin')?.text ?? '').trim()
      const invNum = String(get('invoiceNumber')?.text ?? '').trim()
      if (!gstin || !invNum) continue
      const itcRaw = String(get('itcAvailable')?.text ?? 'Y').trim().toUpperCase()
      const noteType = String(get('noteType')?.text ?? '').trim().toUpperCase()
      const isNote = section === 'cdnr' || section === 'cdnra'
      const credit = isNote && noteType.startsWith('C')
      const sign = credit ? -1 : 1
      const money = (k: FieldKey) => sign * toPaise(get(k)?.value ?? get(k)?.text ?? 0)
      const eligible = itcRaw !== 'N' && itcRaw !== 'NO'
      entries.push({
        section,
        docType: section === 'impg' ? 'BOE' : section.startsWith('isd') ? 'ISD' : isNote ? (credit ? 'CRN' : 'DBN') : 'INV',
        supplierGstin: gstin,
        supplierName: String(get('supplierName')?.text ?? '').trim() || undefined,
        invoiceNumber: invNum,
        invoiceDate: toIsoDate(get('invoiceDate')?.value ?? get('invoiceDate')?.text ?? ''),
        taxableValue: money('taxableValue'),
        igst: money('igst'),
        cgst: money('cgst'),
        sgst: money('sgst'),
        cess: money('cess'),
        invoiceValue: header.cols.invoiceValue ? money('invoiceValue') : undefined,
        reverseCharge: /^(Y|YES)$/.test(String(get('reverseCharge')?.text ?? '').trim().toUpperCase()),
        originalInvoiceNumber: String(get('originalInvoiceNumber')?.text ?? '').trim() || undefined,
        itcAvailable: eligible,
        itcReason: !eligible ? String(get('itcReason')?.text ?? '').trim() || undefined : undefined,
      })
    }
  }

  return { gstin, generatedAt, entries }
}
