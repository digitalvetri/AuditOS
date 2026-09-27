/**
 * TDS: 26AS readers, books readers and the matcher — no database.
 *
 * Run:  npx tsx src/modules/audit-automation/__tests__/tds-matching.ts
 */
import { runTdsMatcher, type TdsEntry } from '../services/TdsMatchingService.js'
import { parseTds26ASText } from '../parsers/tds26ASText.js'
import { parseTdsBooksTallyXml } from '../parsers/tdsBooksTallyXml.js'
import { normalizeSection } from '../parsers/tdsTypes.js'

function pass(name: string) { console.log(`✓ ${name}`) }
function fail(name: string, detail: string): never { console.error(`✗ ${name}\n  ${detail}`); process.exit(1) }
const eq = (name: string, got: unknown, want: unknown) => { if (JSON.stringify(got) !== JSON.stringify(want)) fail(name, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`) }

// ── section codes ────────────────────────────────────────────────────
eq('sections', ['Sec 194C', '194 C', 'TDS on Contract 194C @2%', '194IA', '194I(b)', '194-I', '194J(a)', '194LBC', '206C(1H)', '206CL', 'TDS on Rent'].map(normalizeSection),
  ['194C', '194C', '194C', '194IA', '194I', '194I', '194J', '194LBC', '206C1H', '206CL', '']);
pass('sections: 194IA stays 194IA (not 194I), sub-clauses dropped, TCS 206C(1H), no code → blank')

// ── TRACES text 26AS ─────────────────────────────────────────────────
const txt = [
  'Annual Tax Statement^',
  'File Creation Date^Permanent Account Number (PAN)^Current Status of PAN^Financial Year^Assessment Year^Name of Assessee^Address Line 1',
  '14-06-2027^AAACR5055K^Active^2026-27^2027-28^RAVI TRADERS^CHENNAI',
  '^',
  'PART-I - Details of Tax Deducted at Source^',
  'Sr. No.^Name of Deductor^TAN of Deductor^^^^^Total Amount Paid / Credited(Rs.)^Total Tax Deducted(Rs.)^Total TDS Deposited(Rs.)',
  '1^ACME STEEL PRIVATE LIMITED^MUMA12345B^^^^^150000.00^15000.00^15000.00',
  '^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks^Amount Paid / Credited(Rs.)^Tax Deducted(Rs.)^TDS Deposited(Rs.)',
  '^1^194J^15-Jun-2026^F^20-Aug-2026^-^100000.00^10000.00^10000.00',
  '^2^194J^30-Sep-2026^U^20-Nov-2026^-^50000.00^5000.00^4000.00',
  '2^KAVERI LOGISTICS LLP^CHEK99999Z^^^^^200000.00^4000.00^4000.00',
  '^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks^Amount Paid / Credited(Rs.)^Tax Deducted(Rs.)^TDS Deposited(Rs.)',
  '^1^194C^31-Jul-2026^F^15-Oct-2026^-^200000.00^4000.00^4000.00',
  'PART-II - Details of Tax Deducted at Source for 15G / 15H^',
  'No Transactions Present^',
  'PART-VI - Details of Tax Collected at Source^',
  'Sr. No.^Name of Collector^TAN of Collector^^^^^Total Amount Paid/ Debited(Rs.)^Total Tax Collected(Rs.)^Total TCS Deposited(Rs.)',
  '1^DELTA MOTORS^CHED11111A^^^^^1200000.00^12000.00^12000.00',
  '^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks^Amount Paid/ Debited(Rs.)^Tax Collected(Rs.)^TCS Deposited(Rs.)',
  '^1^206CL^05-May-2026^F^10-Jul-2026^-^1200000.00^12000.00^12000.00',
  'PART-VIII - Details of Tax Deducted at Source u/s 194IA/ 194IB /194M/194S (For Buyer/Tenant of Property)^',
  'Sr. No.^Acknowledgement Number^Name of Deductee^PAN of Deductee^Transaction Date^Total Transaction Amount^Total TDS Deposited',
  '1^AB1234^SOMEONE^ABCPE1234F^10-Oct-2026^5000000.00^50000.00',
].join('\r\n')
const p26 = parseTds26ASText(Buffer.from(txt))
eq('26AS header', [p26.pan, p26.financialYear, p26.assessmentYear, p26.assesseeName, p26.generatedAt], ['AAACR5055K', '2026-27', 2027, 'RAVI TRADERS', '2027-06-14'])
eq('26AS rows', p26.entries.map((e) => [e.part, e.deductorTan, e.section, e.tdsDate, e.quarter, e.status, e.tdsAmount, e.tdsDeposited]), [
  ['part_i', 'MUMA12345B', '194J', '2026-06-15', 'Q1', 'F', 1000000, 1000000],
  ['part_i', 'MUMA12345B', '194J', '2026-09-30', 'Q2', 'U', 500000, 400000],
  ['part_i', 'CHEK99999Z', '194C', '2026-07-31', 'Q2', 'F', 400000, 400000],
  ['part_vi', 'CHED11111A', '206CL', '2026-05-05', 'Q1', 'F', 1200000, 1200000],
])
eq('26AS names', p26.entries[0].deductorName, 'ACME STEEL PRIVATE LIMITED')
pass('TRACES text 26AS: header (PAN/FY/AY), TAN carried from the deductor row, status U/F, deposited, Part VI TCS read, Part VIII (as deductor) skipped')

// ── books: TDS receivable from Tally receipts ────────────────────────
const xml = `<ENVELOPE><BODY><DATA>
<TALLYMESSAGE><VOUCHER VCHTYPE="Receipt"><DATE>20260620</DATE><VOUCHERNUMBER>RC-1</VOUCHERNUMBER><PARTYLEDGERNAME>Acme Steel Pvt. Ltd.</PARTYLEDGERNAME>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Acme Steel Pvt. Ltd.</LEDGERNAME><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>100000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>HDFC Bank</LEDGERNAME><AMOUNT>-90000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>TDS Receivable 194J</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-10000.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>
<TALLYMESSAGE><VOUCHER VCHTYPE="Purchase"><DATE>20260620</DATE><PARTYLEDGERNAME>Vendor</PARTYLEDGERNAME>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>TDS Payable 194C</LEDGERNAME><AMOUNT>2000.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>
<TALLYMESSAGE><VOUCHER VCHTYPE="Journal"><DATE>20260705</DATE><VOUCHERNUMBER>JV-3</VOUCHERNUMBER><PARTYLEDGERNAME>Kaveri Logistics</PARTYLEDGERNAME><PARTYGSTIN>33AAACR5055K1ZE</PARTYGSTIN>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Kaveri Logistics</LEDGERNAME><AMOUNT>2000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>TDS Receivable</LEDGERNAME><AMOUNT>-2000.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>
</DATA></BODY></ENVELOPE>`
const bk = parseTdsBooksTallyXml(Buffer.from(xml))
eq('books', bk.entries.map((e) => [e.deductorName, e.deductorTan, e.section, e.tdsAmount, e.amountPaid, e.reference, e.voucherType]), [
  ['Acme Steel Pvt. Ltd.', '', '194J', 1000000, 10000000, 'RC-1', 'Receipt'],
  ['Kaveri Logistics', '', '', 200000, 200000, 'JV-3', 'Journal'],
])
pass('Tally books: TDS receivable debits from receipts/journals; TDS payable in purchases skipped; GSTIN never used as a TAN')

// ── matcher ──────────────────────────────────────────────────────────
let n = 0
const e = (p: Partial<TdsEntry>): TdsEntry => ({ id: `x${++n}`, section: '194J', deductorTan: 'MUMA12345B', deductorName: 'ACME STEEL PRIVATE LIMITED', quarter: 'Q1', amountPaid: 10000000, tdsAmount: 1000000, tdsDate: '2026-06-15', ...p })
{
  const two = [
    e({ id: 'A1' }),                                                                                     // exact
    e({ id: 'A2', tdsDate: '2026-09-30', quarter: 'Q2', tdsAmount: 500000, tdsDeposited: 400000, status: 'U' }), // window (books in Q3, 10 days later), status U, short deposit
    e({ id: 'A3', deductorTan: 'CHEK99999Z', deductorName: 'KAVERI LOGISTICS LLP', section: '194C', tdsAmount: 400000, tdsDate: '2026-07-31', quarter: 'Q2' }), // grouped: two books entries
    e({ id: 'A4', section: '194IA', tdsAmount: 300000, tdsDate: '2026-05-10' }),                         // not 194I — a variance on section, never verified
    e({ id: 'A5', deductorTan: 'BLRA00001A', deductorName: 'ZETA', tdsAmount: 800000, tdsDate: '2026-11-10', quarter: 'Q3' }), // variance vs Z1
  ]
  const books = [
    e({ id: 'B1', deductorTan: '', deductorName: 'Acme Steel Pvt. Ltd.' }),                                // TAN from name
    e({ id: 'B2', deductorTan: 'MUMA12345B', tdsDate: '2026-10-10', quarter: 'Q3', tdsAmount: 500000 }),
    e({ id: 'G1', deductorTan: '', deductorName: 'Kaveri Logistics', section: '', tdsAmount: 200000, tdsDate: '2026-07-05', quarter: 'Q2' }),
    e({ id: 'G2', deductorTan: 'CHEK99999Z', section: '194C', tdsAmount: 200000, tdsDate: '2026-08-05', quarter: 'Q2' }),
    e({ id: 'B4', section: '194I', tdsAmount: 300000, tdsDate: '2026-05-10' }),
    e({ id: 'Z1', deductorTan: 'BLRA00001A', tdsAmount: 1000000, tdsDate: '2026-11-12', quarter: 'Q3' }),
    e({ id: 'B9', deductorTan: '', deductorName: 'Unknown Buyer', tdsAmount: 77700 }),
  ]
  const r = runTdsMatcher({ filing26AS: two, books, assessmentYear: 2027 })
  const of = (id: string) => r.rows.filter((x) => x.filing26ASEntryId === id || x.booksEntryId === id)
  eq('exact via name', [of('A1')[0].matchStatus, of('A1')[0].matchMethod, of('A1')[0].booksEntryId, of('A1')[0].flags], ['verified', 'exact', 'B1', ['tan_from_name']])
  eq('window', [of('A2')[0].matchStatus, of('A2')[0].matchMethod, of('A2')[0].mismatchFields, of('A2')[0].flags, of('A2')[0].actionStatus], ['verified', 'window', ['quarter'], ['status_u', 'short_deposit'], 'chase_deductor'])
  eq('grouped', [of('A3').length, of('A3').every((x) => x.matchMethod === 'grouped' && x.matchStatus === 'verified'), new Set(of('A3').map((x) => x.groupKey)).size], [2, true, 1])
  eq('194IA ≠ 194I', [of('A4')[0].matchStatus, of('A4')[0].mismatchFields, of('A4')[0].booksEntryId], ['variance', ['section'], 'B4'])
  eq('variance', [of('A5')[0].matchStatus, of('A5')[0].mismatchFields, of('A5')[0].actionStatus], ['variance', ['tds_amount', 'tds_date'], 'chase_deductor'])
  eq('only books', [of('B9')[0].matchStatus, of('B9')[0].actionStatus], ['only_books', 'chase_deductor'])
  eq('only 26AS action', runTdsMatcher({ filing26AS: [e({ id: 'O1' })], books: [] }).rows[0].actionStatus, 'revise_book')
  eq('totals', [r.totals.verified.tds26as, r.totals.verified.tdsBooks, r.totals.only_books.tdsBooks, r.tanFromName], [1000000 + 500000 + 400000, 1000000 + 500000 + 400000, 77700, 2])
  pass('matcher: exact (TAN from name), 45-day window across quarters, grouped 1↔many, 194IA vs 194I → section variance, TDS variance, U/short-deposit → chase, totals once per entry')
}
{
  const r = runTdsMatcher({ filing26AS: [e({ id: 'Y1', tdsDate: '2025-06-15' })], books: [], assessmentYear: 2027 })
  eq('out of year', r.rows[0].flags, ['out_of_year'])
  pass('entries dated outside the FY are flagged')
}

console.log('\nAll TDS checks passed.')
