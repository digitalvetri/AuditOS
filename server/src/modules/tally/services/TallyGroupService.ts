import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { TallyCompanyService } from './TallyCompanyService.js'

/**
 * TallyGroupService — the group tree per company. Primary groups
 * (seeded at company creation) can't be deleted; sub-groups can, but
 * only if no active ledgers belong to them.
 */

export interface GroupApi {
  id: string
  name: string
  parent_group_id: string | null
  nature: string
  affects_pl: boolean
  is_primary: boolean
}

export interface GroupTreeNode extends GroupApi {
  children: GroupTreeNode[]
}

function toApi(row: {
  id: string; name: string; parentGroupId: string | null; nature: string;
  affectsPL: boolean; isPrimary: boolean;
}): GroupApi {
  return {
    id: row.id, name: row.name, parent_group_id: row.parentGroupId,
    nature: row.nature, affects_pl: row.affectsPL, is_primary: row.isPrimary,
  }
}

export const TallyGroupService = {
  toApi,

  async list(session: Session, companyId: string): Promise<GroupApi[]> {
    await TallyCompanyService.requireOwned(session, companyId)
    const rows = await prisma.tallyGroup.findMany({
      where: { tallyCompanyId: companyId, ...alive },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
    })
    return rows.map(toApi)
  },

  async tree(session: Session, companyId: string): Promise<GroupTreeNode[]> {
    const flat = await TallyGroupService.list(session, companyId)
    const byId = new Map<string, GroupTreeNode>()
    for (const g of flat) byId.set(g.id, { ...g, children: [] })
    const roots: GroupTreeNode[] = []
    for (const g of byId.values()) {
      if (g.parent_group_id && byId.has(g.parent_group_id)) {
        byId.get(g.parent_group_id)!.children.push(g)
      } else {
        roots.push(g)
      }
    }
    return roots
  },

  async create(session: Session, companyId: string, input: {
    name: string
    parentGroupId?: string | null
    nature?: string
    affectsPL?: boolean
  }): Promise<GroupApi> {
    await TallyCompanyService.requireOwned(session, companyId)
    const name = input.name.trim()
    if (!name) throw ApiError.badRequest('Group name is required.')
    const clash = await prisma.tallyGroup.findFirst({
      where: { tallyCompanyId: companyId, name, ...alive },
      select: { id: true },
    })
    if (clash) throw ApiError.conflict('duplicate_name', `A group named "${name}" already exists.`)

    // If parent is set: inherit nature + affectsPL from the parent unless
    // explicitly overridden.
    let nature = input.nature
    let affectsPL = input.affectsPL
    if (input.parentGroupId) {
      const parent = await prisma.tallyGroup.findFirst({
        where: { id: input.parentGroupId, tallyCompanyId: companyId, ...alive },
      })
      if (!parent) throw ApiError.badRequest('Parent group does not belong to this company.')
      if (nature === undefined) nature = parent.nature
      if (affectsPL === undefined) affectsPL = parent.affectsPL
    }
    if (!nature) throw ApiError.badRequest('Nature is required (assets | liabilities | income | expenses).')
    if (!['assets', 'liabilities', 'income', 'expenses'].includes(nature)) {
      throw ApiError.badRequest('Nature must be assets, liabilities, income, or expenses.')
    }
    const row = await prisma.tallyGroup.create({
      data: {
        tallyCompanyId: companyId,
        name,
        parentGroupId: input.parentGroupId ?? null,
        nature,
        affectsPL: affectsPL ?? false,
        isPrimary: false,
      },
    })
    return toApi(row)
  },

  async update(session: Session, companyId: string, groupId: string, patch: {
    name?: string
    parentGroupId?: string | null
    affectsPL?: boolean
  }): Promise<GroupApi> {
    await TallyCompanyService.requireOwned(session, companyId)
    const existing = await prisma.tallyGroup.findFirst({
      where: { id: groupId, tallyCompanyId: companyId, ...alive },
    })
    if (!existing) throw ApiError.notFound('No such group.')

    const data: Record<string, unknown> = {}
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) throw ApiError.badRequest('Group name is required.')
      if (existing.isPrimary && name !== existing.name) {
        throw ApiError.badRequest('Primary group names cannot be changed.')
      }
      const clash = await prisma.tallyGroup.findFirst({
        where: { tallyCompanyId: companyId, name, ...alive, NOT: { id: groupId } },
        select: { id: true },
      })
      if (clash) throw ApiError.conflict('duplicate_name', `A group named "${name}" already exists.`)
      data.name = name
    }
    if (patch.parentGroupId !== undefined) {
      if (existing.isPrimary) throw ApiError.badRequest('Primary groups cannot be re-parented.')
      if (patch.parentGroupId === groupId) throw ApiError.badRequest('A group cannot be its own parent.')
      if (patch.parentGroupId) {
        const parent = await prisma.tallyGroup.findFirst({
          where: { id: patch.parentGroupId, tallyCompanyId: companyId, ...alive },
        })
        if (!parent) throw ApiError.badRequest('Parent group does not belong to this company.')
      }
      data.parentGroupId = patch.parentGroupId
    }
    if (patch.affectsPL !== undefined) data.affectsPL = patch.affectsPL

    const updated = await prisma.tallyGroup.update({ where: { id: groupId }, data })
    return toApi(updated)
  },

  async softDelete(session: Session, companyId: string, groupId: string): Promise<void> {
    await TallyCompanyService.requireOwned(session, companyId)
    const existing = await prisma.tallyGroup.findFirst({
      where: { id: groupId, tallyCompanyId: companyId, ...alive },
    })
    if (!existing) throw ApiError.notFound('No such group.')
    if (existing.isPrimary) throw ApiError.badRequest('Primary groups cannot be deleted.')
    const ledgerCount = await prisma.tallyLedger.count({
      where: { groupId, ...alive },
    })
    if (ledgerCount > 0) {
      throw ApiError.badRequest(`Cannot delete: ${ledgerCount} ledger(s) belong to this group.`)
    }
    const childCount = await prisma.tallyGroup.count({
      where: { parentGroupId: groupId, ...alive },
    })
    if (childCount > 0) {
      throw ApiError.badRequest(`Cannot delete: ${childCount} sub-group(s) belong to this group.`)
    }
    await prisma.tallyGroup.update({ where: { id: groupId }, data: { deletedAt: new Date() } })
  },
}
