/**
 * Zoho Payments — invoices read out of PDFs (no database).
 *
 *   npx tsx src/modules/zpay/__tests__/invoice-pdf.ts
 */
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { pdfInvoiceRows } from '../invoice-pdf.js'

function fail(what: string, detail: string): never { console.error(`✗ ${what}\n  ${detail}`); process.exit(1) }
function pass(what: string) { console.log(`✓ ${what}`) }

/** One page per entry; each entry is lines of [x, text] cells at descending y. */
async function pdf(pages: Array<Array<Array<[number, string]>>>): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const lines of pages) {
    const page = doc.addPage([595, 842])
    lines.forEach((cells, i) => { for (const [x, t] of cells) page.drawText(t, { x, y: 800 - i * 18, size: 10, font }) })
  }
  return Buffer.from(await doc.save())
}

const tallyInvoice = (no: string, dated: string, grand: string): Array<Array<[number, string]>> => [
  [[40, 'JNS Accounting Solutions'], [400, 'TAX INVOICE']],
  [[40, 'Invoice No.:'], [120, no]],
  [[40, 'Dated'], [120, dated]],
  [[40, 'Buyer: Meridian Logistics Pvt Ltd']],
  [[40, 'Sl'], [80, 'Description of Services'], [400, 'Amount']],
  [[40, '1'], [80, 'GST return filing for the quarter'], [400, '10,000.00']],
  [[300, 'Sub Total'], [400, '10,000.00']],
  [[300, 'Total Tax'], [400, '1,800.00']],
  [[300, 'Grand Total'], [400, `Rs. ${grand}`]],
  [[40, 'Amount Chargeable (in words): Indian Rupees Eleven Thousand Eight Hundred Only']],
]

async function main() {
  // Two invoices combined in one PDF, Tally-style labels.
  {
    const r = await pdfInvoiceRows(await pdf([tallyInvoice('JNS/26-27/041', '5-Apr-26', '11,800.00'), tallyInvoice('JNS/26-27/042', '06/04/2026', '23,600.00')]))
    const want = [['JNS/26-27/041', '05-04-2026', '11800.00', ''], ['JNS/26-27/042', '06-04-2026', '23600.00', '']]
    if (r.source !== 'invoices' || JSON.stringify(r.rows.slice(1)) !== JSON.stringify(want)) fail('invoices', `got ${r.source} ${JSON.stringify(r.rows)}`)
    pass('combined invoice PDF: number, date and Grand Total per page (not Sub Total / Tax / in words)')
  }

  // A page missing its total is reported, not guessed.
  {
    const noTotal = tallyInvoice('JNS/26-27/043', '07-04-2026', 'x').filter((l) => !l.some(([, t]) => /Grand Total|Sub Total|Total Tax/.test(t)))
    const r = await pdfInvoiceRows(await pdf([tallyInvoice('JNS/26-27/044', '08-04-2026', '1,180.00'), noTotal]))
    if (r.rows.length !== 2 || r.rows[1][0] !== 'JNS/26-27/044') fail('partial', `got ${JSON.stringify(r.rows)}`)
    if (!r.skipped.some((s) => /JNS\/26-27\/043.*total/.test(s))) fail('partial', `skip not reported: ${JSON.stringify(r.skipped)}`)
    pass('an invoice without a readable total is skipped and reported')
  }

  // The Audit OS invoice layout (Invoice # … Place Of Supply on one line;
  // Sub Total / Total / Balance Due): a saved invoice imports, a draft print
  // is refused with the reason.
  {
    const jns = (num: string, total: string): Array<Array<[number, string]>> => [
      [[420, 'TAX INVOICE']],
      [[40, 'JNS Accounting Solutions']],
      [[40, 'Invoice #'], [150, `: ${num}`], [330, 'Place Of Supply'], [440, ': Tamil Nadu (33)']],
      [[40, 'Invoice Date'], [150, ': 27/09/2026']],
      [[40, 'Terms'], [150, ': Due on Receipt']],
      [[40, 'Due Date'], [150, ': 12/10/2026']],
      [[40, 'Bill To'], [330, 'Ship To']],
      [[40, 'Sunrise Textiles LLP']],
      [[40, 'Total In Words'], [330, 'Sub Total'], [480, '10,000.00']],
      [[330, 'Total'], [480, `Rs. ${total}`]],
      [[330, 'Balance Due'], [480, `Rs. ${total}`]],
    ]
    const r = await pdfInvoiceRows(await pdf([jns('JNS/2026-27/0012', '11,800.00')]))
    if (JSON.stringify(r.rows.slice(1)) !== JSON.stringify([['JNS/2026-27/0012', '27-09-2026', '11800.00', '12-10-2026']])) fail('jns layout', `got ${JSON.stringify(r.rows)}`)
    let msg = ''
    try { await pdfInvoiceRows(await pdf([jns('Draft — number on save', '0.00')])) } catch (e) { msg = (e as Error).message }
    if (!/unsaved draft/.test(msg)) fail('jns draft', `got "${msg}"`)
    pass('Audit OS invoice layout: a saved invoice imports; a draft print is refused as a draft')
  }

  // A register: one row per invoice under a header.
  {
    const r = await pdfInvoiceRows(await pdf([[
      [[40, 'Sales Register — April 2026']],
      [[40, 'Invoice No'], [170, 'Date'], [270, 'Customer'], [420, 'Amount'], [500, 'Due Date']],
      [[40, 'INV/2026/0401'], [170, '01-04-2026'], [270, 'Acme Traders'], [420, '11,800.00'], [500, '15-04-2026']],
      [[40, 'INV/2026/0402'], [170, '03-04-2026'], [270, 'Beta Exports'], [420, '5,900.00'], [500, '17-04-2026']],
      [[40, 'Total'], [420, '17,700.00']],
    ]]))
    const want = [['INV/2026/0401', '01-04-2026', '11800.00', '15-04-2026'], ['INV/2026/0402', '03-04-2026', '5900.00', '17-04-2026']]
    if (r.source !== 'register' || JSON.stringify(r.rows.slice(1)) !== JSON.stringify(want)) fail('register', `got ${r.source} ${JSON.stringify(r.rows)}`)
    pass('register PDF: rows read under the header, the Total row ignored')
  }

  // Nothing invoice-like: a clear refusal.
  {
    let msg = ''
    try { await pdfInvoiceRows(await pdf([[[[40, 'Minutes of the board meeting held on the fifth of April with all directors present']], [[40, 'The board approved the accounts for the year and noted the auditor report']]]])) } catch (e) { msg = (e as Error).message }
    if (!/No invoice could be read/.test(msg)) fail('none', `got "${msg}"`)
    pass('a PDF with no invoice in it is refused with a reason')
  }
  console.log('All Zoho Payments invoice-PDF checks passed.')
}

main().catch((e) => { console.error(e); process.exit(1) })
