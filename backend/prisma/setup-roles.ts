import type { PrismaClient } from '@prisma/client'
import { ALL_PERMISSION_CODES, PERMISSION_DESCRIPTIONS } from '../src/platform/rbac/matrix.js'
import { defaultGrants, VISIBLE_ROLES } from '../src/platform/rbac/modules.js'
import { gatesFor, grantsAt, levelsOf, SECTIONS, type Grant } from '../src/platform/rbac/sections.js'

/**
 * The five roles (Super Admin, Admin, Senior Associate, Associate, Intern)
 * and their section access (rbac/sections.ts).
 *
 * Without `force` (the seed, sync:permissions, Docker `migrate`): a role that
 * is new, or still carries its pre-module name, gets the defaults; every
 * other role keeps what Settings → Roles & permissions set, and only picks
 * up permission codes added since to a section, at the level it already
 * holds that section — never a wider level, never another section.
 *
 * With `force` (`npm run setup:roles`): every role is reset to the defaults.
 */
export async function setupRoles(prisma: PrismaClient, opts: { force?: boolean } = {}): Promise<void> {
  for (const code of ALL_PERMISSION_CODES) {
    await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { id: `perm-${code}`, code, description: PERMISSION_DESCRIPTIONS[code] ?? code },
    })
  }
  const permissions = await prisma.permission.findMany({ where: { deletedAt: null } })
  const idOf = new Map(permissions.map((p) => [p.code, p.id]))
  const grant = (roleId: string, grants: Grant[]) =>
    prisma.rolePermission.createMany({
      data: grants
        .filter((g) => idOf.has(g.code))
        .map((g) => ({ roleId, permissionId: idOf.get(g.code)!, scope: g.scope })),
      skipDuplicates: true,
    })

  for (const r of VISIBLE_ROLES) {
    const existing = await prisma.role.findUnique({
      where: { code: r.code },
      include: { permissions: { include: { permission: true } } },
    })
    const applyDefaults = opts.force || !existing || existing.name !== r.name
    const role = await prisma.role.upsert({
      where: { code: r.code },
      update: { name: r.name, description: r.description, deletedAt: null },
      create: { id: r.id, code: r.code, name: r.name, description: r.description },
    })

    if (applyDefaults) {
      await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
      await grant(role.id, defaultGrants(r))
      console.log(`Role ${r.name}: defaults (${r.modules.join(', ')})`)
    } else {
      const held = new Map(existing!.permissions.map((rp) => [rp.permission.code, rp.scope as string]))
      const add = topUp(held)
      for (const g of add) held.set(g.code, g.scope)
      for (const code of gatesFor(held)) if (!held.has(code)) add.push({ code, scope: 'organisation' })
      if (add.length) await grant(role.id, add)
    }
  }
}

/**
 * Codes added to a section since a role's level was set. The role's level is
 * the highest one it holds a code+scope unique to (not in any lower level);
 * the missing grants of that level are returned. Held codes keep their scope.
 */
export function topUp(held: Map<string, string>): Grant[] {
  const add: Grant[] = []
  const key = (g: Grant) => `${g.code}@${g.scope}`
  for (const s of SECTIONS) {
    const levels = levelsOf(s).filter((l) => l !== 'none')
    for (let i = levels.length - 1; i >= 0; i--) {
      const lower = new Set(levels.slice(0, i).flatMap((l) => grantsAt(s, l).map(key)))
      const at = grantsAt(s, levels[i])
      if (!at.some((g) => !lower.has(key(g)) && held.get(g.code) === g.scope)) continue
      add.push(...at.filter((g) => !held.has(g.code)))
      break
    }
  }
  return add
}

// `npm run setup:roles` — reset the five roles to their default access.
if (process.argv[1] && /setup-roles\.(ts|js)$/.test(process.argv[1])) {
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()
  setupRoles(prisma, { force: true })
    .catch((e) => { console.error(e); process.exitCode = 1 })
    .finally(() => prisma.$disconnect())
}
