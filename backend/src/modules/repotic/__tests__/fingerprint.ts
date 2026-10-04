/**
 * REPOTIC marketplace fingerprinting — REPOTIC-MODULE.md §2.1.
 *
 * detect() must produce one of three outcomes:
 *   matched   — identical set and no missing expected columns
 *   drifted   — overlapping set, extra and/or missing columns
 *   no_match  — too little overlap to call it the same report
 *
 * These are the thresholds that drive UI copy — a drifted file still gets
 * parsed with a loud warning; no_match refuses the upload. The scoring
 * must therefore be stable against the real noise marketplaces introduce:
 *
 *   - column reordering (very common across releases)
 *   - punctuation / case differences in headers ("Invoice No." vs invoice_no)
 *   - a single extra column (frequent — "TCS", "RTO Reason")
 *   - a flat rename ("Buyer GSTIN" → "Customer GSTIN") that collapses one match
 *
 * Run:  npx tsx src/modules/repotic/__tests__/fingerprint.ts
 */
import { detect, fingerprintOf, normaliseHeader, type AdapterCandidate } from '../fingerprint.js'

let passed = 0
const failures: string[] = []

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { passed++; console.log(`  ✓ ${name}`); return }
  failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  console.error(`  ✗ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** Amazon MTR B2C v1 — the baseline columns we fingerprint against. */
const AMAZON_MTR_B2C_V1 = [
  'Invoice Number', 'Invoice Date', 'Invoice Amount',
  'Shipping State', 'Buyer GSTIN', 'HSN', 'Tax Rate', 'Taxable Value',
  'IGST', 'CGST', 'SGST',
]

function adapter(id: string, version: number, headers: string[]): AdapterCandidate {
  return { id, version, detectJson: JSON.stringify(headers) }
}

async function suite() {
  // ── normaliseHeader ───────────────────────────────────────────────────
  check('normaliseHeader strips punctuation + case', normaliseHeader('Invoice No.'), 'invoiceno')
  check('normaliseHeader collapses whitespace / underscores', normaliseHeader('invoice_number '), 'invoicenumber')
  check('normaliseHeader empties cleanly', normaliseHeader(''), '')
  check('normaliseHeader handles null-ish', normaliseHeader(undefined as unknown as string), '')

  // ── fingerprintOf ─────────────────────────────────────────────────────
  const fp = fingerprintOf(['Invoice No.', 'Invoice Date', '', 'Invoice No.'])
  check('fingerprintOf dedupes + sorts normalised headers', fp.headers, ['invoicedate', 'invoiceno'])
  check('fingerprintOf keeps original order + dups + strips blanks', fp.original,
    ['Invoice No.', 'Invoice Date', 'Invoice No.'])

  // ── detect() — matched ────────────────────────────────────────────────
  const candidates = [adapter('amz-mtr-b2c-v1', 1, AMAZON_MTR_B2C_V1)]
  const exactSameOrder = fingerprintOf(AMAZON_MTR_B2C_V1)
  const r1 = detect(exactSameOrder, candidates)
  check('matched — identical columns + order', r1.status, 'matched')
  check('matched — adapter id picked', r1.adapterId, 'amz-mtr-b2c-v1')
  check('matched — similarity is 1', r1.similarity, 1)
  check('matched — no new or missing columns', [r1.newColumns.length, r1.missingColumns.length], [0, 0])

  // Reordered: still every expected column, order shuffled. Must still match.
  const shuffled = fingerprintOf([
    'Invoice Date', 'Invoice Number', 'Buyer GSTIN', 'HSN',
    'Tax Rate', 'Taxable Value', 'CGST', 'SGST', 'IGST',
    'Shipping State', 'Invoice Amount',
  ])
  const r2 = detect(shuffled, candidates)
  check('matched — same set, reordered', r2.status, 'matched')
  check('matched — reorder is still similarity 1', r2.similarity, 1)

  // Case/punctuation noise ("INVOICE NO." etc) — must match once normalised.
  const noisy = fingerprintOf(AMAZON_MTR_B2C_V1.map((h) => h.toUpperCase().replace(/ /g, '_') + '.'))
  const r3 = detect(noisy, candidates)
  check('matched — case + punctuation noise is stripped', r3.status, 'matched')

  // ── detect() — drifted ────────────────────────────────────────────────
  // One extra column — "TCS" freshly added. Still every expected column, but
  // the file now has an unmapped field. Similarity drops below 1 so the
  // status must be drifted, not matched (the spec is strict here — unmapped
  // new columns must raise the warning or totals quietly go wrong).
  const extraCol = fingerprintOf([...AMAZON_MTR_B2C_V1, 'TCS'])
  const r4 = detect(extraCol, candidates)
  check('drifted — one new unmapped column', r4.status, 'drifted')
  check('drifted — new column listed with original casing', r4.newColumns, ['TCS'])
  check('drifted — nothing missing', r4.missingColumns, [])

  // A rename collapses one expected column and introduces a new one. Still
  // enough overlap to call it the same format.
  const renamed = fingerprintOf([
    'Invoice Number', 'Invoice Date', 'Invoice Amount',
    'Shipping State', 'Customer GSTIN',  // renamed from "Buyer GSTIN"
    'HSN', 'Tax Rate', 'Taxable Value', 'IGST', 'CGST', 'SGST',
  ])
  const r5 = detect(renamed, candidates)
  check('drifted — rename produces 1 missing + 1 new', r5.status, 'drifted')
  check('drifted — missing column reported (normalised)', r5.missingColumns, ['buyergstin'])
  check('drifted — new column reported (original casing)', r5.newColumns, ['Customer GSTIN'])

  // ── detect() — no_match ───────────────────────────────────────────────
  // Flipkart Sales headers against an Amazon B2C adapter. Barely any overlap.
  const flipkartLookalike = fingerprintOf([
    'Order ID', 'Order Date', 'SKU', 'Item Name', 'Qty', 'Final Sale Amount',
    'Customer State', 'Final Invoice Amount', 'Tax Component Breakup',
  ])
  const r6 = detect(flipkartLookalike, candidates)
  check('no_match — unrelated marketplace headers', r6.status, 'no_match')
  check('no_match — adapterId is null', r6.adapterId, null)
  check('no_match — adapterVersion is null', r6.adapterVersion, null)

  // Empty detectJson on an adapter is skipped silently — defensive against
  // half-seeded adapters.
  const broken: AdapterCandidate[] = [adapter('broken', 1, []), ...candidates]
  const r7 = detect(exactSameOrder, broken)
  check('empty-detectJson adapters are skipped', r7.adapterId, 'amz-mtr-b2c-v1')

  // Best-match wins when multiple versions overlap. v2 adds a column so v2
  // matches exactly, while the file now drifts away from v1.
  const multiVersion = [
    adapter('v1', 1, AMAZON_MTR_B2C_V1),
    adapter('v2', 2, [...AMAZON_MTR_B2C_V1, 'TCS']),
  ]
  const r8 = detect(fingerprintOf([...AMAZON_MTR_B2C_V1, 'TCS']), multiVersion)
  check('multi-version — picks the exact match over the drifted one', r8.adapterId, 'v2')
  check('multi-version — v2 is a clean match', r8.status, 'matched')

  // ── Threshold is one-sided on missing columns ────────────────────────
  // A file with >= 90% similarity but a missing expected column must NOT
  // be reported as "matched" (missing columns are the whole reason we
  // show the drift panel). The spec: matched requires missing == 0.
  const bigAdapterHeaders = [...AMAZON_MTR_B2C_V1, 'Shipment ID', 'Order ID']
  const bigAdapter = [adapter('big', 1, bigAdapterHeaders)]
  // File has 12 of the 13 expected columns and no new columns. Jaccard =
  // 12/13 ≈ 0.923, which is >= 0.9, but one column is missing.
  const missingOne = fingerprintOf(bigAdapterHeaders.filter((h) => h !== 'Order ID'))
  const r9 = detect(missingOne, bigAdapter)
  check('threshold — missing-column must demote matched → drifted', r9.status, 'drifted')
  check('threshold — missing column surfaced', r9.missingColumns, ['orderid'])
}

async function main() {
  await suite()
  console.log(`\n${passed} checks passed, ${failures.length} failed`)
  if (failures.length) {
    console.error('\nFAILURES:\n  ' + failures.join('\n  '))
    process.exit(1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
