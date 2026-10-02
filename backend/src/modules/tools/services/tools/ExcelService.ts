import fs from 'node:fs/promises'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { convertWithLibreOffice, withTempDir } from '../../lib/exec.js'
import { ToolError } from '../errors.js'
import { PDFService, type PageText } from './PDFService.js'
import { CSVService, parseNumber, type ColumnType, type Delimiter, type Encoding } from './CSVService.js'

/**
 * ExcelService — .xlsx in and out.
 *
 *   excelToPdf   LibreOffice, which honours sheet order, column widths, number
 *                formats and puts each sheet on its own page(s).
 *   pdfToExcel   pdfjs text → PDFService.detectTables → one sheet per table,
 *                a Summary sheet naming every page with no table.
 *   csvToExcel   CSVService rows → typed columns, text columns kept as text.
 *   preview      first rows of every sheet for the Documents preview pane.
 */
export interface PdfToExcelResult {
  bytes: Buffer
  tables: number
  pagesWithTables: number[]
  pagesWithoutTables: number[]
  pageCount: number
}

export interface CsvToExcelOptions {
  delimiter?: Delimiter | 'auto'
  encoding?: Encoding | 'auto'
  hasHeader?: boolean | 'auto'
  /** Column indexes (0-based) forced to text, or 'all'. */
  keepAsText?: number[] | 'all'
  sheetName?: string
}

export interface CsvToExcelResult {
  bytes: Buffer
  rows: number
  columns: number
  detection: { encoding: Encoding; delimiter: Delimiter; hasHeader: boolean }
  columnTypes: ColumnType[]
  columnNames: string[]
  skippedRows: number
}

