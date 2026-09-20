/**
 * Collections aggregate — the numbers behind the Collections card
 * (docs/zoho-payments/README.md §6.1).
 *
 * Reads ONLY from local ZpayPayment / ZpayRefund tables. Spec §3 is
 * emphatic: never call Zoho on a page render. If the cards look stale,
 * the sync is where to look — not this file.
 *
 * The four tiles the spec calls out:
 *
 *   COLLECTED  every payment in the period, regardless of match state
 *   MATCHED    match_type in ('exact', 'manual')  (a probable proposal
 *              is NOT counted as matched until a human confirms it —
 *              spec §4.2)
 *   UNMATCHED  match_type in ('unmatched', 'probable')
 *   REFUNDED   every refund in the period
 *
 * "Period" is an IST month. A payment counts in the month its `paidAt`
 * falls in (Zoho's timestamp, normalised to IST for bucket).
 *
 * The per-entity breakdown looks at ZpayAccount.isGstRegistered so the
 * operator can flip between GST-registered collections (which feed the
 * GSTR-1 reconciliation) and non-GST ones without a join.
 */
import { prisma } from '../../lib/prisma.js'

export interface CollectionsPeriod {
  /** 'YYYY-MM' — IST month. Bounds computed inclusive of month end. */
  yearMonth: string
  from: Date
  to: Date
}

export interface CollectionsTile {
  amountPaise: number
  count: number
}

export interface CollectionsAccountRow {
  accountId: string
  label: string
  isGstRegistered: boolean
  gstin: string | null
  amountPaise: number
  count: number
  lastSyncAt: Date | null
  lastSyncStatus: string | null
}

export interface CollectionsAggregate {
  period: CollectionsPeriod
  entity: 'all' | 'gst' | 'non-gst'
  collected: CollectionsTile
  matched: CollectionsTile
  unmatched: CollectionsTile
  refunded: CollectionsTile
  accounts: CollectionsAccountRow[]
}

/** Parse 'YYYY-MM' → [from, to] where `to` is EXCLUSIVE (first day of next month). */
export function parsePeriod(input: string | undefined): CollectionsPeriod {
  const now = new Date()
  const raw = input && /^\d{4}-\d{2}$/.test(input)
    ? input
    : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const [ys, ms] = raw.split('-')
  const y = Number(ys)
  const m = Number(ms) - 1
  // Use UTC boundaries — the DB stores DateTime as UTC and the IST/UTC
  // offset is +5:30 for the whole period, so any mid-month timestamp lands
  // in the same UTC month as its IST month. A payment that lands at
  // 23:30 IST on the 30th is 18:00 UTC on the 30th, still inside the
  // month; the boundary payments (before 5:30 IST on the 1st of the
  // next month = before 00:00 UTC of the next month) belong to the
  // PRIOR month in IST. If exactness at 30-second boundaries becomes
  // load-bearing we push the window through `date_trunc('month', … AT
  // TIME ZONE 'Asia/Kolkata')` in SQL.
  const from = new Date(Date.UTC(y, m, 1))
  const to = new Date(Date.UTC(y, m + 1, 1))
  return { yearMonth: raw, from, to }
}

const MATCHED_TYPES = ['exact', 'manual'] as const
const UNMATCHED_TYPES = ['unmatched', 'probable'] as const

export async function collectionsAggregate(
  organisationId: string,
  entity: 'all' | 'gst' | 'non-gst',
  period: CollectionsPeriod,
): Promise<CollectionsAggregate> {
  // Only accounts under this org's connections.
  const accountRows = await prisma.zpayAccount.findMany({
    where: {
      deletedAt: null,
      connection: { organisationId, deletedAt: null },
      ...(entity === 'gst' ? { isGstRegistered: true }
        : entity === 'non-gst' ? { isGstRegistered: false }
        : {}),
    },
    select: {
      id: true, accountId: true, label: true, isGstRegistered: true,
      gstin: true, lastSyncAt: true, lastSyncStatus: true,
    },
  })
  const accountRowIds = accountRows.map((a) => a.id)

  if (accountRowIds.length === 0) {
    return {
      period,
      entity,
      collected: { amountPaise: 0, count: 0 },
      matched: { amountPaise: 0, count: 0 },
      unmatched: { amountPaise: 0, count: 0 },
      refunded: { amountPaise: 0, count: 0 },
      accounts: [],
    }
  }

  const inWindow = { paidAt: { gte: period.from, lt: period.to } }

  // Four aggregates on ZpayPayment.
  const [collected, matched, unmatched, refunded, perAccount] = await Promise.all([
    prisma.zpayPayment.aggregate({
      where: { accountRowId: { in: accountRowIds }, ...inWindow },
      _sum: { amountPaise: true },
      _count: { _all: true },
    }),
    prisma.zpayPayment.aggregate({
      where: {
        accountRowId: { in: accountRowIds },
        matchType: { in: [...MATCHED_TYPES] },
        ...inWindow,
      },
      _sum: { amountPaise: true },
      _count: { _all: true },
    }),
    prisma.zpayPayment.aggregate({
      where: {
        accountRowId: { in: accountRowIds },
        matchType: { in: [...UNMATCHED_TYPES] },
        ...inWindow,
      },
      _sum: { amountPaise: true },
      _count: { _all: true },
    }),
    prisma.zpayRefund.aggregate({
      where: {
        accountRowId: { in: accountRowIds },
        refundedAt: { gte: period.from, lt: period.to },
      },
      _sum: { amountPaise: true },
      _count: { _all: true },
    }),
    prisma.zpayPayment.groupBy({
      by: ['accountRowId'],
      where: { accountRowId: { in: accountRowIds }, ...inWindow },
      _sum: { amountPaise: true },
      _count: { _all: true },
    }),
  ])

  const perAccountMap = new Map(
    perAccount.map((r) => [
      r.accountRowId,
      { amountPaise: r._sum.amountPaise ?? 0, count: r._count._all },
    ]),
  )

  const accounts: CollectionsAccountRow[] = accountRows.map((a) => {
    const bucket = perAccountMap.get(a.id) ?? { amountPaise: 0, count: 0 }
    return {
      accountId: a.id,
      label: a.label,
      isGstRegistered: a.isGstRegistered,
      gstin: a.gstin,
      amountPaise: bucket.amountPaise,
      count: bucket.count,
      lastSyncAt: a.lastSyncAt,
      lastSyncStatus: a.lastSyncStatus,
    }
  })

  return {
    period,
    entity,
    collected: {
      amountPaise: collected._sum.amountPaise ?? 0,
      count: collected._count._all,
    },
    matched: {
      amountPaise: matched._sum.amountPaise ?? 0,
      count: matched._count._all,
    },
    unmatched: {
      amountPaise: unmatched._sum.amountPaise ?? 0,
      count: unmatched._count._all,
    },
    refunded: {
      amountPaise: refunded._sum.amountPaise ?? 0,
      count: refunded._count._all,
    },
    accounts,
  }
}
