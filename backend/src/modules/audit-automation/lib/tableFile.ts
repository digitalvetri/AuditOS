import ExcelJS from 'exceljs'
import { ApiError } from '../../../lib/http.js'
import { parseCsv } from '../../zpay/invoice-import.js'
import { parseStatementTable } from './statementParser.js'

/**
 * A bank's Excel / CSV statement download → rows of text cells.
 *
 * Banks put a letterhead block above the table and sometimes more than
 * one sheet, so every sheet is read and the one whose rows carry a
 * statement header wins. Excel dates become YYYY-MM-DD and numbers stay
 * as plain digits — exactly what the statement parser reads.
 */
function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue)
    if ('richText' in v) return v.richText.map((r) => r.text).join('')
    if ('text' in v) return String(v.text)
    return ''
  }
  return String(v).trim()
}

export async function readStatementTable(buffer: Buffer, format: 'xlsx' | 'csv'): Promise<string[][]> {
  if (format === 'csv') {
    const text = buffer.toString('utf8').replace(/^﻿/, '')
    const rows = parseCsv(text)
    if (!rows.length) throw ApiError.unprocessable('empty', 'The CSV file is empty.')
    return rows
  }
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  } catch {
    throw ApiError.unprocessable('unreadable', "This Excel file couldn't be opened. If it is password-protected, download it again without a password (or upload the PDF). Old .xls files must be saved as .xlsx.")
  }
  let best: string[][] = []
  for (const ws of wb.worksheets) {
    const rows: string[][] = []
    ws.eachRow({ includeEmpty: false }, (row) => {
      const out: string[] = []
      row.eachCell({ includeEmpty: true }, (cell, col) => { out[col - 1] = cellText(cell.value) })
      for (let i = 0; i < out.length; i++) out[i] ??= ''
      rows.push(out)
    })
    if (parseStatementTable(rows).columns.length) return rows
    if (!best.length) best = rows
  }
  return best
}
