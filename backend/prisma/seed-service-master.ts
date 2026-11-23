/**
 * Service master seed (JNS scope of work). Create-only, keyed by code: a
 * service the firm has already edited, deactivated or deleted is left alone,
 * so a deploy never undoes their changes.
 */
import type { PrismaClient } from '@prisma/client'
import { JNS_SERVICE_MASTER } from './data-jns-service-master.js'

export async function seedServiceMaster(prisma: PrismaClient, organisationId: string) {
  let created = 0
  const existing = new Set((await prisma.service.findMany({ where: { deletedAt: null }, select: { code: true } })).map((s) => s.code))
  for (const [i, s] of JNS_SERVICE_MASTER.entries()) {
    if (await prisma.serviceMaster.findUnique({ where: { code: s.code } })) continue
    await prisma.serviceMaster.create({
      data: {
        organisationId, code: s.code, category: s.category, name: s.name, billingFrequency: s.billingFrequency,
        serviceCode: s.serviceCodes.find((c) => existing.has(c)) ?? null, sortOrder: (i + 1) * 10,
        items: { create: s.items.map((it, j) => ({ kind: it.kind, content: it.content, sortOrder: (j + 1) * 10 })) },
      },
    })
    created += 1
  }
  return { created, total: JNS_SERVICE_MASTER.length }
}