export const ExcelService = {
  async excelToPdf(bytes: Buffer, ext: 'xlsx' | 'xls', opts: { fitToWidth?: boolean } = {}): Promise<Buffer> {
    let source = bytes
    if (opts.fitToWidth !== false && ext === 'xlsx') {
      // Print-ready means every column on the page: set "fit to 1 page wide"
      // on sheets that have no page setup of their own. Sheet order, widths
      // and formats are untouched; if the workbook cannot round-trip, the
      // original bytes are converted as they are.
      try {
        const wb = new ExcelJS.Workbook()
        await wb.xlsx.load(bytes as unknown as ArrayBuffer)
        let touched = false
        for (const ws of wb.worksheets) {
          if (!ws.pageSetup?.fitToPage) {
            ws.pageSetup = { ...ws.pageSetup, fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
            touched = true
          }
        }
        if (touched) source = Buffer.from(await wb.xlsx.writeBuffer())
      } catch {
        source = bytes
      }
    }
    return withTempDir('xls2pdf', async (dir) => {
      const input = path.join(dir, `input.${ext}`)
      await fs.writeFile(input, source)
      let out: string
      try {
        out = await convertWithLibreOffice(input, 'pdf', dir)
      } catch {
        throw new ToolError('unreadable', "We couldn't open this spreadsheet. It may be corrupted or not a real Excel file.")
      }
      return fs.readFile(out)
    })
  },

  async pdfToExcel(bytes: Buffer, onProgress?: (pct: number) => void): Promise<PdfToExcelResult> {
    const pages: PageText[] = await PDFService.extractText(bytes, (done, total) => onProgress?.((done / total) * 70))
    if (!PDFService.hasTextLayer(pages)) {
      throw new ToolError('no_text_layer', 'This PDF has no text layer. Try OCR Scan instead.')
    }
    const wb = new ExcelJS.Workbook()
    wb.creator = 'Audit OS'
    const summary = wb.addWorksheet('Summary')
    summary.columns = [
      { header: 'Page', key: 'page', width: 8 },
      { header: 'Tables found', key: 'tables', width: 14 },
      { header: 'Note', key: 'note', width: 48 },
    ]
    summary.getRow(1).font = { bold: true }

    const pagesWithTables: number[] = []
    const pagesWithoutTables: number[] = []
    let tableCount = 0
    for (const page of pages) {
      const tables = PDFService.detectTables(page)
      if (tables.length === 0) {
        pagesWithoutTables.push(page.page)
        summary.addRow({ page: page.page, tables: 0, note: page.charCount === 0 ? 'No text on this page' : 'No table detected — page skipped' })
        continue
      }
      pagesWithTables.push(page.page)
      summary.addRow({ page: page.page, tables: tables.length, note: '' })
      tables.forEach((rows, i) => {
        tableCount++
        const ws = wb.addWorksheet(`P${page.page}${tables.length > 1 ? `-T${i + 1}` : ''}`)
        writeRows(ws, rows, null)
      })
      onProgress?.(70 + (page.page / pages.length) * 25)
    }
    if (tableCount === 0) throw new ToolError('no_tables', 'No tables were found in this PDF.')
    const out = Buffer.from(await wb.xlsx.writeBuffer())
    return { bytes: out, tables: tableCount, pagesWithTables, pagesWithoutTables, pageCount: pages.length }
  },

  async csvToExcel(bytes: Buffer, opts: CsvToExcelOptions = {}): Promise<CsvToExcelResult> {
    const parsed = CSVService.parse(bytes, { delimiter: opts.delimiter, encoding: opts.encoding, hasHeader: opts.hasHeader })
    const keep = opts.keepAsText === 'all'
      ? new Set(parsed.columns.map((_, i) => i))
      : new Set(opts.keepAsText ?? [])
    const types = parsed.columns.map((t, i) => (keep.has(i) ? 'text' : t))

    const wb = new ExcelJS.Workbook()
    wb.creator = 'Audit OS'
    const ws = wb.addWorksheet((opts.sheetName ?? 'Sheet1').slice(0, 31))
    const body = parsed.detection.hasHeader ? parsed.rows.slice(1) : parsed.rows
    if (parsed.detection.hasHeader) {
      ws.addRow(parsed.columnNames)
      ws.getRow(1).font = { bold: true }
    }
    writeRows(ws, body, types)
    // Column widths from content, capped so a long note does not make a 200-char column.
    parsed.columnNames.forEach((name, i) => {
      const longest = Math.max(name.length, ...body.slice(0, 500).map((r) => (r[i] ?? '').length))
      ws.getColumn(i + 1).width = Math.min(Math.max(10, longest + 2), 60)
    })
    return {
      bytes: Buffer.from(await wb.xlsx.writeBuffer()),
      rows: body.length,
      columns: parsed.columns.length,
      detection: parsed.detection,
      columnTypes: types,
      columnNames: parsed.columnNames,
      skippedRows: parsed.skipped,
    }
  },

  /** Rows of every sheet (first `maxRows`), as display strings. */
  async preview(bytes: Buffer, maxRows = 200): Promise<{ sheets: { name: string; rows: string[][]; truncated: boolean }[] }> {
    const wb = new ExcelJS.Workbook()
    try {
      await wb.xlsx.load(bytes as unknown as ArrayBuffer)
    } catch {
      throw new ToolError('unreadable', "We couldn't open this spreadsheet.")
    }
    const sheets = wb.worksheets.map((ws) => {
      const rows: string[][] = []
      let truncated = false
      ws.eachRow({ includeEmpty: false }, (row, n) => {
        if (n > maxRows) { truncated = true; return }
        const vals: string[] = []
        for (let c = 1; c <= ws.columnCount; c++) vals.push(cellText(row.getCell(c).value))
        rows.push(vals)
      })
      return { name: ws.name, rows, truncated }
    })
    return { sheets }
  },
}

/** Write string rows, converting only clean numbers (and only where the column allows it). */
function writeRows(ws: ExcelJS.Worksheet, rows: string[][], types: ColumnType[] | null) {
  for (const r of rows) {
    const values = r.map((raw, i) => {
      const t = types ? types[i] : 'auto'
      if (t === 'text' || t === 'date') return raw
      const n = parseNumber(raw)
      return n === null ? raw : n
    })
    const row = ws.addRow(values)
    values.forEach((v, i) => {
      if (typeof v === 'string' && v.includes('\n')) row.getCell(i + 1).alignment = { wrapText: true, vertical: 'top' }
      // Cells kept as text render as text even if Excel would guess a number.
      if (typeof v === 'string' && /^\d/.test(v)) row.getCell(i + 1).numFmt = '@'
    })
  }
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10)
    if ('richText' in v) return v.richText.map((t) => t.text).join('')
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue)
    if ('text' in v) return String(v.text)
    if ('error' in v) return String(v.error)
    return JSON.stringify(v)
  }
  return String(v)
}
