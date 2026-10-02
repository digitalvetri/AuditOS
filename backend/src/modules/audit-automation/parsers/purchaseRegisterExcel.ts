import ExcelJS from 'exceljs'
import {
  type NormalizedEntry,
  type ParsedPurchaseRegister,
  type PurchaseRegisterColumnMap,
  toPaise,
  toIsoDate,
} from './types.js'

/**
 * Parser for a client's Purchase Register uploaded as Excel.
 *
 * The auditor supplies a column map on the upload wizard (which
 * spreadsheet column feeds each target field) — no header-name
 * detection here because client registers vary wildly. Data starts at
 * `columnMap.dataStartRow` (default 2, i.e. row 1 is headers).
 *
 * Excel column letters (A, B, ..., AA, AB, ...) are converted to 1-based
 * column indices with colLetterToIndex().
 */

function colLetterToIndex(letter: string): number {
  const s = (letter ?? '').toUpperCase().trim()
  if (!/^[A-Z]+$/.test(s)) return 0
  let n = 0
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

export interface PurchaseRegisterPreview {
  sheetName: string
  columns: string[]           // ['A', 'B', 'C', ...] up to first empty
  headerRow: string[]         // trimmed text of row 1 (for the auditor to map by)
  rows: string[][]            // rows 2..11 as text
}

/** Fetch the first 10 data rows for the column-mapping UI. */
export async function previewPurchaseRegister(bytes: Buffer): Promise<PurchaseRegisterPreview> {
  const wb = new ExcelJS.Workbook()
  try { await wb.xlsx.load(bytes as unknown as ArrayBuffer) } catch {
    throw new Error('pr_excel_invalid')
  }
  const ws = wb.worksheets[0]
  if (!ws) throw new Error('pr_excel_empty')

  const maxCol = Math.min(ws.columnCount, 40)
  const columns: string[] = []
  const headerRow: string[] = []
  for (let c = 1; c <= maxCol; c++) {
    const letter = numberToColLetter(c)
    columns.push(letter)
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

function numberToColLetter(n: number): string {
  let s = ''
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
  return s
}

export async function parsePurchaseRegisterExcel(
  bytes: Buffer,
  columnMap: PurchaseRegisterColumnMap,
): Promise<ParsedPurchaseRegister> {
  const wb = new ExcelJS.Workbook()
  try { await wb.xlsx.load(bytes as unknown as ArrayBuffer) } catch {
    throw new Error('pr_excel_invalid')
  }
  const ws = wb.worksheets[0]
  if (!ws) throw new Error('pr_excel_empty')

  const idx = (letter?: string) => letter ? colLetterToIndex(letter) : 0
  const cols = {
    supplierGstin: idx(columnMap.supplierGstin),
    supplierName: idx(columnMap.supplierName),
    invoiceNumber: idx(columnMap.invoiceNumber),
    invoiceDate: idx(columnMap.invoiceDate),
    taxableValue: idx(columnMap.taxableValue),
    igst: idx(columnMap.igst),
    cgst: idx(columnMap.cgst),
    sgst: idx(columnMap.sgst),
    cess: idx(columnMap.cess),
    glCode: idx(columnMap.glCode),
  }
  if (!cols.supplierGstin || !cols.invoiceNumber || !cols.invoiceDate || !cols.taxableValue) {
    throw new Error('pr_column_map_incomplete')
  }
  const startRow = columnMap.dataStartRow ?? 2
  const entries: NormalizedEntry[] = []
  for (let r = startRow; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const get = (c: number) => c ? row.getCell(c) : null
    const gstin = String(get(cols.supplierGstin)?.text ?? '').trim()
    const invNum = String(get(cols.invoiceNumber)?.text ?? '').trim()
    if (!gstin || !invNum) continue
    entries.push({
      supplierGstin: gstin,
      supplierName: String(get(cols.supplierName)?.text ?? '').trim() || undefined,
      invoiceNumber: invNum,
      invoiceDate: toIsoDate(get(cols.invoiceDate)?.value ?? get(cols.invoiceDate)?.text ?? ''),
      taxableValue: toPaise(get(cols.taxableValue)?.value ?? get(cols.taxableValue)?.text ?? 0),
      igst: toPaise(get(cols.igst)?.value ?? get(cols.igst)?.text ?? 0),
      cgst: toPaise(get(cols.cgst)?.value ?? get(cols.cgst)?.text ?? 0),
      sgst: toPaise(get(cols.sgst)?.value ?? get(cols.sgst)?.text ?? 0),
      cess: toPaise(get(cols.cess)?.value ?? get(cols.cess)?.text ?? 0),
      glCode: String(get(cols.glCode)?.text ?? '').trim() || undefined,
    })
  }
  return { entries }
}
