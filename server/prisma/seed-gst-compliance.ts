/**
 * Sample GST compliance work — 25 periods, each with its GSTR-1, GSTR-2B and
 * GSTR-3B row, so the three work queues under
 * Workstation → Services → Registration → GST have something in them.
 *
 * Opt-in only: `npm --prefix server run seed:gst-compliance`. It is not part
 * of the main seed and never runs at start-up, so sample work cannot reach a
 * production database by accident.
 *
 * Idempotent. Periods are keyed by (profile, financial year, period), filings
 * by (profile, period, return type) and the 2B record by its period, so
 * re-running updates the same 25 rows instead of making 25 more. Existing
 * GstFiling rows for the same profile+period are ADOPTED, not duplicated —
 * that is what links the filings the main seed already wrote to a period.
 *
 * The spread of statuses is deliberate: older periods are filed and
 * reconciled, the current one is mid-cycle, and a couple are late, so each
 * queue shows its own summary counts (today / overdue / completed) doing
 * something rather than all reading zero.
 */
import '../src/lib/env.js'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const HOW_MANY = 25

/** Stamped on every row this script creates, so it can prune its own. */
const MARKER = 'seed:gst-compliance'

/** 'YYYY-MM' for the n-th month back from today (0 = last month). */
function monthsBack(n: number): string {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - 1 - n)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** April–March, as the department writes it: '2026-27'. */
function financialYearOf(period: string): string {
  const [y, m] = period.split('-').map(Number)
  const start = m >= 4 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

/** Statutory-ish due day: GSTR-1 on the 11th, GSTR-3B on the 20th. */
function dueDate(period: string, day: number): string {
  const [y, m] = period.split('-').map(Number)
  return new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10)
}

const today = new Date().toISOString().slice(0, 10)

/**
 * One of five shapes, chosen by how old the period is and its position in the
 * list, so the mix is deterministic — the same seed always produces the same
 * screen, which is what makes it useful for a demo.
 */
const SHAPES = [
  {
    key: 'filed',
    gstr1: 'filed', gstr3b: 'filed', r2b: 'reconciliation_completed',
    recon: 'completed', paid: 'completed',
  },
  {
    key: 'ready',
    gstr1: 'filed', gstr3b: 'ready_to_file', r2b: 'reconciliation_completed',
    recon: 'completed', paid: 'pending',
  },
  {
    // The messy one: the 2B threw up mismatches, so the return behind it is
    // still in preparation. Every queue needs one of these or the exception
    // counters read zero forever and nobody sees what they look like.
    key: 'review',
    gstr1: 'under_review', gstr3b: 'data_preparation', r2b: 'exceptions_found',
    recon: 'in_progress', paid: 'not_applicable',
  },
  {
    key: 'preparing',
    gstr1: 'data_preparation', gstr3b: 'not_started', r2b: 'available',
    recon: 'pending', paid: 'not_applicable',
  },
  {
    key: 'waiting',
    gstr1: 'not_started', gstr3b: 'not_started', r2b: 'expected',
    recon: 'pending', paid: 'not_applicable',
  },
] as const

/** Money that looks like a real return: bigger clients, bigger numbers. */
function figures(i: number) {
  const taxable = BigInt((850_000 + i * 137_500) * 100)      // paise
  const tax = (taxable * 18n) / 100n
  const itc = (tax * BigInt(55 + (i % 30))) / 100n
  return {
    taxableValue: taxable,
    taxAmount: tax,
    taxLiability: tax,
    eligibleItc: itc,
    netPayable: tax - itc,
  }
}

