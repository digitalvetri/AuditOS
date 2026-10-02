// Smoke-run every conversion service against the generated fixtures.
import fs from 'node:fs/promises'
import path from 'node:path'
import { PDFService } from '../services/tools/PDFService.js'
import { ExcelService } from '../services/tools/ExcelService.js'
import { WordService } from '../services/tools/WordService.js'
import { ImageService } from '../services/tools/ImageService.js'
import { OCRService } from '../services/tools/OCRService.js'
import { signatureProvider } from '../services/tools/SignatureProvider.js'
import { run } from '../lib/exec.js'

const fx = new URL("./fixtures/", import.meta.url).pathname

// Typed cell values of one sheet (numbers stay numbers) for expected-vs-actual diffs.
async function sheetValues(xlsx: Buffer, sheetName: string): Promise<(string | number)[][]> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(xlsx as unknown as ArrayBuffer)
  const ws = wb.getWorksheet(sheetName) ?? wb.worksheets[1] ?? wb.worksheets[0]
  const rows: (string | number)[][] = []
  ws.eachRow((row) => {
    const vals: (string | number)[] = []
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = row.getCell(c).value
      vals.push(typeof v === 'number' ? v : v === null || v === undefined ? '' : String(v))
    }
    rows.push(vals)
  })
  return rows
}
async function diffExpected(name: string, actual: (string | number)[][]): Promise<string[]> {
  const expected = JSON.parse(await fs.readFile(path.join(fx, 'expected', name), 'utf8')) as { rows: (string | number)[][] }
  const diffs: string[] = []
  expected.rows.forEach((er, r) => er.forEach((ev, c) => {
    const av = actual[r]?.[c]
    if (av !== ev) diffs.push(`r${r + 1}c${c + 1}: expected ${JSON.stringify(ev)} got ${JSON.stringify(av)}`)
  }))
  if (actual.length !== expected.rows.length) diffs.push(`row count: expected ${expected.rows.length} got ${actual.length}`)
  return diffs
}
const out = path.join(fx, 'out')
await fs.mkdir(out, { recursive: true })
const only = process.argv[2]
const t0 = Date.now()
const step = async (name: string, fn: () => Promise<unknown>) => {
  if (only && !name.includes(only)) return
  const s = Date.now()
  try {
    const r = await fn()
    console.log(`✓ ${name} (${Date.now() - s}ms)`, r === undefined ? '' : JSON.stringify(r).slice(0, 400))
  } catch (e) {
    console.log(`✗ ${name} (${Date.now() - s}ms)`, e instanceof Error ? `${(e as { code?: string }).code ?? ''} ${e.message}` : e)
  }
}

const xlsx = await fs.readFile(path.join(fx, 'invoice.xlsx'))
const docx = await fs.readFile(path.join(fx, 'letter.docx'))
const csv = await fs.readFile(path.join(fx, 'ledger.csv'))
const png = await fs.readFile(path.join(fx, 'scan.png'))
const jpg = await fs.readFile(path.join(fx, 'scan.jpg'))
const webp = await fs.readFile(path.join(fx, 'scan.webp'))

