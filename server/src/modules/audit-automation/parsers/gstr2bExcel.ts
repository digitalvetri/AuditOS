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
const HEADER_ALIASES: Record<string, RegExp[]> = {
  supplierGstin: [/gstin.*supplier/i, /supplier.*gstin/i, /^gstin$/i, /^ctin$/i],
  supplierName: [/trade.*name/i, /supplier.*name/i, /^trdnm$/i],
  invoiceNumber: [/invoice.*(number|no|num)/i, /^inum$/i, /^note.*(number|no)$/i],
  invoiceDate: [/invoice.*date/i, /^idt$/i, /^note.*date$/i],
  taxableValue: [/taxable.*value/i, /^txval$/i, /taxable.*amount/i],
  igst: [/^igst/i, /integrated.*tax/i],
  cgst: [/^cgst/i, /central.*tax/i],
  sgst: [/^sgst/i, /state.*tax/i],
  cess: [/^cess/i],
  itcAvailable: [/itc.*avail/i, /gstr-?3b.*itc/i, /^itcavl$/i],
}

type FieldKey = keyof typeof HEADER_ALIASES

function findHeaderRow(ws: ExcelJS.Worksheet): { row: number; cols: Partial<Record<FieldKey, number>> } | null {
  for (let r = 1; r <= Math.min(ws.rowCount, 10); r++) {
    const row = ws.getRow(r)
    const cols: Partial<Record<FieldKey, number>> = {}
    for (let c = 1; c <= ws.columnCount; c++) {
      const text = String(row.getCell(c).text ?? '').trim()
      if (!text) continue
      for (const key of Object.keys(HEADER_ALIASES) as FieldKey[]) {
        if (cols[key]) continue // first match wins
        if (HEADER_ALIASES[key].some((re) => re.test(text))) cols[key] = c
      }
    }
    // A header row must contain at least the two anchors we can't work without.
    if (cols.supplierGstin && cols.invoiceNumber) return { row: r, cols }
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
      entries.push({
        section,
        supplierGstin: gstin,
        supplierName: String(get('supplierName')?.text ?? '').trim() || undefined,
        invoiceNumber: invNum,
        invoiceDate: toIsoDate(get('invoiceDate')?.value ?? get('invoiceDate')?.text ?? ''),
        taxableValue: toPaise(get('taxableValue')?.value ?? get('taxableValue')?.text ?? 0),
        igst: toPaise(get('igst')?.value ?? get('igst')?.text ?? 0),
        cgst: toPaise(get('cgst')?.value ?? get('cgst')?.text ?? 0),
        sgst: toPaise(get('sgst')?.value ?? get('sgst')?.text ?? 0),
        cess: toPaise(get('cess')?.value ?? get('cess')?.text ?? 0),
        itcAvailable: itcRaw !== 'N' && itcRaw !== 'NO',
      })
    }
  }

  return { gstin, generatedAt, entries }
}
