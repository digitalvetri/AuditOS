import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../__tests__/helpers.js'
import { nextQuotationCode } from '../../platform/workstation/codes.js'

/**
 * Read-max-then-insert allocators run inside the creating transaction, but
 * under READ COMMITTED two transactions still read the same maximum and
 * collide on the @unique code. The per-sequence advisory lock serialises
 * allocation, so parallel creates must all succeed with distinct codes.
 * Year 2091 keeps these rows out of every real sequence.
 */
const YEAR = 2091

afterAll(async () => {
  await prisma.quotation.deleteMany({ where: { quotationCode: { startsWith: `QT-${YEAR}-` } } })
  await prisma.$disconnect()
})

describe('sequence allocation under concurrency', () => {
  it('hands out distinct quotation codes to parallel creates', async () => {
    await prisma.quotation.deleteMany({ where: { quotationCode: { startsWith: `QT-${YEAR}-` } } })
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
      prisma.$transaction(async (tx) => {
        const code = await nextQuotationCode(tx, YEAR)
        // A little work between read and insert, as the real service does.
        await tx.$executeRaw`SELECT pg_sleep(0.02)`
        return tx.quotation.create({
          data: {
            organisationId: 'org-seq', quotationCode: code,
            subject: `Parallel ${i}`, quoteDate: `${YEAR}-01-01`, validUntil: `${YEAR}-01-31`,
          },
        })
      })))
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected).toEqual([])
    const codes = results.map((r) => (r as PromiseFulfilledResult<{ quotationCode: string }>).value.quotationCode)
    expect(new Set(codes).size).toBe(6)
    expect([...codes].sort()).toEqual(
      Array.from({ length: 6 }, (_, i) => `QT-${YEAR}-${String(i + 1).padStart(4, '0')}`))
  })
})
