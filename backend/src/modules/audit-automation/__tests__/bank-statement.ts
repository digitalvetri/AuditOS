/**
 * Bank statement reading — no database.
 *
 *   npx tsx src/modules/audit-automation/__tests__/bank-statement.ts
 *
 * Statements are drawn with pdf-lib to the layouts Indian banks use
 * (header words, right-aligned amounts, wrapped narrations, repeated
 * headers, two-line headers, newest-first order, Amount + Dr/Cr), then
 * read back through the same pdfjs inspection the upload uses.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { inspectPdf } from '../lib/pdfInspect.js'
import { parseStatementPdf, parseStatementTable, parseMoney, parseStatementDate } from '../lib/statementParser.js'
import { classifyDetection } from '../adapters/registry.js'

function fail(what: string, detail: string): never { console.error(`✗ ${what}\n  ${detail}`); process.exit(1) }
function pass(what: string) { console.log(`✓ ${what}`) }
const eq = (what: string, got: unknown, want: unknown) => { if (JSON.stringify(got) !== JSON.stringify(want)) fail(what, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`) }

type Cell = { x: number; t: string; right?: boolean }
async function pdf(pages: Cell[][][]) {
  const doc = await PDFDocument.create(); const f = await doc.embedFont(StandardFonts.Helvetica)
  for (const lines of pages) {
    const p = doc.addPage([842, 595])
    lines.forEach((cells, i) => cells.forEach((c) => { const w = f.widthOfTextAtSize(c.t, 8); p.drawText(c.t, { x: c.right ? c.x - w : c.x, y: 560 - i * 12, size: 8, font: f }) }))
  }
  return inspectPdf(Buffer.from(await doc.save()))
}
const P = (n: bigint | null) => (n === null ? null : Number(n) / 100)

async function main() {
  eq('money', [parseMoney('1,23,456.78'), parseMoney('(500.00)'), parseMoney('500.00 Dr', true), parseMoney('500.00 Cr', true), parseMoney('-'), parseMoney('abc')].map((x) => x === null ? null : Number(x)), [12345678, -50000, -50000, 50000, null, null])
  eq('dates', ['01/04/26', '1 Apr 2026', '05-Apr-2026', '2026-04-05', '31/02/2026'].map(parseStatementDate), ['2026-04-01', '2026-04-01', '2026-04-05', '2026-04-05', null])
  pass('amounts (lakh commas, brackets, Dr/Cr) and dates (dd/mm/yy, d Mon yyyy, ISO; invalid refused)')

  // HDFC-like: letterhead, stated opening/closing, wrapped narration, header repeated on page 2.
  const lh = (n: number): Cell[][] => Array.from({ length: n }, () => [{ x: 30, t: 'HDFC BANK LTD  IFSC: HDFC0001234  Coimbatore' }])
  const hdr: Cell[] = [{ x: 30, t: 'Date' }, { x: 80, t: 'Narration' }, { x: 330, t: 'Chq./Ref.No.' }, { x: 430, t: 'Value Dt' }, { x: 560, t: 'Withdrawal Amt.', right: true }, { x: 660, t: 'Deposit Amt.', right: true }, { x: 780, t: 'Closing Balance', right: true }]
  const r = (d: string, n: string, ref: string, w: string, dep: string, b: string): Cell[] => [{ x: 30, t: d }, { x: 80, t: n }, { x: 330, t: ref }, { x: 430, t: d }, ...(w ? [{ x: 560, t: w, right: true }] : []), ...(dep ? [{ x: 660, t: dep, right: true }] : []), { x: 780, t: b, right: true }]
  const hd = await pdf([
    [...lh(3), [{ x: 30, t: 'Opening Balance : 50,000.00' }], hdr, r('01/04/26', 'UPI-SRI VARI TRADERS & CO', '0612345', '12,500.00', '', '37,500.00'), [{ x: 80, t: '-PAYMENT FOR APRIL' }], r('03/04/26', 'NEFT CR-ICIC0000123-MERIDIAN', 'N0932', '', '1,18,000.00', '1,55,500.00')],
    [...lh(2), hdr, r('07/04/26', 'CHQ PAID-000123-KAVERI', '000123', '45,000.00', '', '1,10,500.00'), [{ x: 30, t: 'Closing Balance : 1,10,500.00' }]],
  ])
  const h = parseStatementPdf(hd.pages)
  eq('hdfc columns', h.columns, ['date', 'narration', 'reference', 'valueDate', 'debit', 'credit', 'balance'])
  eq('hdfc rows', h.rows.map((x) => [x.txnDate, x.narration, x.reference, P(x.debitPaise), P(x.creditPaise), P(x.balancePaise), x.flags]), [
    ['2026-04-01', 'UPI-SRI VARI TRADERS & CO -PAYMENT FOR APRIL', '0612345', 12500, 0, 37500, []],
    ['2026-04-03', 'NEFT CR-ICIC0000123-MERIDIAN', 'N0932', 0, 118000, 155500, []],
    ['2026-04-07', 'CHQ PAID-000123-KAVERI', '000123', 45000, 0, 110500, []],
  ])
  eq('hdfc balances', [P(h.openingBalancePaise), P(h.closingBalancePaise), h.warnings], [50000, 110500, []])
  pass('HDFC layout: wrapped narration joined, page-2 letterhead ignored, stated balances agree')

  // Chain: a misread (swap restores it) is corrected; a real break is flagged.
  const sh: Cell[] = [{ x: 30, t: 'Txn Date' }, { x: 100, t: 'Value Date' }, { x: 170, t: 'Description' }, { x: 610, t: 'Debit', right: true }, { x: 690, t: 'Credit', right: true }, { x: 790, t: 'Balance', right: true }]
  const s = (d: string, n: string, dr: string, cr: string, b: string): Cell[] => [{ x: 30, t: d }, { x: 100, t: d }, { x: 170, t: n }, ...(dr ? [{ x: 610, t: dr, right: true }] : []), ...(cr ? [{ x: 690, t: cr, right: true }] : []), { x: 790, t: b, right: true }]
  const sb = parseStatementPdf((await pdf([[[{ x: 30, t: 'State Bank of India IFSC SBIN0000812' }], sh, s('1 Apr 2026', 'BY TRANSFER', '', '25,000.00', '75,000.00'), s('4 Apr 2026', 'ATM WDL', '', '5,000.00', '70,000.00'), s('6 Apr 2026', 'CHARGES', '17.70', '', '69,000.00')]])).pages)
  eq('sbi flags', sb.rows.map((x) => [P(x.debitPaise), P(x.creditPaise), x.flags]), [[0, 25000, []], [5000, 0, ['AUTO_SWAPPED']], [17.7, 0, ['BALANCE_BREAK']]])
  pass('balance chain: read-wrong-way-round corrected (AUTO_SWAPPED), real break flagged (BALANCE_BREAK)')

  // Two-line header, newest first → chronological.
  const i1: Cell[] = [{ x: 30, t: 'Value' }, { x: 90, t: 'Transaction' }, { x: 250, t: 'Transaction Remarks' }, { x: 560, t: 'Withdrawal', right: true }, { x: 660, t: 'Deposit', right: true }, { x: 780, t: 'Balance', right: true }]
  const i2: Cell[] = [{ x: 30, t: 'Date' }, { x: 90, t: 'Date' }, { x: 560, t: 'Amount (INR)', right: true }, { x: 660, t: 'Amount (INR)', right: true }, { x: 780, t: '(INR)', right: true }]
  const ri = (d: string, n: string, w: string, dep: string, b: string): Cell[] => [{ x: 30, t: d }, { x: 90, t: d }, { x: 250, t: n }, ...(w ? [{ x: 560, t: w, right: true }] : []), ...(dep ? [{ x: 660, t: dep, right: true }] : []), { x: 780, t: b, right: true }]
  const ic = parseStatementPdf((await pdf([[[{ x: 30, t: 'ICICI Bank IFSC ICIC0001234' }], i1, i2, ri('10/04/2026', 'AIRTEL', '999.00', '', '40,001.00'), ri('08/04/2026', 'IMPS RAVI', '', '20,000.00', '41,000.00'), ri('05/04/2026', 'CLG KAVERI', '9,000.00', '', '21,000.00')]])).pages)
  eq('icici order', ic.rows.map((x) => [x.seq, x.txnDate, x.flags]), [[1, '2026-04-05', []], [2, '2026-04-08', []], [3, '2026-04-10', []]])
  pass('two-line header and newest-first order')

  // Amount + Dr/Cr, overdraft balance.
  const ah: Cell[] = [{ x: 30, t: 'Date' }, { x: 100, t: 'Particulars' }, { x: 520, t: 'Amount', right: true }, { x: 560, t: 'Dr/Cr' }, { x: 700, t: 'Balance', right: true }]
  const ra = (d: string, n: string, a: string, dc: string, b: string): Cell[] => [{ x: 30, t: d }, { x: 100, t: n }, { x: 520, t: a, right: true }, { x: 560, t: dc }, { x: 700, t: b, right: true }]
  const cb = parseStatementPdf((await pdf([[ah, ra('01-04-2026', 'CASH DEPOSIT', '10,000.00', 'CR', '2,000.00 Cr'), ra('02-04-2026', 'RTGS', '15,000.00', 'DR', '13,000.00 Dr')]])).pages)
  eq('drcr', cb.rows.map((x) => [P(x.debitPaise), P(x.creditPaise), P(x.balancePaise), x.flags]), [[0, 10000, 2000, []], [15000, 0, -13000, []]])
  pass('Amount + Dr/Cr column and an overdrawn (Dr) balance')

  // Excel / CSV table with a letterhead block above the header.
  const t = parseStatementTable([['Canara Bank statement'], ['IFSC CNRB0001111'], [], ['Txn Date', 'Description', 'Debit', 'Credit', 'Balance'], ['2026-04-01', 'CASH DEPOSIT', '', '10000', '25000'], ['2026-04-02', 'RTGS TO SUPPLIER', '15000.00', '', '10000.00']])
  eq('table', t.rows.map((x) => [x.txnDate, P(x.debitPaise), P(x.creditPaise), x.flags]), [['2026-04-01', 0, 10000, []], ['2026-04-02', 15000, 0, []]])
  eq('no header', parseStatementTable([['a', 'b'], ['1', '2']]).warnings, ['NO_HEADER'])
  pass('Excel/CSV rows: header found below a letterhead; no header → NO_HEADER')

  // Bank recognition from the letterhead only.
  eq('detect', [classifyDetection('hdfc-bank', hd).band, classifyDetection('icici-bank', hd).band, classifyDetection('sbi', hd).band], ['ok', 'mismatch', 'mismatch'])
  const bare = await pdf([[hdr, r('01/04/26', 'X', '1', '', '100.00', '100.00')]])
  eq('detect bare', classifyDetection('hdfc-bank', bare).band, 'uncertain')
  pass('bank recognised from the letterhead; another bank → mismatch; no letterhead → uncertain')

  console.log('All bank statement checks passed.')
}

main().catch((e) => { console.error(e); process.exit(1) })