let invoicePdf: Buffer = Buffer.alloc(0)
let letterPdf: Buffer = Buffer.alloc(0)
await step('excel-to-pdf', async () => { invoicePdf = await ExcelService.excelToPdf(xlsx, 'xlsx'); await fs.writeFile(path.join(out, 'invoice.pdf'), invoicePdf); return { pages: await PDFService.pageCount(invoicePdf), bytes: invoicePdf.length } })
await step('word-to-pdf', async () => { letterPdf = await WordService.wordToPdf(docx); await fs.writeFile(path.join(out, 'letter.pdf'), letterPdf); return { pages: await PDFService.pageCount(letterPdf), bytes: letterPdf.length } })
await step('pdf-to-excel', async () => {
  const r = await ExcelService.pdfToExcel(invoicePdf)
  await fs.writeFile(path.join(out, 'invoice-back.xlsx'), r.bytes)
  const diffs = await diffExpected('invoice.pdf-to-excel.json', await sheetValues(r.bytes, 'P1'))
  if (diffs.length) throw new Error(`differs from expected: ${diffs.join('; ')}`)
  return { tables: r.tables, without: r.pagesWithoutTables, matchesExpected: true }
})
await step('pdf-to-word', async () => {
  const r = await WordService.pdfToWord(letterPdf)
  await fs.writeFile(path.join(out, 'letter-back.docx'), r.bytes)
  return { pages: r.pageCount, paragraphs: r.paragraphs, tables: r.tables }
})
await step('csv-to-excel', async () => {
  const r = await ExcelService.csvToExcel(csv)
  await fs.writeFile(path.join(out, 'ledger.xlsx'), r.bytes)
  const diffs = await diffExpected('ledger.csv-to-excel.json', await sheetValues(r.bytes, 'ledger'))
  if (diffs.length) throw new Error(`differs from expected: ${diffs.join('; ')}`)
  return { detection: r.detection, types: r.columnTypes, matchesExpected: true }
})
let imgPdf: Buffer = Buffer.alloc(0)
await step('image-to-pdf', async () => { const r = await ImageService.imagesToPdf([png, jpg, webp], { pageSize: 'A4', orientation: 'auto', marginMm: 10 }); imgPdf = r.bytes; await fs.writeFile(path.join(out, 'images.pdf'), r.bytes); return { pages: r.pageCount, bytes: r.bytes.length } })
let merged: Buffer = Buffer.alloc(0)
await step('merge-pdf', async () => { const r = await PDFService.merge([invoicePdf, letterPdf, imgPdf]); merged = r.bytes; await fs.writeFile(path.join(out, 'merged.pdf'), r.bytes); return { pages: r.pageCount } })
await step('split-pdf', async () => { const n = await PDFService.pageCount(merged); const groups = PDFService.parseRanges(`1, 2-${n}`, n); const parts = await PDFService.split(merged, groups); return { parts: parts.length, pages: await Promise.all(parts.map((p) => PDFService.pageCount(p))) } })
await step('split-pdf invalid range', async () => PDFService.parseRanges('1-99', 3))
await step('compress-pdf', async () => { const r = await PDFService.compress(merged, 'recommended'); await fs.writeFile(path.join(out, 'merged-compressed.pdf'), r); return { before: merged.length, after: r.length } })
await step('thumbnails', async () => { const t = await PDFService.thumbnails(merged, 220); return { count: t.length, firstBytes: t[0]?.length } })
let locked: Buffer = Buffer.alloc(0)
await step('make encrypted pdf (gs)', async () => {
  const inP = path.join(out, 'invoice.pdf'), outP = path.join(out, 'invoice-locked.pdf')
  await run('gs', ['-sDEVICE=pdfwrite', '-dNOPAUSE', '-dBATCH', '-dQUIET', '-sOwnerPassword=owner123', '-sUserPassword=secret', '-dEncryptionR=3', '-dKeyLength=128', `-sOutputFile=${outP}`, inP])
  locked = await fs.readFile(outP)
  return { encrypted: await PDFService.isEncrypted(locked) }
})
await step('unlock-pdf wrong password', async () => PDFService.unlock(locked, 'nope'))
await step('unlock-pdf', async () => { const r = await PDFService.unlock(locked, 'secret'); return { encrypted: await PDFService.isEncrypted(r), pages: await PDFService.pageCount(r) } })
await step('unlock-pdf not encrypted', async () => PDFService.unlock(invoicePdf, 'x'))
await step('pdf-to-excel on encrypted', async () => ExcelService.pdfToExcel(locked))
await step('esign-pdf', async () => { const r = await signatureProvider.apply(letterPdf, { page: 1, placement: 'bottom-right', signerName: 'Ravi Kumar', designation: 'Managing Partner', date: '08 Sep 2026', reason: 'Approved' }); await fs.writeFile(path.join(out, 'letter-signed.pdf'), r.bytes); return r.meta })
await step('pdf-to-word on scan (no text layer)', async () => WordService.pdfToWord(imgPdf))
await step('ocr-scan image', async () => { const r = await OCRService.run({ bytes: png, mime: 'image/png' }, { outputs: ['pdf', 'txt'] }); await fs.writeFile(path.join(out, 'scan-searchable.pdf'), r.pdf!); return { conf: Math.round(r.averageConfidence), text: r.text.slice(0, 200) } })
await step('ocr-scan pdf', async () => { const r = await OCRService.run({ bytes: imgPdf, mime: 'application/pdf' }, { outputs: ['pdf', 'txt'] }); await fs.writeFile(path.join(out, 'images-searchable.pdf'), r.pdf!); const pages = await PDFService.extractText(r.pdf!); return { conf: Math.round(r.averageConfidence), pages: r.pages.length, searchableChars: pages.map((p) => p.charCount) } })
await step('corrupt pdf', async () => PDFService.pageCount(Buffer.from('%PDF-1.4 garbage')))
console.log(`done in ${Date.now() - t0}ms`)
process.exit(0)
