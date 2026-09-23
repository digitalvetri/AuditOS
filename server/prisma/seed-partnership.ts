/**
 * Partnership Firm Registration seed — REFERENCE DATA ONLY.
 *
 * The service row a client is enrolled in, the document category its files
 * are filed under, and the master checklist from the firm's own PDF (see
 * src/modules/partnership/template.ts). No clients, cases or uploads: those
 * start empty and are made in the app.
 *
 * The template is written only when it is EMPTY. Once an admin edits the
 * master checklist in the app, a re-run of the seed (every `docker compose
 * up`) must not put the PDF wording back over their changes.
 */
import type { PrismaClient } from '@prisma/client'
import { KINDS, REGISTRATION_KINDS, PFR_DOC_CATEGORY_CODE } from '../src/modules/partnership/constants.js'

/** Partnership Firm Registration and LLP Registration share one case engine. */
export async function seedPartnership(prisma: PrismaClient, orgId: string) {
  await prisma.documentCategory.upsert({
    where: { code: PFR_DOC_CATEGORY_CODE },
    update: {},
    create: { id: 'dc-registration', code: PFR_DOC_CATEGORY_CODE, name: 'Registration', description: 'Documents collected for a registration case', sortOrder: 5, organisationId: orgId },
  })

  const result: Record<string, { templateCategories: number; seeded: boolean }> = {}
  for (const kind of REGISTRATION_KINDS) {
    const cfg = KINDS[kind]
    await prisma.service.upsert({
      where: { code: cfg.serviceCode },
      update: { name: cfg.label, isActive: true },
      create: { id: cfg.serviceId, code: cfg.serviceCode, name: cfg.label, sortOrder: 3, isActive: true, organisationId: orgId },
    })

    const existing = await prisma.partnershipTemplateCategory.count({ where: { kind, deletedAt: null } })
    if (existing > 0) { result[kind] = { templateCategories: existing, seeded: false }; continue }

    let catOrder = 0
    for (const cat of cfg.template) {
      catOrder += 10
      await prisma.partnershipTemplateCategory.create({
        data: {
          kind,
          name: cat.name,
          description: cat.description ?? null,
          stage: cat.stage,
          perPartner: cat.perPartner ?? false,
          sortOrder: catOrder,
          createdBy: 'seed',
          items: {
            create: cat.items.map((it, i) => ({
              name: it.name,
              description: it.description ?? null,
              requirement: it.requirement,
              kind: it.kind,
              perPartner: it.perPartner ?? false,
              docKey: it.docKey ?? null,
              condition: it.condition ?? null,
              docTypeOptions: it.docTypeOptions?.join('|') ?? null,
              maxAgeDays: it.maxAgeDays ?? null,
              sortOrder: (i + 1) * 10,
              createdBy: 'seed',
            })),
          },
        },
      })
    }
    result[kind] = { templateCategories: cfg.template.length, seeded: true }
  }
  return result
}
