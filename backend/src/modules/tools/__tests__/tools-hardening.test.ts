import { afterEach, describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { CSVService } from '../services/tools/CSVService.js'
import { ExcelService } from '../services/tools/ExcelService.js'
import { WordService } from '../services/tools/WordService.js'
import { PDFService } from '../services/tools/PDFService.js'
import { VisibleMarkProvider } from '../services/tools/SignatureProvider.js'
import { suspectIdentifiers, isValidGstin } from '../lib/identifiers.js'
import { fixture } from './compliance-helpers.js'

async function onePagePdf(): Promise<Buffer> {
  const d = await PDFDocument.create()
  d.addPage([595, 842])
  return Buffer.from(await d.save())
}

describe('OCR identifier check', () => {
  it('validates the GSTIN check digit', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true)
    expect(isValidGstin('27AAPFU0939F1ZW')).toBe(false)
  })

  it('flags a GSTIN-like token that OCR misread, and a PAN-like token of the wrong shape', () => {
    const text = 'GSTIN: 33AAACS1234A12Z5\nSupplier 27AAPFU0939F1ZV\nPAN AAPFU0939F and AAPF0939F'
    const s = suspectIdentifiers(text)
    expect(s).toContain('33AAACS1234A12Z5')
    expect(s).not.toContain('27AAPFU0939F1ZV')
    expect(s).not.toContain('AAPFU0939F')
    expect(s).toContain('AAPF0939F')
  })
})

describe('CSV to Excel on a large file', () => {
  it('parses 200,000 rows without overflowing the stack', () => {
    const csv = ['Voucher,Amount', ...Array.from({ length: 200_000 }, (_, i) => `V${i},${i}.50`)].join('\n')
    const p = CSVService.parse(Buffer.from(csv))
    expect(p.rows.length).toBe(200_001)
  })

  it('refuses a CSV over the row cap with a clear message', async () => {
    const csv = ['A,B', ...Array.from({ length: 500_001 }, (_, i) => `${i},x`)].join('\n')
    await expect(ExcelService.csvToExcel(Buffer.from(csv))).rejects.toThrow(/500,000 rows/)
  })
})

describe('missing system tools are named, not blamed on the file', () => {
  const PATH = process.env.PATH
  afterEach(() => { process.env.PATH = PATH })

  it('Excel to PDF / Word to PDF say LibreOffice is missing', async () => {
    process.env.PATH = '/nonexistent'
    await expect(ExcelService.excelToPdf(Buffer.from('x'), 'xlsx', { fitToWidth: false })).rejects.toThrow(/LibreOffice is not installed/)
    await expect(WordService.wordToPdf(Buffer.from('x'))).rejects.toThrow(/LibreOffice is not installed/)
  })

  it('Compress says Ghostscript is missing', async () => {
    process.env.PATH = '/nonexistent'
    await expect(PDFService.compress(await onePagePdf(), 'recommended')).rejects.toThrow(/Ghostscript is not installed/)
  })
})

describe('Merge with a restrictions-only PDF', () => {
  it('detects owner-password-only encryption', async () => {
    expect(await PDFService.ownerOnly(await fixture('owner-only.pdf'))).toBe(true)
  })

  it('explains that the file has only restrictions and how to clear them', async () => {
    await expect(PDFService.merge([await onePagePdf(), await fixture('owner-only.pdf')]))
      .rejects.toThrow(/only print\/copy restrictions[\s\S]*Unlock PDF[\s\S]*blank/)
  })
})

describe('e-Sign text', () => {
  const sign = new VisibleMarkProvider()

  it('draws ₹ in the reason', async () => {
    const r = await sign.apply(await onePagePdf(), { page: 1, placement: 'bottom-right', signerName: 'Ravi Kumar', date: '16 Nov 2026', reason: 'Fee ₹50,000 approved' })
    expect((await PDFDocument.load(r.bytes)).getPageCount()).toBe(1)
  })

  it('refuses Devanagari with a clear message instead of a generic failure', async () => {
    await expect(sign.apply(await onePagePdf(), { page: 1, placement: 'bottom-right', signerName: 'रवि कुमार', date: '16 Nov 2026' }))
      .rejects.toThrow(/Signer name.*cannot be drawn.*English/)
  })
})
