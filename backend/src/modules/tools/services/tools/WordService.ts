import fs from 'node:fs/promises'
import path from 'node:path'
import ExcelJS from 'exceljs'
import {
  AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx'
import { convertWithLibreOffice, withTempDir, requireBinary } from '../../lib/exec.js'
import { ToolError } from '../errors.js'
import { PDFService, findTableBlocks, type PageText, type TextLine } from './PDFService.js'

/**
 * WordService — .docx in and out.
 *
 *   wordToPdf    LibreOffice (headings, lists, tables, page breaks preserved).
 *   pdfToWord    pdfjs layout → paragraphs, headings (by font size / weight)
 *                and tables (same detector as PDF to Excel) → docx.
 *                Text-layer PDFs only; a scan is refused with a pointer to OCR.
 *   wordToExcel  routes through PDF: docx → PDF via LibreOffice, then the
 *                proven pdfToExcel table detector. Keeps a single code path
 *                for "what counts as a table"; Word-only paragraph prose is
 *                reported on the Summary sheet, not pretend-tabled.
 *   excelToWord  reads xlsx via ExcelJS and renders each sheet as a heading
 *                + docx table. Numeric and date cells become plain text in
 *                the cell; nothing is lost but the formulas are flattened to
 *                their last cached values.
 */
export interface PdfToWordResult {
  bytes: Buffer
  pageCount: number
  paragraphs: number
  tables: number
}

export interface ExcelToWordResult {
  bytes: Buffer
  sheets: number
  rows: number
  skippedSheets: string[]
}

export const WordService = {
  async wordToPdf(bytes: Buffer): Promise<Buffer> {
    return withTempDir('doc2pdf', async (dir) => {
      const input = path.join(dir, 'input.docx')
      await fs.writeFile(input, bytes)
      let out: string
      try {
        out = await convertWithLibreOffice(input, 'pdf', dir)
      } catch {
        await requireBinary('soffice', 'LibreOffice')
        throw new ToolError('unreadable', "We couldn't open this document. It may be corrupted or not a real Word file.")
      }
      return fs.readFile(out)
    })
  },

  async pdfToWord(bytes: Buffer, onProgress?: (pct: number) => void): Promise<PdfToWordResult> {
    const pages: PageText[] = await PDFService.extractText(bytes, (done, total) => onProgress?.((done / total) * 70))
    if (!PDFService.hasTextLayer(pages)) {
      throw new ToolError('no_text_layer', 'This PDF has no text layer. Try OCR Scan instead.')
    }
    const bodySize = medianFontSize(pages)
    const children: (Paragraph | Table)[] = []
    let paragraphs = 0
    let tables = 0

    pages.forEach((page, idx) => {
      const blocks = segment(page.lines)
      for (const block of blocks) {
        if (block.kind === 'table') {
          tables++
          children.push(makeTable(block.rows))
          children.push(new Paragraph({ text: '' }))
          continue
        }
        const para = block.lines
        // Bullet lines become list items, one paragraph each.
        if (para.some((l) => l.cells[0]?.text.startsWith('• '))) {
          for (const l of para) {
            const t = l.cells.map((c) => c.text).join(' ').replace(/^•\s*/, '').trim()
            if (!t) continue
            paragraphs++
            children.push(new Paragraph({ children: [new TextRun({ text: t })], bullet: { level: 0 }, spacing: { after: 60 } }))
          }
          continue
        }
        const size = Math.max(...para.map((l) => l.h))
        const bold = para.every((l) => l.cells.every((c) => c.bold))
        const text = para.map((l) => l.cells.map((c) => c.text).join(' ')).join(' ').replace(/\s{2,}/g, ' ').trim()
        if (!text) continue
        paragraphs++
        const ratio = size / bodySize
        const heading = ratio >= 1.6 ? HeadingLevel.HEADING_1 : ratio >= 1.3 ? HeadingLevel.HEADING_2 : (ratio >= 1.12 && bold) || (bold && para.length === 1 && text.length < 80) ? HeadingLevel.HEADING_3 : null
        const centred = isCentred(para, page.width)
        children.push(new Paragraph({
          heading: heading ?? undefined,
          alignment: centred ? AlignmentType.CENTER : AlignmentType.LEFT,
          spacing: { after: 120 },
          children: [new TextRun({ text, bold: heading ? undefined : bold, size: heading ? undefined : Math.round(Math.min(Math.max(size, 8), 18) * 2) })],
        }))
      }
      if (idx < pages.length - 1) children.push(new Paragraph({ text: '', pageBreakBefore: true }))
      onProgress?.(70 + ((idx + 1) / pages.length) * 25)
    })

    const doc = new Document({
      creator: 'Audit OS',
      styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
      sections: [{ children: children.length ? children : [new Paragraph({ text: '' })] }],
    })
    return { bytes: Buffer.from(await Packer.toBuffer(doc)), pageCount: pages.length, paragraphs, tables }
  },

  async excelToWord(bytes: Buffer, onProgress?: (pct: number) => void): Promise<ExcelToWordResult> {
    const wb = new ExcelJS.Workbook()
    try {
      await wb.xlsx.load(bytes as unknown as ArrayBuffer)
    } catch {
      throw new ToolError('unreadable', "We couldn't open this spreadsheet. It may be corrupted or not a real Excel file.")
    }
    onProgress?.(20)

    const children: (Paragraph | Table)[] = []
    let sheetCount = 0
    let rowCount = 0
    const skippedSheets: string[] = []
    const sheets = wb.worksheets
    sheets.forEach((ws, idx) => {
      const rows: string[][] = []
      let maxCols = 0
      ws.eachRow({ includeEmpty: false }, (row) => {
        const vals: string[] = []
        const n = Math.max(ws.columnCount, row.cellCount)
        for (let c = 1; c <= n; c++) vals.push(cellText(row.getCell(c).value))
        // Trim all-empty trailing cells so a 1,048,576-column sheet does not blow up the doc.
        while (vals.length && vals[vals.length - 1] === '') vals.pop()
        if (vals.length) {
          rows.push(vals)
          if (vals.length > maxCols) maxCols = vals.length
        }
      })
      if (!rows.length) { skippedSheets.push(ws.name); return }
      sheetCount++
      rowCount += rows.length
      // One sheet = one heading + one table.
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: ws.name })], spacing: { before: 240, after: 120 } }))
      children.push(renderTable(rows, maxCols))
      if (idx < sheets.length - 1) children.push(new Paragraph({ text: '' }))
      onProgress?.(20 + ((idx + 1) / sheets.length) * 70)
    })
    if (!sheetCount) throw new ToolError('no_tables', 'This spreadsheet has no data in any sheet.')

    const doc = new Document({
      creator: 'Audit OS',
      styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
      sections: [{ children }],
    })
    return { bytes: Buffer.from(await Packer.toBuffer(doc)), sheets: sheetCount, rows: rowCount, skippedSheets }
  },
}

