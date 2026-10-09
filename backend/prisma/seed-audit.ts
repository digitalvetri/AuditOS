/**
 * Audit files reference data — the four checklist templates
 * (acceptance, caro_2020, form_3cd, completion). Headings live in
 * src/modules/audit/data.ts.
 *
 * Idempotent: templates upsert by code, items by (template, clause). Names,
 * headings, sources and order are refreshed; nothing is deleted, so a file's
 * answered responses (keyed by template code + clause) are never orphaned.
 * A new form version is a new template code, not an edit of an old one.
 */
import type { PrismaClient } from '@prisma/client'
import { CHECKLIST_TEMPLATES } from '../src/modules/audit/data.js'

export async function seedAudit(prisma: PrismaClient) {
  let items = 0
  for (const t of CHECKLIST_TEMPLATES) {
    const tpl = await prisma.auditChecklistTemplate.upsert({
      where: { code: t.code },
      create: { code: t.code, name: t.name, appliesTo: t.appliesTo, description: t.description, source: t.source },
      update: { name: t.name, appliesTo: t.appliesTo, description: t.description, source: t.source },
    })
    for (const [i, it] of t.items.entries()) {
      await prisma.auditChecklistItem.upsert({
        where: { templateId_clause: { templateId: tpl.id, clause: it.clause } },
        create: { templateId: tpl.id, clause: it.clause, heading: it.heading, guidance: it.guidance ?? null, sortOrder: (i + 1) * 10 },
        update: { heading: it.heading, guidance: it.guidance ?? null, sortOrder: (i + 1) * 10 },
      })
      items++
    }
  }
  return { templates: CHECKLIST_TEMPLATES.length, items }
}

// `npx tsx prisma/seed-audit.ts` — sync the checklist templates on an
// existing database without the full seed.
if (process.argv[1] && /seed-audit\.(ts|js)$/.test(process.argv[1])) {
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()
  seedAudit(prisma)
    .then((r) => console.log('Audit checklist templates:', r))
    .catch((e) => { console.error(e); process.exitCode = 1 })
    .finally(() => prisma.$disconnect())
}
