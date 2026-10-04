/**
 * REPOTIC Phase 3 — GSTR-1 builder aggregation tests.
 *
 * These are the money paths. If the builder double-counts a Cancel, or puts
 * a Rs. 1,00,000 interstate invoice in B2CS instead of B2CL, the preview
 * file is wrong by exactly the amount we'd under- or over-pay. So every
 * threshold here is checked against §3.1 of REPOTIC-MODULE.md:
 *
 *   - B2CL threshold is ₹1 lakh (10,00,000 paise), effective 2024-08-01
 *   - B2CL applies only to inter-state (ship-to state differs from seller)
 *   - Cancels become Table 9B credit notes (NOT subtracted from B2CS totals)
 *   - Free-replacement rows contribute nothing
 *
 * The parser-level normalisation (CSV → paise) has its own small suite inside
 * this file too (`toPaise`, `toRateBps`, `toDate`, `stateNameToCode`).
 *
 * Run: npx tsx src/modules/repotic/__tests__/gstr1-builder.ts
 */
import type { RpParsedRow } from '@prisma/client'
import { buildFromRows, B2CL_THRESHOLD_PAISE } from '../gstr1-builder.js'
import { toPaise, toRateBps, toDate } from '../parser.js'
import { stateNameToCode, gstinStateCode } from '../states.js'

