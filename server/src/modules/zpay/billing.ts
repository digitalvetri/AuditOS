/**
 * Billing slice — the small "how much has this client paid us" block
 * that appears on the client record (docs/zoho-payments/README.md §6.3).
 *
 * The slice reads local ZpayPayment rows keyed on matchedClientId. A
 * payment only shows up here if a human (or a future probable-tier
 * proposal) linked it to a specific client — the exact-tier matcher
 * only ever writes matchedInvoiceRef, not matchedClientId, because we
 * don't have the invoice → client mapping in AuditOS yet (the whole
 * point of this integration is that invoices are raised elsewhere).
 *
 * Indian financial year: 1 April to 31 March. `currentFinancialYear()`
 * returns the year *start*, so FY 2026-27 is the row where a payment
 * on 2026-04-01 through 2027-03-31 counts. The IST offset is handled
 * by shifting UTC boundaries — spec §5 stores DateTime as UTC and
 * IST is fixed at +5:30.
 *
 * `outstanding` and `oldestOpenInvoice` are placeholders until an
 * external invoice source (CSV/XLSX or Books) lands — spec §9. The
 * shape is there so the UI has stable types.
 */
import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

/** { startYear: 2026, from: 2026-04-01T00:00 IST as UTC } */
export function currentFinancialYear(now: Date = new Date()): {
  startYear: number
  from: Date
  to: Date
} {
  // Shift the "now" clock to IST so April 1 in IST maps to a boundary
  // computed in UTC. The `- IST_OFFSET_MS` here means: the UTC instant
  // whose IST time is exactly 00:00 on April 1.
  const ist = new Date(now.getTime() + IST_OFFSET_MS)
  const y = ist.getUTCFullYear()
  const m = ist.getUTCMonth() // 0-indexed; April = 3
  const startYear = m >= 3 ? y : y - 1
  const from = new Date(Date.UTC(startYear, 3, 1) - IST_OFFSET_MS)
  const to = new Date(Date.UTC(startYear + 1, 3, 1) - IST_OFFSET_MS)
  return { startYear, from, to }
}

export interface BillingSlice {
  billingAccount: {
    id: string
    label: string
    isGstRegistered: boolean
    legalEntityName: string
  } | null
  financialYear: string
  paidThisFyPaise: number
  paymentCountThisFy: number
  lastPayment: {
    id: string
    paidAt: Date
    amountPaise: number
    matchedInvoiceRef: string | null
  } | null
  /** Placeholder — needs an invoice source. Always null for step 6. */
  outstandingPaise: number | null
  /** Placeholder — needs an invoice source. */
  oldestOpenInvoice: null
}

export async function billingSliceFor(
  clientId: string,
  organisationId: string,
): Promise<BillingSlice> {
  const client = await prisma.client.findFirst({
    where: { id: clientId, organisationId, deletedAt: null },
    select: {
      id: true,
      billingAccountId: true,
      billingAccount: {
        select: {
          id: true, label: true, isGstRegistered: true,
          legalEntityName: true, deletedAt: true,
        },
      },
    },
  })
  if (!client) throw ApiError.notFound('No such client.')

  const fy = currentFinancialYear()
  const fyName = `${fy.startYear}-${(fy.startYear + 1).toString().slice(-2)}`

  const [fyAgg, last] = await Promise.all([
    prisma.zpayPayment.aggregate({
      where: {
        matchedClientId: clientId,
        paidAt: { gte: fy.from, lt: fy.to },
        matchType: { in: ['exact', 'manual'] as string[] },
      },
      _sum: { amountPaise: true },
      _count: { _all: true },
    }),
    prisma.zpayPayment.findFirst({
      where: {
        matchedClientId: clientId,
        matchType: { in: ['exact', 'manual'] as string[] },
      },
      orderBy: { paidAt: 'desc' },
      select: {
        id: true, paidAt: true, amountPaise: true, matchedInvoiceRef: true,
      },
    }),
  ])

  return {
    billingAccount: client.billingAccount && !client.billingAccount.deletedAt
      ? {
          id: client.billingAccount.id,
          label: client.billingAccount.label,
          isGstRegistered: client.billingAccount.isGstRegistered,
          legalEntityName: client.billingAccount.legalEntityName,
        }
      : null,
    financialYear: fyName,
    paidThisFyPaise: fyAgg._sum.amountPaise ?? 0,
    paymentCountThisFy: fyAgg._count._all,
    lastPayment: last,
    outstandingPaise: null,
    oldestOpenInvoice: null,
  }
}

export async function setBillingAccount(
  clientId: string,
  organisationId: string,
  accountId: string | null,
  actorUserId: string,
): Promise<{ billingAccountId: string | null }> {
  const client = await prisma.client.findFirst({
    where: { id: clientId, organisationId, deletedAt: null },
    select: { id: true },
  })
  if (!client) throw ApiError.notFound('No such client.')

  if (accountId) {
    // The account must belong to a connection in the same org.
    const account = await prisma.zpayAccount.findFirst({
      where: {
        id: accountId,
        deletedAt: null,
        connection: { organisationId, deletedAt: null },
      },
      select: { id: true },
    })
    if (!account) {
      throw ApiError.badRequest('accountId does not belong to a Zoho Payments account in this organisation.')
    }
  }

  await prisma.client.update({
    where: { id: client.id },
    data: {
      billingAccountId: accountId,
      updatedBy: actorUserId,
    },
  })

  return { billingAccountId: accountId }
}
