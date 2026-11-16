import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import PDFDocument from 'pdfkit'
import ExcelJS from 'exceljs'

/** Fixtures for the compliance converters (realistic Indian layouts, synthetic data). */
export const fixture = (f: string) =>
  fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'compliance', f))

/**
 * A one-page PDF of positioned text. Each line is a list of
 * `[x, text, width?]` — with a width the text is right-aligned inside
 * [x, x + width], the way banks print amount columns.
 */
export function positionedPdf(lines: [number, string, number?][][]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 20 })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    doc.font('Helvetica').fontSize(8)
    let y = 40
    for (const line of lines) {
      for (const [x, text, width] of line) {
        if (width) doc.text(text, x, y, { width, align: 'right', lineBreak: false })
        else doc.text(text, x, y, { lineBreak: false })
      }
      y += 16
    }
    doc.end()
  })
}

/** First worksheet named `name` as rows of raw cell values (row 1 = header). */
export async function sheetValues(bytes: Buffer, name: string): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(bytes as unknown as ArrayBuffer)
  const ws = wb.getWorksheet(name)
  if (!ws) throw new Error(`no sheet ${name}; have ${wb.worksheets.map((w) => w.name).join(', ')}`)
  const out: unknown[][] = []
  ws.eachRow({ includeEmpty: false }, (row) => { out.push((row.values as unknown[]).slice(1)) })
  return out
}

export async function workbook(head: string[], rows: unknown[][], opts: { title?: string } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  if (opts.title) { ws.addRow([opts.title]); ws.addRow([]) }
  ws.addRow(head)
  rows.forEach((r) => ws.addRow(r))
  return Buffer.from(await wb.xlsx.writeBuffer())
}
