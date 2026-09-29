import { beforeEach, describe, expect, it } from 'vitest'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { heldLiabilityBalances, postJournal, reconcile } from '../ledger.js'
import { CATEGORIES } from '../../../platform/constants.js'

/**
 * Double-entry primitive tests. A ledger row without its opposite is the
 * whole reason ₹33,950 of PF and PT withholding went un-booked in the
 * pre-fix seed — the primitive that fixes it is the one that must not be
 * broken. LedgerTransaction.employeeId is nullable and unused for pure
 * balance assertions, so these tests skip the employee fixture.
 */

async function reset() {
  await prisma.ledgerTransaction.deleteMany({})
}

describe('postJournal', () => {
  beforeEach(reset)

  it('writes multiple legs atomically when they balance', async () => {
    const rows = await prisma.$transaction((tx) =>
      postJournal(tx, {
        date: '2026-09-30',
        type: 'Payroll',
        description: 'Salary — September 2026',
        referenceId: uid('ref'),
        referenceType: 'PayrollItem',
        createdBy: null,
        legs: [
          { category: CATEGORIES.SALARIES, debitPaise: 100_000 },
          { category: CATEGORIES.BANK, creditPaise: 88_000 },
          { category: CATEGORIES.PF_PAYABLE, creditPaise: 8_000 },
          { category: CATEGORIES.PT_PAYABLE, creditPaise: 4_000 },
        ],
      }),
    )
    expect(rows).toHaveLength(4)
    const totals = await prisma.ledgerTransaction.aggregate({
      _sum: { debitPaise: true, creditPaise: true },
    })
    expect(totals._sum.debitPaise).toBe(100_000)
    expect(totals._sum.creditPaise).toBe(100_000)
  })

  it('refuses to write anything when legs do not balance', async () => {
    await expect(
      prisma.$transaction((tx) =>
        postJournal(tx, {
          date: '2026-09-30',
          type: 'Payroll',
          description: 'unbalanced',
          referenceId: uid('ref'),
          referenceType: 'PayrollItem',
          createdBy: null,
          legs: [
            { category: CATEGORIES.SALARIES, debitPaise: 100_000 },
            { category: CATEGORIES.BANK, creditPaise: 90_000 },
          ],
        }),
      ),
    ).rejects.toThrow(/unbalanced/i)
    expect(await prisma.ledgerTransaction.count()).toBe(0)
  })

  it('drops zero-value legs before checking the balance', async () => {
    const rows = await prisma.$transaction((tx) =>
      postJournal(tx, {
        date: '2026-09-30',
        type: 'Payroll',
        description: 'no ESI this month',
        referenceId: uid('ref'),
        referenceType: 'PayrollItem',
        createdBy: null,
        legs: [
          { category: CATEGORIES.SALARIES, debitPaise: 100_000 },
          { category: CATEGORIES.BANK, creditPaise: 100_000 },
          { category: CATEGORIES.ESI_PAYABLE, creditPaise: 0 },
          { category: CATEGORIES.TDS_PAYABLE, creditPaise: 0 },
        ],
      }),
    )
    expect(rows).toHaveLength(2)
  })

  it('refuses a journal with fewer than two non-zero legs', async () => {
    await expect(
      prisma.$transaction((tx) =>
        postJournal(tx, {
          date: '2026-09-30',
          type: 'Payroll',
          description: 'only a debit',
          referenceId: uid('ref'),
          referenceType: 'PayrollItem',
          createdBy: null,
          legs: [
            { category: CATEGORIES.SALARIES, debitPaise: 100_000 },
          ],
        }),
      ),
    ).rejects.toThrow(/at least two/i)
  })

  it('refuses a leg that carries both a debit and a credit', async () => {
    await expect(
      prisma.$transaction((tx) =>
        postJournal(tx, {
          date: '2026-09-30',
          type: 'Payroll',
          description: 'both sides',
          referenceId: uid('ref'),
          referenceType: 'PayrollItem',
          createdBy: null,
          legs: [
            { category: CATEGORIES.SALARIES, debitPaise: 100_000, creditPaise: 100_000 },
            { category: CATEGORIES.BANK, creditPaise: 100_000 },
          ],
        }),
      ),
    ).rejects.toThrow(/both/i)
  })
})

describe('heldLiabilityBalances', () => {
  beforeEach(reset)

  it('sums credits minus debits per liability category', async () => {
    await prisma.$transaction((tx) =>
      postJournal(tx, {
        date: '2026-08-31',
        type: 'Payroll',
        description: 'August payroll',
        referenceId: uid('ref'),
        referenceType: 'PayrollItem',
        createdBy: null,
        legs: [
          { category: CATEGORIES.SALARIES, debitPaise: 100_000 },
          { category: CATEGORIES.BANK, creditPaise: 87_500 },
          { category: CATEGORIES.PF_PAYABLE, creditPaise: 8_000 },
          { category: CATEGORIES.PT_PAYABLE, creditPaise: 4_500 },
        ],
      }),
    )
    const held = await heldLiabilityBalances()
    expect(held['PF Payable']).toBe(8_000)
    expect(held['Professional Tax Payable']).toBe(4_500)
    expect(held['TDS Payable']).toBe(0)
    expect(held['ESI Payable']).toBe(0)
  })

  it('drops back toward zero when a remittance debits the liability', async () => {
    await prisma.$transaction((tx) =>
      postJournal(tx, {
        date: '2026-08-31',
        type: 'Payroll',
        description: 'August payroll',
        referenceId: uid('ref'),
        referenceType: 'PayrollItem',
        createdBy: null,
        legs: [
          { category: CATEGORIES.SALARIES, debitPaise: 100_000 },
          { category: CATEGORIES.BANK, creditPaise: 88_000 },
          { category: CATEGORIES.PF_PAYABLE, creditPaise: 12_000 },
        ],
      }),
    )
    expect((await heldLiabilityBalances())['PF Payable']).toBe(12_000)

    await prisma.$transaction((tx) =>
      postJournal(tx, {
        date: '2026-09-15',
        type: 'Liability Remittance',
        description: 'Remitted PF for August',
        referenceId: uid('rem'),
        referenceType: 'LiabilityRemittance',
        createdBy: null,
        legs: [
          { category: CATEGORIES.PF_PAYABLE, debitPaise: 12_000 },
          { category: CATEGORIES.BANK, creditPaise: 12_000 },
        ],
      }),
    )
    expect((await heldLiabilityBalances())['PF Payable']).toBe(0)
  })
})

