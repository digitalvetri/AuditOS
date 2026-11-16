import { describe, expect, it } from 'vitest'
import { extractInvoice, toIsoDate, toPaise } from '../parsers/invoicePdf.js'
import type { ExtractedPage } from '../lib/pdfInspect.js'

// GSTINs carry valid check digits: a misread one is now marked low confidence.
/** Build a one-page "extracted PDF" from a text layout. Each string is a line;
 *  the extractor sorts by y-descending then x-ascending to approximate reading
 *  order, so top-to-bottom = highest y first. */
function page(lines: string[]): ExtractedPage {
  const items = lines.map((str, i) => ({
    str,
    x: 50,
    y: 800 - i * 20, // top-down
    width: str.length * 5,
    height: 10,
    fontName: 'Helvetica',
  }))
  return { pageNumber: 1, width: 600, height: 842, items }
}

describe('toPaise', () => {
  it.each([
    ['1,80,562.50', 18_056_250],
    ['180562.50', 18_056_250],
    ['100', 10_000],
    ['99.9', 9990],
    ['99.99', 9999],
    ['₹ 1,000.00', 100_000],
  ])('%j → %i paise', (input, expected) => {
    expect(toPaise(input as string)).toBe(expected)
  })

  it('rejects non-numbers', () => {
    expect(toPaise('abc')).toBeNull()
    expect(toPaise('1.234')).toBeNull() // >2 decimal digits
  })
})

describe('toIsoDate', () => {
  it('DD/MM/YYYY → ISO', () => expect(toIsoDate('15', '10', '2026')).toBe('2026-10-15'))
  it('two-digit year normalises: <50 → 20xx, ≥50 → 19xx', () => {
    expect(toIsoDate('15', '10', '26')).toBe('2026-10-15')
    expect(toIsoDate('15', '10', '95')).toBe('1995-10-15')
  })
  it('rejects impossible dates', () => {
    expect(toIsoDate('31', '02', '2026')).toBeNull()
    expect(toIsoDate('29', '02', '2027')).toBeNull() // non-leap
    expect(toIsoDate('29', '02', '2028')).toBe('2028-02-29') // leap
  })
})

describe('extractInvoice — a well-formed Indian tax invoice', () => {
  const invoice = page([
    'ACME TRADERS PRIVATE LIMITED',
    '12/3, Mount Road, Chennai 600002',
    'GSTIN: 33AAACA1234A1ZR',
    '',
    'Tax Invoice',
    'Invoice No: INV-2026-0042   Date: 15/10/2026',
    '',
    'Bill To: WIDGET SUPPLIES LLP',
    'GSTIN: 33AABLA5678B1ZH',
    '',
    'Description            HSN       Qty   Rate     Amount',
    'Audit retainer         998213    1     50000    50,000.00',
    '',
    'Taxable Value: 50,000.00',
    'CGST @ 9%:    4,500.00',
    'SGST @ 9%:    4,500.00',
    'IGST:         0.00',
    '',
    'Grand Total: 59,000.00',
  ])

  const r = extractInvoice([invoice])

  it('picks the supplier GSTIN as the one before BILL TO', () => {
    expect(r.supplierGstin.value).toBe('33AAACA1234A1ZR')
    // Context is 'unknown' (no 'from/seller' label); so confidence is medium
    // via the fallback 'first GSTIN wins' rule — document the behaviour.
    expect(['high', 'medium']).toContain(r.supplierGstin.confidence)
  })

  it('picks the recipient GSTIN under BILL TO', () => {
    expect(r.recipientGstin.value).toBe('33AABLA5678B1ZH')
    expect(r.recipientGstin.confidence).toBe('high')
  })

  it('guesses the supplier name from the top of the page', () => {
    expect(r.supplierName.value).toBe('ACME TRADERS PRIVATE LIMITED')
  })

  it('reads the invoice number with high confidence', () => {
    expect(r.invoiceNumber.value).toBe('INV-2026-0042')
    expect(r.invoiceNumber.confidence).toBe('high')
  })

  it('reads the invoice date and normalises DD/MM/YYYY → YYYY-MM-DD', () => {
    expect(r.invoiceDate.value).toBe('2026-10-15')
    expect(r.invoiceDate.confidence).toBe('high')
  })

  it('reads the money split (paise)', () => {
    expect(r.totalPaise.value).toBe(59_000_00)
    expect(r.taxablePaise.value).toBe(50_000_00)
    expect(r.cgstPaise.value).toBe(4_500_00)
    expect(r.sgstPaise.value).toBe(4_500_00)
    expect(r.igstPaise.value).toBe(0)
  })

  it('collects HSN candidates and filters out year-looking 4-digit numbers', () => {
    expect(r.hsnCandidates).toContain('998213')
    // 2026 looks like a 4-digit HSN but is a year — filter excludes 2000-2099.
    expect(r.hsnCandidates).not.toContain('2026')
  })

  it('exposes the raw text for the reviewer to audit', () => {
    expect(r.rawText).toContain('Grand Total')
  })
})

describe('extractInvoice — a sparse invoice with no labels', () => {
  const r = extractInvoice([page(['33AAACA1234A1ZR', 'random text', '99.00'])])

  it('still finds the GSTIN', () => {
    expect(r.supplierGstin.value).toBe('33AAACA1234A1ZR')
  })

  it('leaves missing fields as nulls with low confidence (not blank strings)', () => {
    expect(r.invoiceNumber.value).toBeNull()
    expect(r.invoiceNumber.confidence).toBe('low')
    expect(r.totalPaise.value).toBeNull()
  })
})
