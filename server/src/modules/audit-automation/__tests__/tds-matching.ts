/**
 * Smoke test for the TDS matcher.
 *
 * Run:  npx tsx server/src/modules/audit-automation/__tests__/tds-matching.ts
 */
import { runTdsMatcher } from '../services/TdsMatchingService.js'
import type { NormalizedTdsEntry } from '../parsers/tdsTypes.js'

function pass(name: string) { console.log(`✓ ${name}`) }
function fail(name: string, detail: string): never {
  console.error(`✗ ${name}\n  ${detail}`); process.exit(1)
}

// Fabricated data. Expected: 2 verified, 1 variance, 1 only_26as, 1 only_books.
const filing26AS: (NormalizedTdsEntry & { id: string })[] = [
  { id: '26-1', part: 'part_a', section: '194C', deductorTan: 'BLRA00001A',
    quarter: 'Q1', amountPaid: 10000000, tdsAmount: 100000, tdsDate: '2026-04-10' },
  { id: '26-2', part: 'part_a', section: '194J', deductorTan: 'CHNA00002B',
    quarter: 'Q1', amountPaid: 5000000, tdsAmount: 500000, tdsDate: '2026-05-15' },
  // Same as 26-1 but different case / whitespace on TAN and section → still match
  { id: '26-3', part: 'part_a', section: '194I', deductorTan: 'DELA00003C',
    quarter: 'Q2', amountPaid: 2000000, tdsAmount: 20000, tdsDate: '2026-08-20' },
  // Variance case — books tds off by ₹200
  { id: '26-4', part: 'part_a', section: '194A', deductorTan: 'MUMA00004D',
    quarter: 'Q2', amountPaid: 8000000, tdsAmount: 80000, tdsDate: '2026-09-25' },
  // Only_26as
  { id: '26-5', part: 'part_a', section: '192', deductorTan: 'BLRA00005E',
    quarter: 'Q3', amountPaid: 15000000, tdsAmount: 150000, tdsDate: '2026-11-30' },
]

const books: (NormalizedTdsEntry & { id: string })[] = [
  // Verified — 26-1 (invoice/section/tan/quarter/tds identical)
  { id: 'bk-1', section: '194C', deductorTan: '  blra 00001a ', quarter: 'Q1',
    amountPaid: 10000000, tdsAmount: 100000, tdsDate: '2026-04-10' },
  // Verified — 26-3 (section extracted from "sec 194I" style)
  { id: 'bk-3', section: 'Sec 194I', deductorTan: 'DELA00003C', quarter: 'Q2',
    amountPaid: 2000000, tdsAmount: 20000, tdsDate: '2026-08-20' },
  // Variance — 26-4 by ₹200 (20000 paise)
  { id: 'bk-4', section: '194A', deductorTan: 'MUMA00004D', quarter: 'Q2',
    amountPaid: 8000000, tdsAmount: 100000, tdsDate: '2026-09-25' },
  // Only_books — no 26-side counterpart
  { id: 'bk-9', section: '194H', deductorTan: 'MUMA00099Z', quarter: 'Q1',
    amountPaid: 3000000, tdsAmount: 30000, tdsDate: '2026-05-01' },
]

const result = runTdsMatcher({ filing26AS, books })
const counts = {
  verified: result.rows.filter((r) => r.matchStatus === 'verified').length,
  variance: result.rows.filter((r) => r.matchStatus === 'variance').length,
  only_26as: result.rows.filter((r) => r.matchStatus === 'only_26as').length,
  only_books: result.rows.filter((r) => r.matchStatus === 'only_books').length,
}

if (counts.verified !== 2) fail('verified count = 2', JSON.stringify(counts))
if (counts.variance !== 1) fail('variance count = 1', JSON.stringify(counts))
// 26-2 has no match → only_26as; 26-5 has no match → only_26as
if (counts.only_26as !== 2) fail('only_26as count = 2', JSON.stringify(counts))
if (counts.only_books !== 1) fail('only_books count = 1', JSON.stringify(counts))
pass('row counts: 2 verified, 1 variance, 2 only_26as, 1 only_books')

if (result.totals.verified.tdsAmount !== 100000 + 20000) fail('verified totals', String(result.totals.verified.tdsAmount))
if (result.totals.variance.count !== 1) fail('variance count in totals', String(result.totals.variance.count))
pass('totals per bucket')

// Variance row's mismatchFields must include tds_amount
const variance = result.rows.find((r) => r.matchStatus === 'variance')!
if (!variance.mismatchFields.includes('tds_amount')) fail('variance has tds_amount mismatch', variance.mismatchFields.join(','))
pass('variance row records mismatch fields')

// Action defaults: only_26as → credit_claimed; only_books → chase_deductor
const only26 = result.rows.find((r) => r.matchStatus === 'only_26as')!
if (only26.actionStatus !== 'credit_claimed') fail('only_26as default action', only26.actionStatus)
const onlyB = result.rows.find((r) => r.matchStatus === 'only_books')!
if (onlyB.actionStatus !== 'chase_deductor') fail('only_books default action', onlyB.actionStatus)
pass('auditor action defaults: only_26as→credit_claimed, only_books→chase_deductor')

console.log('\nAll TDS matcher assertions passed.')
