/**
 * State-machine tests for the Zoho Payments connection status.
 *
 * The step-1 acceptance gate is "a connection moves through every state"
 * (docs/zoho-payments/README.md §8). These checks cover:
 *
 *   1. Every state has an entry in the adjacency table.
 *   2. Every state is reachable from `not_connected` — the initial row.
 *   3. Every valid transition is accepted by canTransition/assertTransition.
 *   4. Every non-listed transition is rejected with ZpayIllegalTransition.
 *   5. `revoked → connected` is explicitly forbidden (spec §3: STOP RETRYING).
 *
 * Run:  npx tsx src/modules/zpay/__tests__/state.ts
 */

import {
  ZPAY_STATUSES,
  allowedNext,
  canTransition,
  assertTransition,
  ZpayIllegalTransition,
  isZpayStatus,
  type ZpayStatus,
} from '../state.js'

function pass(name: string): void {
  console.log(`✓ ${name}`)
}
function fail(name: string, detail: string): never {
  console.error(`✗ ${name}\n  ${detail}`)
  process.exit(1)
}

// ── 1. Adjacency completeness ──────────────────────────────────────────
for (const s of ZPAY_STATUSES) {
  const nx = allowedNext(s)
  if (!Array.isArray(nx)) fail(`allowedNext(${s})`, 'must return an array')
}
pass('every state has an adjacency entry')

// ── 2. Reachability from the initial state ─────────────────────────────
const visited = new Set<ZpayStatus>()
function walk(s: ZpayStatus): void {
  if (visited.has(s)) return
  visited.add(s)
  for (const n of allowedNext(s)) walk(n)
}
walk('not_connected')
for (const s of ZPAY_STATUSES) {
  if (!visited.has(s)) fail('reachability', `${s} unreachable from not_connected`)
}
pass(`all ${ZPAY_STATUSES.length} states reachable from not_connected`)

// ── 3. Valid transitions accepted ──────────────────────────────────────
// This is the authoritative list. If the adjacency table in state.ts
// changes, this list must move with it — the two are meant to disagree
// only when someone has quietly loosened a guard.
const VALID: ReadonlyArray<readonly [ZpayStatus, ZpayStatus]> = [
  ['not_connected', 'consent_pending'],
  ['consent_pending', 'connected'],
  ['consent_pending', 'error'],
  ['consent_pending', 'not_connected'],
  ['connected', 'expired'],
  ['connected', 'revoked'],
  ['connected', 'error'],
  ['connected', 'consent_pending'], // Reconnect from a connected state
  ['expired', 'consent_pending'],
  ['revoked', 'consent_pending'],
  ['error', 'consent_pending'],
  ['error', 'connected'],
]
for (const [from, to] of VALID) {
  if (!canTransition(from, to)) {
    fail('canTransition', `${from} → ${to} should be allowed`)
  }
  try {
    assertTransition(from, to)
  } catch (err) {
    fail('assertTransition', `${from} → ${to} threw: ${(err as Error).message}`)
  }
}
pass(`${VALID.length} valid transitions accepted`)

// ── 4. Everything else rejected ────────────────────────────────────────
let illegalCount = 0
for (const from of ZPAY_STATUSES) {
  for (const to of ZPAY_STATUSES) {
    if (from === to) continue
    const isValid = VALID.some(([f, t]) => f === from && t === to)
    if (isValid) continue

    if (canTransition(from, to)) {
      fail('canTransition', `${from} → ${to} should be forbidden`)
    }
    try {
      assertTransition(from, to)
      fail('assertTransition', `${from} → ${to} did not throw`)
    } catch (err) {
      if (!(err instanceof ZpayIllegalTransition)) {
        fail('error type', `${from} → ${to} threw ${(err as Error).constructor.name} instead of ZpayIllegalTransition`)
      }
      if (err.from !== from || err.to !== to) {
        fail('error payload', `ZpayIllegalTransition carried ${err.from}→${err.to}, expected ${from}→${to}`)
      }
      illegalCount++
    }
  }
}
pass(`${illegalCount} illegal transitions rejected with ZpayIllegalTransition`)

// ── 5. Spec §3: revoked has no direct path back to connected ───────────
if (canTransition('revoked', 'connected')) {
  fail('revoked → connected', 'must NOT be a direct edge — spec §3 requires re-consent')
}
pass('revoked → connected is forbidden (spec §3 STOP RETRYING)')

// ── 6. Type guard ──────────────────────────────────────────────────────
if (!isZpayStatus('connected')) fail('isZpayStatus', 'rejected a valid status')
if (isZpayStatus('paid')) fail('isZpayStatus', 'accepted a non-status string')
if (isZpayStatus(42)) fail('isZpayStatus', 'accepted a number')
pass('isZpayStatus narrows correctly')

console.log('\nAll Zoho Payments state-machine checks passed.')
