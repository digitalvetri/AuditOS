import type { PrismaClient } from '@prisma/client'
import { TOOL_CATEGORIES, TOOL_GROUPS, TOOLS } from '../src/modules/tools/registry.js'

/**
 * Sync the tool catalogue tables FROM the code registry. Idempotent; called
 * by the main seed and safe to run on its own (`npm run seed:tools`).
 * Rows are never deleted — a retired tool keeps its id so old jobs still join.
 */
export async function seedTools(prisma: PrismaClient): Promise<void> {
  for (const c of TOOL_CATEGORIES) {
    await prisma.toolCategory.upsert({
      where: { id: c.id },
      update: { key: c.id, label: c.label, order: c.order, status: c.status },
      create: { id: c.id, key: c.id, label: c.label, order: c.order, status: c.status },
    })
  }
  for (const g of TOOL_GROUPS) {
    await prisma.toolGroup.upsert({
      where: { id: g.id },
      update: { key: g.id, label: g.label, categoryId: g.categoryId, order: g.order },
      create: { id: g.id, key: g.id, label: g.label, categoryId: g.categoryId, order: g.order },
    })
  }
  for (const t of TOOLS) {
    const data = { key: t.id, name: t.name, description: t.description, groupId: t.groupId, outputType: t.outputType, permissionKey: t.permission, status: t.status }
    await prisma.tool.upsert({ where: { id: t.id }, update: data, create: { id: t.id, ...data } })
  }
  console.log(`Tools catalogue: ${TOOL_CATEGORIES.length} categories, ${TOOL_GROUPS.length} groups, ${TOOLS.length} tools.`)
}

// `npm run seed:tools` — sync the catalogue without re-running the whole seed.
if (process.argv[1] && /seed-tools\.(ts|js)$/.test(process.argv[1])) {
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()
  seedTools(prisma)
    .catch((e) => { console.error(e); process.exitCode = 1 })
    .finally(() => prisma.$disconnect())
}
