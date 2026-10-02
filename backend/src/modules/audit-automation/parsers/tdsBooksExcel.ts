import ExcelJS from 'exceljs'
import {
  type NormalizedTdsEntry,
  type ParsedTdsBooks,
  type TdsBooksColumnMap,
  normalizeSection,
  normalizeTan,
  normalizeQuarter,
  tdsDate,
  toPaise,
  TAN_RE,
} from './tdsTypes.js'

/**
 * Parser for the client's Books TDS register uploaded as Excel.
 * The auditor supplies a column map via the wizard.
 *
 * Same shape as purchaseRegisterExcel.ts (GST slice) — colLetterToIndex
 * conversion and preview endpoint.
 */

function colLetterToIndex(letter: string): number {
  const s = (letter ?? '').toUpperCase().trim()
  if (!/^[A-Z]+$/.test(s)) return 0
  let n = 0
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}
function numberToColLetter(n: number): string {
  let s = ''
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
  return s
}

export interface TdsBooksPreview {
  sheetName: string
  columns: string[]
  headerRow: string[]
  rows: string[][]
}

export async function previewTdsBooks(bytes: Buffer): Promise<TdsBooksPreview> {
  const wb = new ExcelJS.Workbook()
  try { await wb.xlsx.load(bytes as unknown as ArrayBuffer) } catch {
    throw new Error('tds_books_excel_invalid')
  }
  const ws = wb.worksheets[0]
  if (!ws) throw new Error('tds_books_excel_empty')
  const maxCol = Math.min(ws.columnCount, 40)
  const columns: string[] = []
  const headerRow: string[] = []
  for (let c = 1; c <= maxCol; c++) {
    columns.push(numberToColLetter(c))
    headerRow.push(String(ws.getRow(1).getCell(c).text ?? '').trim())
  }
  const rows: string[][] = []
  const lastRow = Math.min(ws.rowCount, 11)
  for (let r = 2; r <= lastRow; r++) {
    const row = ws.getRow(r)
    const vals: string[] = []
    for (let c = 1; c <= maxCol; c++) vals.push(String(row.getCell(c).text ?? '').trim())
    rows.push(vals)
  }
  return { sheetName: ws.name, columns, headerRow, rows }
}

export async function parseTdsBooksExcel(
  bytes: Buffer,
  columnMap: TdsBooksColumnMap,
): Promise<ParsedTdsBooks> {
  const wb = new ExcelJS.Workbook()
  try { await wb.xlsx.load(bytes as unknown as ArrayBuffer) } catch {
    throw new Error('tds_books_excel_invalid')
  }
  const ws = wb.worksheets[0]
  if (!ws) throw new Error('tds_books_excel_empty')

  const idx = (letter?: string) => letter ? colLetterToIndex(letter) : 0
  const cols = {
    deductorTan: idx(columnMap.deductorTan),
    deductorName: idx(columnMap.deductorName),
    section: idx(columnMap.section),
    quarter: idx(columnMap.quarter),
    amountPaid: idx(columnMap.amountPaid),
    tdsAmount: idx(columnMap.tdsAmount),
    tdsDate: idx(columnMap.tdsDate),
    glCode: idx(columnMap.glCode),
    reference: idx(columnMap.reference),
  }
  // A deductor (TAN or name), the TDS amount and a date are needed; the section is optional.
  if ((!cols.deductorTan && !cols.deductorName) || !cols.tdsAmount || !cols.tdsDate) {
    throw new Error('tds_books_column_map_incomplete')
  }
  const startRow = columnMap.dataStartRow ?? 2
  const entries: NormalizedTdsEntry[] = []
  for (let r = startRow; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const get = (c: number) => c ? row.getCell(c) : null
    const tanRaw = normalizeTan(String(get(cols.deductorTan)?.text ?? ''))
    const tan = TAN_RE.test(tanRaw) ? tanRaw : ''
    const name = String(get(cols.deductorName)?.text ?? '').trim()
    const section = normalizeSection(String(get(cols.section)?.text ?? ''))
    const tdsAmount = toPaise(get(cols.tdsAmount)?.value ?? get(cols.tdsAmount)?.text ?? 0)
    if ((!tan && !name) || tdsAmount === 0) continue
    const quarterField = get(cols.quarter)?.text ?? ''
    const dateField = get(cols.tdsDate)?.value ?? get(cols.tdsDate)?.text ?? ''
    entries.push({
      section,
      deductorTan: tan,
      deductorName: name || undefined,
      quarter: normalizeQuarter(String(quarterField) || tdsDate(dateField)),
      amountPaid: toPaise(get(cols.amountPaid)?.value ?? get(cols.amountPaid)?.text ?? 0),
      tdsAmount,
      tdsDate: tdsDate(dateField),
      glCode: String(get(cols.glCode)?.text ?? '').trim() || undefined,
      reference: String(get(cols.reference)?.text ?? '').trim() || undefined,
    })
  }
  return { entries }
}