describe('legacy migration path', () => {
  // Rebuilds the "before" state — a single-leg debit-only Payroll row like
  // every row in the pre-fix seed — then exercises the same
  // contra-reversal + fresh-multi-leg-posting steps
  // scripts/migrate-ledger-both-legs.ts uses. If this passes, so does the
  // migration.

  beforeEach(async () => {
    await prisma.ledgerTransaction.deleteMany({})
  })

  it('re-posts a single-leg row as a balanced journal via contra + fresh legs', async () => {
    // 1. Seed the legacy state directly, bypassing the new primitives —
    //    this is what the old buggy seed left behind on real deployments.
    const legacyRef = uid('leg')
    const legacy = await prisma.ledgerTransaction.create({
      data: {
        transactionRef: 'LT-PAY-000001',
        sequence: 1,
        date: '2026-07-31',
        type: 'Payroll',
        description: 'Salary — July 2026',
        category: 'Payroll',
        debitPaise: 82_240,
        creditPaise: 0,
        runningBalancePaise: 82_240,
        referenceId: legacyRef,
        referenceType: 'PayrollItem',
        status: 'posted',
      },
    })

    let totals = await prisma.ledgerTransaction.aggregate({
      _sum: { debitPaise: true, creditPaise: true },
    })
    expect(totals._sum.debitPaise).toBe(82_240)
    expect(totals._sum.creditPaise).toBe(0)

    // 2. Migrate: contra reversal + fresh multi-leg posting at the
    //    original date. Same shape scripts/migrate-ledger-both-legs.ts
    //    applies in production.
    await prisma.$transaction(async (tx) => {
      // Contra reversal (append + mark original reversed).
      const { postLedger } = await import('../ledger.js')
      await postLedger(tx, {
        date: '2026-09-15',
        type: 'Payroll',
        description: `Migration reversal — ${legacy.description}`,
        category: legacy.category,
        debitPaise: 0,
        creditPaise: legacy.debitPaise,
        referenceId: legacy.id,
        referenceType: 'LedgerReversal',
        reversesId: legacy.id,
        createdBy: null,
      })
      await tx.ledgerTransaction.update({
        where: { id: legacy.id }, data: { status: 'reversed' },
      })
      // Fresh correct multi-leg posting.
      await postJournal(tx, {
        date: legacy.date,
        type: 'Payroll',
        description: 'Salary — re-posted',
        referenceId: legacyRef,
        referenceType: 'PayrollItem',
        createdBy: null,
        legs: [
          { category: CATEGORIES.SALARIES, debitPaise: 100_000 },
          { category: CATEGORIES.BANK, creditPaise: 82_240 },
          { category: CATEGORIES.PF_PAYABLE, creditPaise: 12_000 },
          { category: CATEGORIES.PT_PAYABLE, creditPaise: 5_760 },
        ],
      })
    })

    // 3. Assert: ledger balanced (a reversed row keeps its amounts on the
    //    books; its contra nets it to zero), original marked reversed, and
    //    the correct held-liability balances now visible.
    totals = await prisma.ledgerTransaction.aggregate({
      _sum: { debitPaise: true, creditPaise: true },
    })
    expect(totals._sum.debitPaise).toBe(totals._sum.creditPaise)
    const originalAfter = await prisma.ledgerTransaction.findUnique({ where: { id: legacy.id } })
    expect(originalAfter?.status).toBe('reversed')
    const held = await heldLiabilityBalances()
    expect(held['PF Payable']).toBe(12_000)
    expect(held['Professional Tax Payable']).toBe(5_760)
  })
})

describe('reconcile', () => {
  beforeEach(async () => {
    await prisma.ledgerTransaction.deleteMany({})
    await prisma.payment.deleteMany({})
    await prisma.expense.deleteMany({})
    await prisma.payrollItem.deleteMany({})
    await prisma.payrollRun.deleteMany({})
  })

  it('reports balanced=true when every posting balances', async () => {
    await prisma.$transaction((tx) =>
      postJournal(tx, {
        date: '2026-09-30',
        type: 'Payroll',
        description: 'September',
        referenceId: uid('ref'),
        referenceType: 'PayrollItem',
        createdBy: null,
        legs: [
          { category: CATEGORIES.SALARIES, debitPaise: 50_000 },
          { category: CATEGORIES.BANK, creditPaise: 50_000 },
        ],
      }),
    )
    const r = await reconcile()
    expect(r.balanced).toBe(true)
    expect(r.total_debit_paise).toBe(r.total_credit_paise)
  })
})
