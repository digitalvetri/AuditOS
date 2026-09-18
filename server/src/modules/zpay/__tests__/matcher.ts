/**
 * Matcher tests — pure regex, no DB.
 *
 * Coverage:
 *   1. exact match on reference_number
 *   2. exact match on description (fallback)
 *   3. prefix escaping — `.` in prefix is literal
 *   4. minimum tail digits — too-short numeric fragments don't match
 *   5. case-insensitive
 *   6. no prefix → never matches
 *   7. both fields empty → unmatched
 *
 * Run:  npx tsx src/modules/zpay/__tests__/matcher.ts
 */

import { classify } from '../matcher.js'

function pass(name: string): void { console.log(`✓ ${name}`) }
function fail(name: string, detail: string): never {
  console.error(`✗ ${name}\n  ${detail}`); process.exit(1)
}

const prefix = 'INV/2026/'

// 1. Exact match on reference_number.
{
  const r = classify(
    { referenceNumber: 'INV/2026/0412', description: null },
    { invoiceSeriesPrefix: prefix },
  )
  if (r.matchType !== 'exact') fail('ref exact', `got ${r.matchType}`)
  if (r.matchedInvoiceRef !== 'INV/2026/0412') fail('ref exact', `wrong ref: ${r.matchedInvoiceRef}`)
  pass('exact match on reference_number')
}

// 2. Reference has extra suffix; the tail cuts at first non-digit.
{
  const r = classify(
    { referenceNumber: 'INV/2026/0412-supplement', description: null },
    { invoiceSeriesPrefix: prefix },
  )
  if (r.matchedInvoiceRef !== 'INV/2026/0412') fail('trailing junk', `wrong ref: ${r.matchedInvoiceRef}`)
  pass('trailing non-digit content is trimmed')
}

// 3. Fallback to description.
{
  const r = classify(
    { referenceNumber: null, description: 'Payment for INV/2026/0413 — Sept fees' },
    { invoiceSeriesPrefix: prefix },
  )
  if (r.matchType !== 'exact') fail('desc exact', `got ${r.matchType}`)
  if (r.matchedInvoiceRef !== 'INV/2026/0413') fail('desc exact', `wrong ref`)
  pass('exact match on description when reference is empty')
}

// 4. Both fields empty.
{
  const r = classify(
    { referenceNumber: null, description: null },
    { invoiceSeriesPrefix: prefix },
  )
  if (r.matchType !== 'unmatched') fail('empty', `got ${r.matchType}`)
  if (r.matchedInvoiceRef !== null) fail('empty', 'ref should be null')
  pass('both fields empty → unmatched')
}

// 5. Prefix mismatch.
{
  const r = classify(
    { referenceNumber: 'BOS/2026/0412', description: null },
    { invoiceSeriesPrefix: prefix },
  )
  if (r.matchType !== 'unmatched') fail('prefix mismatch', `got ${r.matchType}`)
  pass('different prefix does not exact-match')
}

// 6. Too-short tail — a real invoice number needs at least 3 digits.
{
  const r = classify(
    { referenceNumber: 'INV/2026/12', description: null },
    { invoiceSeriesPrefix: prefix },
  )
  if (r.matchType !== 'unmatched') fail('short tail', `got ${r.matchType}`)
  pass('too-short numeric tail is refused')
}

// 7. Case-insensitive prefix.
{
  const r = classify(
    { referenceNumber: 'inv/2026/0412', description: null },
    { invoiceSeriesPrefix: prefix },
  )
  if (r.matchType !== 'exact') fail('case', `got ${r.matchType}`)
  if (r.matchedInvoiceRef !== 'INV/2026/0412') {
    fail('case', `ref should preserve prefix casing: ${r.matchedInvoiceRef}`)
  }
  pass('case-insensitive prefix match')
}

// 8. Regex-hostile prefix — a `.` in the prefix must be a literal.
{
  const dotPrefix = 'JNS.CO/'
  const r = classify(
    { referenceNumber: 'JNS.CO/0412', description: null },
    { invoiceSeriesPrefix: dotPrefix },
  )
  if (r.matchType !== 'exact') fail('literal .', `got ${r.matchType}`)
  const r2 = classify(
    { referenceNumber: 'JNSXCO/0412', description: null },  // X where . was
    { invoiceSeriesPrefix: dotPrefix },
  )
  if (r2.matchType !== 'unmatched') {
    fail('literal .', 'a `.` in the prefix must not act as regex any-char')
  }
  pass('regex metachars in prefix are escaped')
}

// 9. Empty prefix → never matches (defensive).
{
  const r = classify(
    { referenceNumber: 'INV/2026/0412', description: null },
    { invoiceSeriesPrefix: '' },
  )
  if (r.matchType !== 'unmatched') fail('empty prefix', 'empty prefix must not match anything')
  pass('empty prefix never matches')
}

console.log('\nAll Zoho Payments matcher checks passed.')
