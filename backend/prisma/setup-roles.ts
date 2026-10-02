import type { PrismaClient } from '@prisma/client'
import { ALL_PERMISSION_CODES, PERMISSION_DESCRIPTIONS } from '../src/platform/rbac/matrix.js'
import { MODULES, moduleCodes, VISIBLE_ROLES } from '../src/platform/rbac/modules.js'

/**
 * The five roles (Super Admin, Admin, Senior Associate, Associate, Intern)
 * and their module access. A module a role holds is granted in full: every
 * code in it, organisation scope.
 *
 * Without `force` (the seed, sync:permissions, Docker `migrate`): a role that
 * is new, or still carries its pre-module name, gets the default modules;
 * every other role keeps what Settings → Roles & permissions set, and only
 * picks up permission codes added since to a module it already holds.
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
  const grant = (roleId: string, codes: string[]) =>
    prisma.rolePermission.createMany({
      data: codes
        .filter((c) => idOf.has(c))
        .map((c) => ({ roleId, permissionId: idOf.get(c)!, scope: 'organisation' })),
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
      await grant(role.id, r.modules.flatMap(moduleCodes))
      console.log(`Role ${r.name}: defaults (${r.modules.join(', ')})`)
    } else {
      // Top up: new codes in a module the role already holds.
      const held = new Set(existing!.permissions.map((rp) => rp.permission.code))
      const holds = MODULES.filter((m) => moduleCodes(m.code).some((c) => held.has(c)))
      await grant(role.id, holds.flatMap((m) => moduleCodes(m.code)).filter((c) => !held.has(c)))
    }
  }
}

// `npm run setup:roles` — reset the five roles to their default access.
if (process.argv[1] && /setup-roles\.(ts|js)$/.test(process.argv[1])) {
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()
  setupRoles(prisma, { force: true })
    .catch((e) => { console.error(e); process.exitCode = 1 })
    .finally(() => prisma.$disconnect())
}