async function main() {
  const profiles = await prisma.gstProfile.findMany({
    where: { deletedAt: null },
    select: {
      id: true, gstin: true, filingFrequency: true,
      assignedEmployeeId: true, reviewerEmployeeId: true,
      client: { select: { companyName: true } },
    },
    orderBy: { gstin: 'asc' },
  })
  if (profiles.length === 0) {
    console.error('No GST profiles found — run the main seed first.')
    process.exit(1)
  }

  const employees = await prisma.employee.findMany({
    where: { deletedAt: null, status: { not: 'inactive' } },
    select: { id: true, fullName: true },
    orderBy: { fullName: 'asc' },
  })
  const pick = (i: number) => employees[i % employees.length]?.id ?? null

  // profile × month, oldest first, stopping at 25. Three months ending with
  // the CURRENT one, so the queues show a mix of late, due-soon and done
  // rather than a wall of overdue.
  const plan: { profileIndex: number; period: string }[] = []
  for (let m = 1; m >= -1 && plan.length < HOW_MANY; m -= 1) {
    for (let p = 0; p < profiles.length && plan.length < HOW_MANY; p += 1) {
      plan.push({ profileIndex: p, period: monthsBack(m) })
    }
  }

  let created = 0
  let updated = 0

  for (const [i, entry] of plan.entries()) {
    const profile = profiles[entry.profileIndex]
    const period = entry.period
    const fy = financialYearOf(period)
    const age = Number(period.slice(5)) // only used to vary the mix
    const shape = SHAPES[(i + age) % SHAPES.length]
    // Round-robin rather than the profile's own assignee: every demo profile
    // is owned by the same executive, and a queue where one name fills the
    // column shows nothing about how the screen behaves.
    const assignedEmployeeId = pick(i) ?? profile.assignedEmployeeId
    const reviewerEmployeeId = pick(i + 3) ?? profile.reviewerEmployeeId
    const f = figures(i)

    const existing = await prisma.gstCompliancePeriod.findUnique({
      where: { gstProfileId_financialYear_period: { gstProfileId: profile.id, financialYear: fy, period } },
      select: { id: true },
    })

    const periodRow = existing
      ? await prisma.gstCompliancePeriod.update({
          where: { id: existing.id },
          data: { assignedEmployeeId, reviewerEmployeeId, periodType: 'monthly' },
          select: { id: true },
        })
      : await prisma.gstCompliancePeriod.create({
          data: {
            gstProfileId: profile.id, financialYear: fy, period, periodType: 'monthly',
            assignedEmployeeId, reviewerEmployeeId,
            nextDueDate: dueDate(period, 20),
            createdBy: MARKER,
          },
          select: { id: true },
        })
    existing ? updated++ : created++

    // ── GSTR-1 and GSTR-3B ────────────────────────────────────────────────
    const returns: { type: string; status: string; due: string; money: Record<string, bigint | null> }[] = [
      {
        type: 'GSTR-1',
        status: shape.gstr1,
        due: dueDate(period, 11),
        money: { taxableValue: f.taxableValue, taxAmount: f.taxAmount, taxLiability: null, eligibleItc: null, netPayable: null },
      },
      {
        type: 'GSTR-3B',
        status: shape.gstr3b,
        due: dueDate(period, 20),
        money: {
          taxableValue: f.taxableValue, taxAmount: f.taxAmount,
          taxLiability: f.taxLiability, eligibleItc: f.eligibleItc, netPayable: f.netPayable,
        },
      },
    ]

    for (const r of returns) {
      const filed = r.status === 'filed'
      const prepared = filed || ['ready_to_file', 'under_review'].includes(r.status)
      const data = {
        gstProfileId: profile.id,
        period,
        returnType: r.type,
        status: r.status,
        dueDate: r.due,
        assignedEmployeeId: assignedEmployeeId ?? '',
        reviewerEmployeeId,
        compliancePeriodId: periodRow.id,
        financialYear: fy,
        // §31 — recorded by a person, never transmitted by Audit OS.
        filedManually: true,
        arn: filed ? `AA${profile.gstin.slice(0, 2)}${period.replace('-', '')}${String(100000 + i).slice(-6)}A` : null,
        filedAt: filed ? new Date(`${r.due}T10:30:00.000Z`) : null,
        preparedAt: prepared ? new Date(`${r.due}T08:00:00.000Z`) : null,
        reviewedAt: filed || r.status === 'ready_to_file' ? new Date(`${r.due}T09:15:00.000Z`) : null,
        paymentStatus: r.type === 'GSTR-3B' ? shape.paid : 'not_applicable',
        paymentDate: r.type === 'GSTR-3B' && shape.paid === 'completed' ? r.due : null,
        challanRef: r.type === 'GSTR-3B' && shape.paid === 'completed' ? `CIN${period.replace('-', '')}${1000 + i}` : null,
        remarks: null,
        ...r.money,
      }
      await prisma.gstFiling.upsert({
        where: { gstProfileId_period_returnType: { gstProfileId: profile.id, period, returnType: r.type } },
        update: data,
        create: data,
      })
    }

    // ── GSTR-2B ───────────────────────────────────────────────────────────
    const itc = f.eligibleItc
    const cgst = itc / 3n
    const mismatch = shape.r2b === 'exceptions_found' ? itc / 20n : 0n
    const r2bData = {
      compliancePeriodId: periodRow.id,
      status: shape.r2b,
      availableDate: ['expected', 'pending'].includes(shape.r2b) ? null : dueDate(period, 14),
      downloadDate: ['available', 'expected', 'pending'].includes(shape.r2b) ? null : dueDate(period, 15),
      totalItcCgst: cgst,
      totalItcSgst: cgst,
      totalItcIgst: itc - cgst * 2n,
      matchedItc: itc - mismatch,
      mismatchItc: mismatch,
      missingInvoiceCount: shape.r2b === 'exceptions_found' ? 3 : 0,
      duplicateInvoiceCount: shape.r2b === 'exceptions_found' ? 1 : 0,
      exceptionCount: shape.r2b === 'exceptions_found' ? 4 : 0,
      remarks: null,
    }
    await prisma.gstR2BRecord.upsert({
      where: { compliancePeriodId: periodRow.id },
      update: r2bData,
      create: r2bData,
    })

    // ── Reconciliation, where the 2B has got that far ─────────────────────
    if (shape.recon === 'pending') {
      // A re-run may have moved this period to an earlier shape; clear the
      // reconciliation so the 2B status and the recon column cannot disagree.
      await prisma.gstReconciliation.deleteMany({ where: { compliancePeriodId: periodRow.id } })
    } else {
      const invoices = 40 + (i % 25)
      const mismatched = shape.recon === 'completed' ? 0 : 2 + (i % 3)
      const reconData = {
        compliancePeriodId: periodRow.id,
        status: shape.recon,
        totalInvoices: invoices,
        matchedCount: invoices - mismatched,
        mismatchCount: mismatched,
        booksItc: itc,
        twoBItc: itc - mismatch,
        matchedItc: itc - mismatch,
        mismatchItc: mismatch,
        startedAt: new Date(`${dueDate(period, 15)}T09:00:00.000Z`),
        completedAt: shape.recon === 'completed' ? new Date(`${dueDate(period, 16)}T17:00:00.000Z`) : null,
      }
      await prisma.gstReconciliation.upsert({
        where: { compliancePeriodId: periodRow.id },
        update: reconData,
        create: reconData,
      })
    }

    // The engine derives overall status on read; storing a sane value keeps
    // list filtering and sorting honest before anything is touched.
    const allDone = shape.gstr1 === 'filed' && shape.gstr3b === 'filed'
    await prisma.gstCompliancePeriod.update({
      where: { id: periodRow.id },
      data: {
        overallStatus: allDone
          ? 'completed'
          : dueDate(period, 20) < today
            ? 'overdue'
            : shape.key === 'waiting' ? 'not_started' : 'in_progress',
        nextDueDate: allDone ? null : dueDate(period, 20),
      },
    })
  }

  // Prune periods an earlier run of THIS script created that the current plan
  // no longer covers, so re-running with different months leaves 25 rows, not
  // a growing pile. Only rows carrying the marker are touched.
  const keep = new Set<string>()
  for (const e of plan) keep.add(`${profiles[e.profileIndex].id}|${e.period}`)
  const mine = await prisma.gstCompliancePeriod.findMany({
    where: { createdBy: MARKER },
    select: { id: true, gstProfileId: true, period: true },
  })
  const stale = mine.filter((r) => !keep.has(`${r.gstProfileId}|${r.period}`))
  for (const r of stale) {
    await prisma.gstFiling.deleteMany({ where: { compliancePeriodId: r.id } })
    await prisma.gstCompliancePeriod.delete({ where: { id: r.id } })
  }
  if (stale.length > 0) console.log(`Pruned ${stale.length} sample periods from an earlier run.`)

  const counts = await Promise.all([
    prisma.gstCompliancePeriod.count(),
    prisma.gstFiling.count({ where: { returnType: 'GSTR-1', compliancePeriodId: { not: null } } }),
    prisma.gstFiling.count({ where: { returnType: 'GSTR-3B', compliancePeriodId: { not: null } } }),
    prisma.gstR2BRecord.count(),
  ])
  console.log(`GST compliance sample: ${created} periods created, ${updated} updated.`)
  console.log(`Now in the database — periods ${counts[0]}, GSTR-1 ${counts[1]}, GSTR-3B ${counts[2]}, GSTR-2B ${counts[3]}.`)
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
