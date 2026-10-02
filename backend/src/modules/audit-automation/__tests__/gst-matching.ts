/**
 * GST matcher: categories, passes, amendments, duplicates and ITC rules —
 * no database.
 *
 * Run:  npx tsx src/modules/audit-automation/__tests__/gst-matching.ts
 */
import { runMatcher, itcFor, type Entry } from '../services/GstMatchingService.js'
import { parseGstr2BJson } from '../parsers/gstr2bJson.js'
import { parsePurchaseRegisterTallyXml } from '../parsers/purchaseRegisterTallyXml.js'

function pass(name: string) { console.log(`✓ ${name}`) }
function fail(name: string, detail: string): never { console.error(`✗ ${name}\n  ${detail}`); process.exit(1) }
const eq = (name: string, got: unknown, want: unknown) => { if (JSON.stringify(got) !== JSON.stringify(want)) fail(name, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`) }

const G1 = '27AAPFU0939F1ZV', G2 = '29AABCK1234M1ZG', G3 = '33AAACR5055K1ZP', G4 = '07AABCU9603R1ZX'
let n = 0
const e = (p: Partial<Entry>): Entry => ({
  id: `e${++n}`, supplierGstin: G1, invoiceNumber: 'X', invoiceDate: '2026-04-10',
  taxableValue: 1000000, igst: 180000, cgst: 0, sgst: 0, cess: 0, itcAvailable: true, docType: 'INV', ...p,
})

// ── categories and passes ────────────────────────────────────────────
{
  const two = [
    e({ id: 'm2', invoiceNumber: 'INV/24/0007' }),                                         // exact → matched
    e({ id: 'v2', supplierGstin: G2, invoiceNumber: 'B-42', igst: 0, cgst: 90000, sgst: 90000 }), // exact key, tax heads differ → variance
    e({ id: 'p2', supplierGstin: G3, invoiceNumber: 'A/2024/000123' }),                     // loose invoice → partial
    e({ id: 'd2', supplierGstin: G4, invoiceNumber: 'SUP-99', invoiceDate: '2026-04-20' }), // no invoice match; amount + date near → partial
    e({ id: 'o2', supplierGstin: G2, invoiceNumber: 'MISS-1' }),                            // only in 2B
  ]
  const pr = [
    e({ id: 'm1', invoiceNumber: 'inv/24/7' }),
    e({ id: 'v1', supplierGstin: G2, invoiceNumber: 'B-42' }),
    e({ id: 'p1', supplierGstin: G3, invoiceNumber: 'A-2024-123' }),
    e({ id: 'd1', supplierGstin: G4, invoiceNumber: 'SUPPLIER BILL 99A', invoiceDate: '2026-04-23' }),
    e({ id: 'o1', supplierGstin: G1, invoiceNumber: 'BOOKS-ONLY' }),                       // only in books
  ]
  const r = runMatcher({ filing2B: two, purchaseRegister: pr, period: '2026-04' })
  const by = (id: string) => r.rows.find((x) => x.filing2BEntryId === id || x.purchaseRegisterEntryId === id)!
  eq('matched', [by('m2').matchStatus, by('m2').matchMethod, by('m2').purchaseRegisterEntryId], ['matched', 'exact', 'm1'])
  eq('variance', [by('v2').matchStatus, by('v2').mismatchFields], ['variance', ['igst', 'cgst', 'sgst']])
  eq('loose', [by('p2').matchStatus, by('p2').matchMethod, by('p2').mismatchFields], ['partial', 'invoice_loose', ['invoice_number_format']])
  eq('amount+date', [by('d2').matchStatus, by('d2').matchMethod, by('d2').mismatchFields], ['partial', 'amount_date', ['invoice_date', 'invoice_number']])
  eq('only', [by('o2').matchStatus, by('o1').matchStatus], ['only_2b', 'only_pr'])
  eq('totals', ['matched', 'partial', 'variance', 'only_2b', 'only_pr'].map((k) => r.totals[k as 'matched'].count), [1, 2, 1, 1, 1])
  pass('matched / partial (loose invoice no., amount+date) / variance (tax heads) / only-in-2B / only-in-books')
}

// ── an exact key match still checks the tax amounts ───────────────────
{
  const r = runMatcher({ filing2B: [e({ id: 'a', igst: 180000 })], purchaseRegister: [e({ id: 'b', igst: 90000 })] })
  eq('exact+tax', [r.rows[0].matchStatus, r.rows[0].matchMethod, r.rows[0].mismatchFields], ['variance', 'exact', ['igst']])
  pass('same GSTIN, invoice, date and taxable but different IGST → variance, not matched')
}

// ── duplicates and amendments ────────────────────────────────────────
{
  const r = runMatcher({
    filing2B: [
      e({ id: 'orig', invoiceNumber: 'INV-5', taxableValue: 500000, igst: 90000 }),
      e({ id: 'amd', section: 'b2ba', invoiceNumber: 'INV-5A', originalInvoiceNumber: 'INV-5', taxableValue: 600000, igst: 108000 }),
      e({ id: 'dup2b', invoiceNumber: 'INV-5A', section: 'b2ba', originalInvoiceNumber: 'INV-5', taxableValue: 600000, igst: 108000 }),
    ],
    purchaseRegister: [
      e({ id: 'b1', invoiceNumber: 'INV-5A', taxableValue: 600000, igst: 108000 }),
      e({ id: 'b2', invoiceNumber: 'inv 5a', taxableValue: 600000, igst: 108000 }),
    ],
  })
  eq('superseded', r.superseded, 1)
  eq('amended matched', r.rows.find((x) => x.filing2BEntryId === 'amd')?.matchStatus, 'matched')
  eq('dups', r.rows.filter((x) => x.matchStatus === 'duplicate').map((x) => x.mismatchFields[0]).sort(), ['duplicate_in_2b', 'duplicate_in_books'])
  eq('original not matched', r.rows.some((x) => x.filing2BEntryId === 'orig'), false)
  pass('B2BA amendment replaces its original; the same invoice twice on a side → duplicate rows')
}

// ── ITC rules ────────────────────────────────────────────────────────
{
  const it = (two: Partial<Entry> | null, pr: Partial<Entry> | null, status: 'matched' | 'only_pr' | 'only_2b' = 'matched', period = '2026-04') =>
    itcFor(status, two ? e(two) : undefined, pr ? e(pr) : undefined, period).cls
  eq('itc', [
    it({}, {}),                                                         // eligible
    it({ itcAvailable: false, itcReason: 'P' }, {}),                    // ineligible (2B says N)
    it({ reverseCharge: true }, {}),                                    // rcm
    it({ docType: 'CRN', taxableValue: -100000 }, {}),                  // reversal
    it({}, { glCode: 'Motor Car Expenses' }),                           // blocked s.17(5)
    it({}, { glCode: 'Staff welfare - food & beverages' }),             // blocked
    it({ invoiceDate: '2024-06-10' }, {}, 'matched', '2026-04'),        // time-barred (limit 2025-11-30)
    it(null, {}, 'only_pr'),                                            // not in 2B
    it({}, null, 'only_2b'),                                            // in 2B, not booked → eligible
  ], ['eligible', 'ineligible', 'rcm', 'reversal', 'blocked', 'blocked', 'ineligible', 'ineligible', 'eligible'])
  pass('ITC: 2B not-available, reverse charge, credit note, s.17(5) blocked, s.16(4) time limit, s.16(2)(aa) not in 2B')
}

// ── GSTR-2B JSON: dates, notes, amendments, imports, ISD ─────────────
{
  const json = {
    data: {
      gstin: '33AAACR5055K1ZP', gendt: '14-05-2026',
      docdata: {
        b2b: [{ ctin: G1, trdnm: 'Acme', inv: [{ inum: 'INV/24/0007', dt: '10-04-2026', val: 11800, txval: 10000, igst: 1800, cgst: 0, sgst: 0, cess: 0, rev: 'N', itcavl: 'Y' }] }],
        b2ba: [{ ctin: G1, inv: [{ inum: 'INV/24/0007A', oinum: 'INV/24/0007', dt: '11-04-2026', txval: 12000, igst: 2160, itcavl: 'Y' }] }],
        cdnr: [{ ctin: G2, nt: [{ ntnum: 'CN-1', typ: 'C', dt: '12-04-2026', txval: 1000, cgst: 90, sgst: 90, itcavl: 'Y' }] }],
        impg: [{ refdt: '15-04-2026', portcd: 'INMAA1', boenum: '1234567', boedt: '13-04-2026', txval: 50000, igst: 9000, cess: 0 }],
        isd: [{ ctin: G3, trdnm: 'HO', doclist: [{ doctyp: 'I', docnum: 'ISD-9', docdt: '14-04-2026', igst: 500, itcelg: 'N', rsn: 'X' }] }],
      },
    },
  }
  const p = parseGstr2BJson(Buffer.from(JSON.stringify(json)))
  const s = (sec: string) => p.entries.find((x) => x.section === sec)!
  eq('b2b', [s('b2b').invoiceDate, s('b2b').invoiceValue, s('b2b').docType], ['2026-04-10', 1180000, 'INV'])
  eq('b2ba', [s('b2ba').originalInvoiceNumber, s('b2ba').invoiceDate], ['INV/24/0007', '2026-04-11'])
  eq('cdnr', [s('cdnr').docType, s('cdnr').taxableValue, s('cdnr').cgst], ['CRN', -100000, -9000])
  eq('impg', [s('impg').docType, s('impg').invoiceNumber, s('impg').supplierGstin, s('impg').igst], ['BOE', 'BOE-INMAA1-1234567', 'IMPORT', 900000])
  eq('isd', [s('isd').docType, s('isd').itcAvailable, s('isd').itcReason], ['ISD', false, 'X'])
  pass('GSTR-2B JSON: `dt` dates, invoice value, credit notes negative, amendments, bills of entry, ISD')
}

// ── Tally purchase register: numeric-looking values, ledgers, returns ─
{
  const xml = `<ENVELOPE><BODY><DATA>
<TALLYMESSAGE><VOUCHER VCHTYPE="Purchase"><DATE>20260415</DATE><VOUCHERNUMBER>12</VOUCHERNUMBER><REFERENCE>000123</REFERENCE><REFERENCEDATE>20260414</REFERENCEDATE>
<PARTYLEDGERNAME>Ravi Motors</PARTYLEDGERNAME><PARTYGSTIN>${G3}</PARTYGSTIN><ISREVERSECHARGEAPPLICABLE>No</ISREVERSECHARGEAPPLICABLE>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Ravi Motors</LEDGERNAME><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>35400</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Motor Car Expenses</LEDGERNAME><AMOUNT>-30000</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>CGST 9%</LEDGERNAME><AMOUNT>-2700</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>SGST 9%</LEDGERNAME><AMOUNT>-2700</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>
<TALLYMESSAGE><VOUCHER VCHTYPE="Debit Note"><DATE>20260420</DATE><REFERENCE>DN-1</REFERENCE><PARTYLEDGERNAME>Acme</PARTYLEDGERNAME><PARTYGSTIN>${G1}</PARTYGSTIN><ISREVERSECHARGEAPPLICABLE>Yes</ISREVERSECHARGEAPPLICABLE>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Acme</LEDGERNAME><AMOUNT>-1180</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Purchase Returns</LEDGERNAME><AMOUNT>1000</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>IGST</LEDGERNAME><AMOUNT>180</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>
</DATA></BODY></ENVELOPE>`
  const p = parsePurchaseRegisterTallyXml(Buffer.from(xml))
  const [a, b] = p.entries
  eq('tally inv', [a.invoiceNumber, a.invoiceDate, a.taxableValue, a.cgst, a.glCode, a.invoiceValue, a.reverseCharge ?? false], ['000123', '2026-04-14', 3000000, 270000, 'Motor Car Expenses', 3540000, false])
  eq('tally dn', [b.docType, b.taxableValue, b.igst, b.reverseCharge, b.invoiceDate], ['CRN', -100000, -18000, true, '2026-04-20'])
  eq('blocked via ledger', itcFor('partial', e({}), { ...e({}), ...a } as Entry, '2026-04').cls, 'blocked')
  pass('Tally purchases: dates and invoice numbers kept as text (000123), ledger name → s.17(5), debit note, reverse charge')
}

console.log('All GST matcher checks passed.')