type Block = { kind: 'para'; lines: TextLine[] } | { kind: 'table'; rows: string[][] }

/**
 * Walk a page's lines top to bottom. Table runs (from findTables) become
 * table blocks; everything else groups into paragraphs at a vertical gap
 * bigger than ~1.5 line heights or a font-size change.
 */
function segment(lines: TextLine[]): Block[] {
  const tableBlocks = findTableBlocks(lines)
  const blocks: Block[] = []
  let para: TextLine[] = []
  const flushPara = () => { if (para.length) blocks.push({ kind: 'para', lines: para }); para = [] }
  let i = 0
  let t = 0
  while (i < lines.length) {
    const tb = tableBlocks[t]
    if (tb && i === tb.start) {
      flushPara()
      blocks.push({ kind: 'table', rows: tb.rows })
      i = tb.end + 1
      t++
      continue
    }
    const l = lines[i]
    const prev = para[para.length - 1]
    if (prev) {
      const gap = prev.y - l.y
      const sizeChange = Math.abs(prev.h - l.h) > 1.5
      if (gap > Math.max(prev.h, l.h) * 1.55 || sizeChange) flushPara()
    }
    para.push(l)
    i++
  }
  flushPara()
  return blocks
}

function medianFontSize(pages: PageText[]): number {
  const sizes: number[] = []
  for (const p of pages) for (const l of p.lines) for (const c of l.cells) sizes.push(Math.round(c.h * 2) / 2)
  if (!sizes.length) return 11
  sizes.sort((a, b) => a - b)
  return sizes[Math.floor(sizes.length / 2)] || 11
}

function isCentred(lines: TextLine[], pageWidth: number): boolean {
  return lines.every((l) => {
    const x0 = Math.min(...l.cells.map((c) => c.x0))
    const x1 = Math.max(...l.cells.map((c) => c.x1))
    const left = x0, right = pageWidth - x1
    return left > pageWidth * 0.15 && Math.abs(left - right) < pageWidth * 0.08
  })
}

function makeTable(rows: string[][]): Table {
  const width = Math.max(...rows.map((r) => r.length))
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((r, ri) => new TableRow({
      tableHeader: ri === 0,
      children: Array.from({ length: width }, (_, c) => new TableCell({
        children: (r[c] ?? '').split('\n').map((line) => new Paragraph({ children: [new TextRun({ text: line, bold: ri === 0 })] })),
      })),
    })),
  })
}

/** A sheet-to-table renderer: same shape as makeTable but takes an explicit column count. */
function renderTable(rows: string[][], cols: number): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((r, ri) => new TableRow({
      tableHeader: ri === 0,
      children: Array.from({ length: cols }, (_, c) => new TableCell({
        children: (r[c] ?? '').split('\n').map((line) => new Paragraph({ children: [new TextRun({ text: line, bold: ri === 0 })] })),
      })),
    })),
  })
}

/** Same resolver used by ExcelService.preview — kept inline to avoid a cross-service import. */
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
