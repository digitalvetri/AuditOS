import { prisma } from '../../../lib/prisma.js'

/**
 * The master list of supported banks — read-only from a route's point of
 * view. Seeded from prisma/seed-audit-automation.ts against the wireframe
 * list (AMENDMENT-02 §3).
 *
 * Consumers: the bank picker on the upload wireframe.
 */
export interface AaBankApi {
  id: string
  key: string
  name: string
  order: number
}

export const AaBankService = {
  async listActive(): Promise<AaBankApi[]> {
    const rows = await prisma.aaBank.findMany({
      where: { active: true },
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
    })
    return rows.map((r) => ({ id: r.id, key: r.key, name: r.name, order: r.order }))
  },

  async get(id: string) {
    return prisma.aaBank.findUnique({ where: { id } })
  },

  async getByKey(key: string) {
    return prisma.aaBank.findUnique({ where: { key } })
  },
}
