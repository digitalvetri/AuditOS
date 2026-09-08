import type { PrismaClient } from '@prisma/client'

/**
 * Master list of banks supported by the audit-automation upload wireframe
 * (AMENDMENT-02 §3). Order matches the wireframe's rendered list; a bank
 * with an active adapter behaves normally, everything else routes through
 * the pipeline with adapter flags per §4-Prompt2-2. `Other / not listed`
 * is the synthetic key that maps to the generic adapter.
 *
 * The list is intentionally a small, honest set. AMENDMENT-02 §4-Prompt2-2:
 * "Never imply support you do not have."
 */
export const AA_BANKS: Array<{ key: string; name: string; order: number }> = [
  { key: 'hdfc-bank', name: 'HDFC Bank', order: 10 },
  { key: 'icici-bank', name: 'ICICI Bank', order: 20 },
  { key: 'sbi', name: 'State Bank of India', order: 30 },
  { key: 'axis-bank', name: 'Axis Bank', order: 40 },
  { key: 'kotak-mahindra', name: 'Kotak Mahindra Bank', order: 50 },
  { key: 'indian-bank', name: 'Indian Bank', order: 60 },
  { key: 'canara-bank', name: 'Canara Bank', order: 70 },
  { key: 'tmb', name: 'Tamilnad Mercantile Bank', order: 80 },
  { key: 'karur-vysya', name: 'Karur Vysya Bank', order: 90 },
  { key: 'city-union', name: 'City Union Bank', order: 100 },
  // Synthetic — routes to the generic adapter; UNKNOWN_FORMAT flag.
  { key: 'generic', name: 'Other / not listed', order: 999 },
]

export async function seedAuditAutomation(prisma: PrismaClient): Promise<void> {
  for (const b of AA_BANKS) {
    await prisma.aaBank.upsert({
      where: { key: b.key },
      update: { name: b.name, order: b.order, active: true },
      create: { id: b.key, key: b.key, name: b.name, order: b.order, active: true },
    })
  }
  console.log(`Audit Automation: ${AA_BANKS.length} banks seeded.`)
}

if (process.argv[1] && /seed-audit-automation\.(ts|js)$/.test(process.argv[1])) {
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()
  seedAuditAutomation(prisma)
    .catch((e) => { console.error(e); process.exitCode = 1 })
    .finally(() => prisma.$disconnect())
}
