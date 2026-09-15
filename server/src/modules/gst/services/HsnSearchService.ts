/**
 * Thin HSN/SAC lookup for the invoice-form autocomplete. Matches on
 * code prefix OR description substring, case-insensitive on the
 * description. Kept intentionally small — an inactive HSN row is not
 * returned but is not deleted either, so past invoices that reference
 * it can still resolve.
 */
import type { Prisma, PrismaClient } from '@prisma/client'

export interface HsnSearchArgs {
  /** Free-text query. Leading digits match the code prefix; otherwise
   * match the description. Empty query returns the top 20 by code. */
  q?:    string
  kind?: 'goods' | 'services'
  limit?: number
}

export async function searchHsn(prisma: PrismaClient, args: HsnSearchArgs) {
  const limit = Math.min(args.limit ?? 20, 100)
  const q = (args.q ?? '').trim()

  const where: Prisma.HsnMasterWhereInput = { isActive: true }
  if (args.kind) where.kind = args.kind
  if (q) {
    // Digits-only prefix means the user is typing a code.
    if (/^\d+$/.test(q)) {
      where.code = { startsWith: q }
    } else {
      where.OR = [
        { code: { startsWith: q } },
        { description: { contains: q, mode: 'insensitive' } },
      ]
    }
  }

  return prisma.hsnMaster.findMany({
    where,
    orderBy: [{ code: 'asc' }],
    take: limit,
  })
}
