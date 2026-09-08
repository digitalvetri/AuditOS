/**
 * Smoke test for the GST matcher: fabricated 2B + PR with all four
 * match outcomes. Asserts row counts and totals.
 *
 * Run:  npx tsx server/src/modules/audit-automation/__tests__/gst-matching.ts
 */
import { runMatcher } from '../services/GstMatchingService.js'
import type { NormalizedEntry } from '../parsers/types.js'
import { parseGstr2BJson } from '../parsers/gstr2bJson.js'

function pass(name: string) { console.log(`✓ ${name}`) }
function fail(name: string, detail: string): never {
  console.error(`✗ ${name}\n  ${detail}`); process.exit(1)
}

// Fabricated data — five 2B entries, four PR entries.
// Expected: 3 exact matched, 1 partial (₹100 delta > tolerance),
// 1 only-in-2B (no PR counterpart), 0 only-in-PR (we align all four
// PR entries with 2B).
const filing2B: (NormalizedEntry & { id: string })[] = [
  { id: '2b-1', section: 'b2b', supplierGstin: '07AABCU9603R1ZX', invoiceNumber: 'INV/24/0007',
    invoiceDate: '2026-04-10', taxableValue: 10000000, igst: 1800000, cgst: 0, sgst: 0, cess: 0, itcAvailable: true },
  { id: '2b-2', section: 'b2b', supplierGstin: '22AAAAA0000A1Z5', invoiceNumber: 'BILL-42',
    invoiceDate: '2026-04-12', taxableValue: 5000000, igst: 0, cgst: 450000, sgst: 450000, cess: 0, itcAvailable: true },
  { id: '2b-3', section: 'b2b', supplierGstin: '33BBBBB1111B2Y4', invoiceNumber: 'A/2024/000123',
    invoiceDate: '2026-04-15', taxableValue: 2500000, igst: 450000, cgst: 0, sgst: 0, cess: 0, itcAvailable: false },
  { id: '2b-4', section: 'b2b', supplierGstin: '19CCCCC2222C3X3', invoiceNumber: 'SUP-99',
    invoiceDate: '2026-04-20', taxableValue: 8000000, igst: 1440000, cgst: 0, sgst: 0, cess: 0, itcAvailable: true },
  // 2B-5 has no PR counterpart → only_2b
  { id: '2b-5', section: 'b2b', supplierGstin: '29DDDDD3333D4W2', invoiceNumber: 'MISS-1',
    invoiceDate: '2026-04-25', taxableValue: 1500000, igst: 270000, cgst: 0, sgst: 0, cess: 0, itcAvailable: true },
]

const purchaseRegister: (NormalizedEntry & { id: string })[] = [
  // 2B-1 → exact match
  { id: 'pr-1', supplierGstin: '07AABCU9603R1ZX', invoiceNumber: 'INV/24/0007',
    invoiceDate: '2026-04-10', taxableValue: 10000000, igst: 1800000, cgst: 0, sgst: 0, cess: 0 },
  // 2B-2 → exact match
  { id: 'pr-2', supplierGstin: '22AAAAA0000A1Z5', invoiceNumber: 'BILL-42',
    invoiceDate: '2026-04-12', taxableValue: 5000000, igst: 0, cgst: 450000, sgst: 450000, cess: 0 },
  // 2B-3 → invoice number differs by leading zero (normalizeInvoiceNumber
  //        strips it) → same normalized key → exact match
  { id: 'pr-3', supplierGstin: '33BBBBB1111B2Y4', invoiceNumber: 'A/2024/123',
    invoiceDate: '2026-04-15', taxableValue: 2500000, igst: 450000, cgst: 0, sgst: 0, cess: 0 },
  // 2B-4 → taxable off by ₹100 (10000 paise) — beyond the ₹1 tolerance
  //        AND beyond the 0.1% tolerance (₹80 for ₹80,000) → partial
  { id: 'pr-4', supplierGstin: '19CCCCC2222C3X3', invoiceNumber: 'SUP-99',
    invoiceDate: '2026-04-20', taxableValue: 8010000, igst: 1441800, cgst: 0, sgst: 0, cess: 0 },
]

const result = runMatcher({ filing2B, purchaseRegister })
const counts = {
  matched: result.rows.filter((r) => r.matchStatus === 'matched').length,
  partial: result.rows.filter((r) => r.matchStatus === 'partial').length,
  only_2b: result.rows.filter((r) => r.matchStatus === 'only_2b').length,
  only_pr: result.rows.filter((r) => r.matchStatus === 'only_pr').length,
}

if (counts.matched !== 3) fail('matched count = 3', JSON.stringify(counts))
if (counts.partial !== 1) fail('partial count = 1', JSON.stringify(counts))
if (counts.only_2b !== 1) fail('only_2b count = 1', JSON.stringify(counts))
if (counts.only_pr !== 0) fail('only_pr count = 0', JSON.stringify(counts))
pass('row counts: 3 matched, 1 partial, 1 only_2b, 0 only_pr')

// Totals check
if (result.totals.matched.taxable !== 10000000 + 5000000 + 2500000) fail('matched taxable total', String(result.totals.matched.taxable))
if (result.totals.partial.count !== 1) fail('partial count in totals', String(result.totals.partial.count))
if (result.totals.only_2b.taxable !== 1500000) fail('only_2b taxable total', String(result.totals.only_2b.taxable))
pass('totals per bucket')

// Partial row carries the mismatch fields
const partial = result.rows.find((r) => r.matchStatus === 'partial')!
if (!partial.mismatchFields.includes('taxable_value')) fail('partial has taxable_value mismatch', partial.mismatchFields.join(','))
if (!partial.mismatchFields.includes('tax_split')) fail('partial has tax_split mismatch', partial.mismatchFields.join(','))
pass('partial row records mismatch fields')

// ITC classification default: 2B-3 has itcAvailable=false → ineligible
const matched2B3 = result.rows.find((r) => r.filing2BEntryId === '2b-3')!
if (matched2B3.itcClassification !== 'ineligible') fail('itcAvailable=false → ineligible', matched2B3.itcClassification)
pass('ITC classification: itcAvailable=false defaults to ineligible')

// Parser smoke — a tiny fabricated 2B JSON envelope
const sampleJson = JSON.stringify({
  data: {
    rtnprd: '042026', gstin: '22AAAAA0000A1Z5', gendt: '14-05-2026',
    docdata: {
      b2b: [
        {
          ctin: '07AABCU9603R1ZX', trdnm: 'Acme Steel',
          inv: [
            { inum: 'INV/24/0007', idt: '10-04-2026', txval: 100000, igst: 18000, itcavl: 'Y' },
            { inum: 'INV/24/0008', idt: '11-04-2026', txval: 50000, cgst: 4500, sgst: 4500, itcavl: 'Y' },
          ],
        },
      ],
    },
  },
})
const parsed = parseGstr2BJson(Buffer.from(sampleJson, 'utf8'))
if (parsed.entries.length !== 2) fail('json parser row count', String(parsed.entries.length))
if (parsed.entries[0].taxableValue !== 10000000) fail('json parser rupees→paise', String(parsed.entries[0].taxableValue))
if (parsed.entries[0].invoiceDate !== '2026-04-10') fail('json parser date to ISO', parsed.entries[0].invoiceDate)
if (parsed.gstin !== '22AAAAA0000A1Z5') fail('json parser filing gstin', String(parsed.gstin))
pass('gstr2b JSON parser: 2 entries, rupees → paise, date → ISO')

console.log('\nAll GST matcher assertions passed.')
