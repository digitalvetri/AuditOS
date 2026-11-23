/**
 * TDS quarterly returns appear on the TDS board by themselves once a quarter
 * ends (calendar.ts expectedItems) — for clients the board knows: a TAN or a
 * TdsProfile. A client given the TDS Filing (or TDS) service is enrolled here
 * with a default profile (26Q), so its quarters show up without anyone
 * opening its TDS screen first. Runs daily with the compliance jobs.
 */
import type { PrismaClient } from '@prisma/client'

const TDS_SERVICES = ['TDS_FILING', 'TDS']

export async function enrolTdsClients(prisma: PrismaClient, opts: { organisationId?: string } = {}): Promise<number> {
  const services = await prisma.clientService.findMany({
    where: {
      deletedAt: null, status: { not: 'failed' }, service: { code: { in: TDS_SERVICES } },
      client: { deletedAt: null, status: { not: 'inactive' }, tdsProfile: { is: null }, ...(opts.organisationId ? { organisationId: opts.organisationId } : {}) },
    },
    select: { clientId: true },
  })
  let created = 0
  for (const clientId of new Set(services.map((s) => s.clientId))) {
    await prisma.tdsProfile.create({ data: { clientId, returnForms: '26Q' } })
      .then(() => { created += 1 })
      .catch((e: { code?: string }) => { if (e.code !== 'P2002') throw e })
  }
  return created
}