let passed = 0
const failures: string[] = []

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { passed++; console.log(`  ✓ ${name}`); return }
  failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  console.error(`  ✗ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** Row factory with sensible defaults; override only what the test needs. */
function row(over: Partial<RpParsedRow> = {}): RpParsedRow {
  const base: RpParsedRow = {
    id: 'row-' + Math.random().toString(36).slice(2, 8),
    organisationId: 'org-1',
    uploadId: 'up-1',
    sourceRowIndex: 2,
    txType: 'shipment',
    invoiceNumber: 'INV-1',
    invoiceDate: '2025-12-01',
    invoiceAmount: 50000,   // ₹500 default — well below B2CL
    taxableValue: 42373,
    cgstTax: 3814,
    sgstTax: 3813,
    igstTax: 0,
    cessTax: 0,
    rate: 1800,
    hsn: '85437099',
    quantity: 1,
    shipToState: 'TAMIL NADU',
    sellerGstin: '33COAST7890K1Z4',
    stateCodeIntra: true,
    creditNoteNumber: null,
    creditNoteDate: null,
    rawJson: '{}',
    createdAt: new Date(),
  }
  return { ...base, ...over }
}

async function parserSmallSuite() {
  console.log('\n── parser normalisation ─────────────────────────────────')
  check('toPaise: plain number string', toPaise('423.73'), 42373)
  check('toPaise: commas + rupee sign', toPaise('₹1,00,000.50'), 10000050)
  check('toPaise: empty → 0', toPaise(''), 0)
  check('toPaise: nonsense → 0', toPaise('abc'), 0)
  check('toPaise: negative', toPaise('-42.29'), -4229)
  check('toRateBps: 0.18 fractional → 1800', toRateBps('0.18'), 1800)
  check('toRateBps: 18 whole → 1800', toRateBps('18'), 1800)
  check('toRateBps: 18% with symbol → 1800', toRateBps('18%'), 1800)
  check('toRateBps: 0 → 0', toRateBps('0'), 0)
  check('toDate: ISO with time', toDate('2025-12-01 10:00:00'), '2025-12-01')
  check('toDate: DD/MM/YYYY → ISO', toDate('01/12/2025'), '2025-12-01')
  check('toDate: empty → null', toDate(''), null)
  check('stateNameToCode: upper-cased', stateNameToCode('TAMIL NADU'), '33')
  check('stateNameToCode: titled', stateNameToCode('Tamil Nadu'), '33')
  check('stateNameToCode: alias', stateNameToCode('TN'), '33')
  check('stateNameToCode: unknown', stateNameToCode('MIDDLE EARTH'), null)
  check('gstinStateCode: valid', gstinStateCode('33COAST7890K1Z4'), '33')
  check('gstinStateCode: bad', gstinStateCode('XX'), null)
}

async function b2csSuite() {
  console.log('\n── B2CS (Table 7) ───────────────────────────────────────')
  // Two intra-state shipments at 18% to Tamil Nadu — should consolidate to one row.
  const rows = [
    row({ sourceRowIndex: 2, taxableValue: 42373, cgstTax: 3814, sgstTax: 3813, igstTax: 0 }),
    row({ sourceRowIndex: 3, taxableValue: 42373, cgstTax: 3814, sgstTax: 3813, igstTax: 0 }),
  ]
  const { preview, counts } = buildFromRows(rows, '33COAST7890K1Z4', '2025-12')
  check('one consolidated B2CS row', preview.b2cs.length, 1)
  check('B2CS pos is Tamil Nadu', preview.b2cs[0]?.pos, '33')
  check('B2CS rate', preview.b2cs[0]?.rt, 18)
  check('B2CS sply_ty INTRA', preview.b2cs[0]?.sply_ty, 'INTRA')
  // 42373 paise × 2 = 84746 paise = ₹847.46
  check('B2CS txval sums', preview.b2cs[0]?.txval, 847.46)
  check('B2CS camt + samt', [preview.b2cs[0]?.camt, preview.b2cs[0]?.samt], [76.28, 76.26])
  check('B2CS iamt zero', preview.b2cs[0]?.iamt, 0)
  check('counts.b2cs', counts.b2cs, 2)
}

async function b2clSuite() {
  console.log('\n── B2CL (Table 5A) ──────────────────────────────────────')
  // Interstate invoice ≥ ₹1 lakh — must go to B2CL, not B2CS.
  const bigInterstate = row({
    invoiceNumber: 'INV-BIG',
    invoiceAmount: B2CL_THRESHOLD_PAISE,  // exactly ₹1 lakh — threshold is >=
    taxableValue: 8474576,
    cgstTax: 0, sgstTax: 0, igstTax: 1525424,
    rate: 1800, stateCodeIntra: false,
    shipToState: 'KARNATAKA',
  })
  // Interstate invoice BELOW threshold — must go to B2CS, not B2CL.
  const smallInterstate = row({
    invoiceNumber: 'INV-SMALL',
    invoiceAmount: 50000,
    taxableValue: 42373,
    cgstTax: 0, sgstTax: 0, igstTax: 7627,
    rate: 1800, stateCodeIntra: false,
    shipToState: 'KARNATAKA',
  })
  // Intra-state invoice ≥ ₹1 lakh — stays in B2CS, B2CL is interstate-only.
  const bigIntrastate = row({
    invoiceNumber: 'INV-BIG-INTRA',
    invoiceAmount: 20000000,
    taxableValue: 16949153,
    cgstTax: 1525424, sgstTax: 1525423, igstTax: 0,
    rate: 1800, stateCodeIntra: true,
  })
  const { preview } = buildFromRows([bigInterstate, smallInterstate, bigIntrastate], '33COAST7890K1Z4', '2025-12')
  // Expect: 1 B2CL entry for Karnataka (containing bigInterstate),
  //         1 B2CS entry per unique (pos, rate, sply_ty) = 2 B2CS rows
  //         (small interstate to KA, big intra TN).
  check('B2CL has one PoS group', preview.b2cl.length, 1)
  check('B2CL PoS is Karnataka', preview.b2cl[0]?.pos, '29')
  check('B2CL invoice is INV-BIG', preview.b2cl[0]?.inv[0]?.inum, 'INV-BIG')
  check('B2CL invoice value', preview.b2cl[0]?.inv[0]?.val, 100000)
  check('B2CL idt is DD-MM-YYYY', preview.b2cl[0]?.inv[0]?.idt, '01-12-2025')
  // Small interstate is INTER sply_ty, big intra is INTRA.
  const splyTypes = new Set(preview.b2cs.map((e) => e.sply_ty))
  check('B2CS splits INTRA and INTER', [...splyTypes].sort(), ['INTER', 'INTRA'])
}

async function cdnurSuite() {
  console.log('\n── 9B / CDN ────────────────────────────────────────────')
  const cancelWithNote = row({
    txType: 'cancel',
    invoiceNumber: null,
    creditNoteNumber: 'CN-100',
    creditNoteDate: '2025-12-05',
    invoiceAmount: 50000,
    taxableValue: 42373,
    cgstTax: 3814, sgstTax: 3813, igstTax: 0,
  })
  const cancelWithoutNote = row({
    txType: 'cancel',
    invoiceNumber: null, creditNoteNumber: null,
  })
  const refundWithNote = row({
    txType: 'refund',
    invoiceNumber: null,
    creditNoteNumber: 'CN-101',
    creditNoteDate: '2025-12-06',
  })
  const { preview, counts } = buildFromRows([cancelWithNote, cancelWithoutNote, refundWithNote], '33COAST7890K1Z4', '2025-12')
  check('CDN count only includes rows with credit notes', preview.cdnur.length, 2)
  check('counts.cdnur', counts.cdnur, 2)
  check('excluded_other logs the orphan cancel', counts.excluded_other, 1)
  check('CDN credit-note number present', preview.cdnur[0]?.nt_num, 'CN-100')
  check('CDN credit-note date DD-MM-YYYY', preview.cdnur[0]?.nt_dt, '05-12-2025')
}

async function hsnSuite() {
  console.log('\n── 12 / HSN summary ───────────────────────────────────')
  const rows = [
    row({ hsn: '85437099', quantity: 2, taxableValue: 42373, cgstTax: 3814, sgstTax: 3813, igstTax: 0, rate: 1800 }),
    row({ hsn: '85437099', quantity: 1, taxableValue: 42373, cgstTax: 3814, sgstTax: 3813, igstTax: 0, rate: 1800 }),
    row({ hsn: '732393', quantity: 1, taxableValue: 50000, cgstTax: 4500, sgstTax: 4500, igstTax: 0, rate: 1800 }),
    row({ hsn: '85437099', txType: 'cancel', creditNoteNumber: 'CN-200', quantity: -1, taxableValue: -42373 }),
  ]
  const { preview, counts } = buildFromRows(rows, '33COAST7890K1Z4', '2025-12')
  check('HSN has 2 distinct codes', preview.hsn.length, 2)
  check('counts.hsn', counts.hsn, 2)
  const hsn1 = preview.hsn.find((h) => h.hsn_sc === '85437099')
  // Cancel row does NOT roll up into HSN — only shipment rows do.
  check('HSN roll-up skips cancels', hsn1?.qty, 3)
  check('HSN roll-up txval sums shipments only', hsn1?.txval, 847.46)
  check('HSN num assigned', [preview.hsn[0]?.num, preview.hsn[1]?.num], [1, 2])
}

async function excludesSuite() {
  console.log('\n── Excludes ────────────────────────────────────────────')
  const freeRep = row({ txType: 'free_replacement', invoiceAmount: 0, taxableValue: 0, cgstTax: 0, sgstTax: 0, igstTax: 0 })
  const unknown = row({ txType: 'other' })
  const { counts } = buildFromRows([freeRep, unknown, row(), row()], '33COAST7890K1Z4', '2025-12')
  check('excluded_free_replacement counted', counts.excluded_free_replacement, 1)
  check('excluded_other counted', counts.excluded_other, 1)
  check('total_rows matches input', counts.total_rows, 4)
}

async function main() {
  await parserSmallSuite()
  await b2csSuite()
  await b2clSuite()
  await cdnurSuite()
  await hsnSuite()
  await excludesSuite()
  console.log(`\n${passed} checks passed, ${failures.length} failed`)
  if (failures.length) {
    console.error('\nFAILURES:\n  ' + failures.join('\n  '))
    process.exit(1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
