/**
 * One-shot: soft-delete the GST Registration master template so the next
 * seed run picks up the current template.ts shape.
 *
 * The Partnership template seed (seed-partnership.ts) intentionally writes
 * ONLY when its target kind has no template rows — so operators' in-app
 * edits survive `docker compose up`. When template.ts itself changes, that
 * protection stops the new version from landing. This script exists so a
 * template rewrite can be applied deliberately, one kind at a time, without
 * flipping the seed's "only if empty" invariant.
 *
 * What it touches:
 *   • partnershipTemplateItem rows where category.kind = GST → deletedAt
 *   • partnershipTemplateCategory rows where kind = GST → deletedAt
 * Nothing else. Existing GST Registration CASES (`partnershipCase` +
 * `partnershipCaseCategory` + `partnershipCaseItem`) are untouched — items
 * on already-opened cases were copies from the template at openCase time
 * and remain valid.
 *
 * Run with:
 *   docker compose run --rm migrate node dist/prisma/reset-gst-template.js
 * or, on the host:
 *   npm --prefix server run reset:gst-template
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const now = new Date()
  const cats = await prisma.partnershipTemplateCategory.findMany({
    where: { kind: 'GST', deletedAt: null },
    select: { id: true },
  })
  if (cats.length === 0) {
    console.log('reset-gst-template: nothing to do — GST master template is already empty.')
    return
  }
  const catIds = cats.map((c) => c.id)
  const itemsUpdated = await prisma.partnershipTemplateItem.updateMany({
    where: { categoryId: { in: catIds }, deletedAt: null },
    data: { deletedAt: now },
  })
  const catsUpdated = await prisma.partnershipTemplateCategory.updateMany({
    where: { id: { in: catIds } },
    data: { deletedAt: now },
  })
  console.log('reset-gst-template: soft-deleted', {
    categories: catsUpdated.count,
    items: itemsUpdated.count,
  })
  console.log('reset-gst-template: run `npm --prefix server run seed` (or `docker compose run --rm migrate`) to re-seed from the current template.ts.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
