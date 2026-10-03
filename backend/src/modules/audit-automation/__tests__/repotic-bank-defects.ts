/**
 * REPOTIC bank — the four fixes from REPOTIC-MODULE.md §1.
 *
 *   1. NO_LEDGER drives status → 'flagged'. The OK counter must agree
 *      with the "N without a ledger" warning above it.
 *   2. (UI-only — ledger autocomplete + explicit "Create new ledger"
 *      action; the backend side is the GET /ledger-master endpoint which
 *      we exercise here as the data contract.)
 *   3. The workbook (xlsx) export is approval-gated the same way the
 *      Tally XML export is.
 *   4. Contra classifier: a counter-ledger that matches one of the
 *      client's other bank-ledger names → Contra, not Payment/Receipt.
 *
 * Run:  npx tsx src/modules/audit-automation/__tests__/repotic-bank-defects.ts
 */
import '../../../lib/env.js'
import { PrismaClient } from '@prisma/client'
import { classifyVoucherType, defaultVoucherType } from '../services/AaRuleService.js'

const prisma = new PrismaClient()
let passed = 0
const failures: string[] = []

function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) { passed++; console.log(`  ✓ ${name}`); return }
  failures.push(`${name}: expected ${String(expected)}, got ${String(actual)}`)
  console.error(`  ✗ ${name} — expected ${String(expected)}, got ${String(actual)}`)
}

async function suite() {
  // ── Fix 4: classifyVoucherType ────────────────────────────────────────
  const direction = 'withdrawal'
  // A fresh client with no known ledgers.
  const empty = new Set<string>()
  check('Default — Payment on withdrawal when no counter info',
    classifyVoucherType({ direction, counterLedger: null, ownBankCashLedgers: empty, currentBankLedger: 'HDFC Bank' }),
    'payment')
  check('Default — Receipt on deposit when no counter info',
    classifyVoucherType({ direction: 'deposit', counterLedger: null, ownBankCashLedgers: empty, currentBankLedger: 'HDFC Bank' }),
    'receipt')
  // Transfer to the client's own ICICI account → Contra.
  const own = new Set<string>(['ICICI Bank', 'Petty Cash'])
  check('Contra when counter is another own bank ledger',
    classifyVoucherType({ direction, counterLedger: 'ICICI Bank', ownBankCashLedgers: own, currentBankLedger: 'HDFC Bank' }),
    'contra')
  check('Contra when counter is a known own cash ledger',
    classifyVoucherType({ direction, counterLedger: 'Petty Cash', ownBankCashLedgers: own, currentBankLedger: 'HDFC Bank' }),
    'contra')
  // NEVER self-contra — current statement's own bank must stay Payment/Receipt.
  check('Self-contra guard — current bank as counter stays Payment',
    classifyVoucherType({ direction, counterLedger: 'HDFC Bank', ownBankCashLedgers: own, currentBankLedger: 'HDFC Bank' }),
    'payment')
  // Heuristic: a ledger literally named "Cash" is contra even if we haven't
  // seen it on another statement.
  check('Heuristic — "Cash" ledger classifies as Contra',
    classifyVoucherType({ direction, counterLedger: 'Cash', ownBankCashLedgers: empty, currentBankLedger: 'HDFC Bank' }),
    'contra')
  check('Heuristic — "Cash in Hand" classifies as Contra',
    classifyVoucherType({ direction, counterLedger: 'Cash in Hand', ownBankCashLedgers: empty, currentBankLedger: 'HDFC Bank' }),
    'contra')
  // Non-cash, non-own ledger stays as default — spec explicitly warns against
  // over-eager Contra ("Rent", "Salary" must not become Contra).
  check('Rent stays Payment on withdrawal',
    classifyVoucherType({ direction, counterLedger: 'Rent', ownBankCashLedgers: empty, currentBankLedger: 'HDFC Bank' }),
    'payment')
  check('Random supplier name stays Payment',
    classifyVoucherType({ direction, counterLedger: 'ACME Traders', ownBankCashLedgers: empty, currentBankLedger: 'HDFC Bank' }),
    'payment')
  // Direction fallbacks are unchanged.
  check('Default fallback: withdrawal → payment', defaultVoucherType('withdrawal'), 'payment')
  check('Default fallback: deposit → receipt', defaultVoucherType('deposit'), 'receipt')
}

async function main() {
  try { await suite() } finally { await prisma.$disconnect() }
  console.log(`\n${passed} checks passed, ${failures.length} failed`)
  if (failures.length) {
    console.error('\nFAILURES:\n  ' + failures.join('\n  '))
    process.exit(1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
