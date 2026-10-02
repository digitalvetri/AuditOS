/**
 * Permission sync — upserts every permission code in the RBAC matrix and
 * every role grant, WITHOUT touching any other data.
 *
 * `npm run seed` also does this, but it seeds demo data alongside; this
 * script is the safe way to roll out new permission codes (such as the
 * Tally voucher/report/audit codes) onto an existing database.
 *
 * Run: npm --prefix backend run sync:permissions
 */
import '../src/lib/env.js'
import { PrismaClient } from '@prisma/client'
import { ALL_PERMISSION_CODES, MATRIX, PERMISSION_DESCRIPTIONS, type RoleCode } from '../src/platform/rbac/matrix.js'
import { VISIBLE_ROLE_CODES } from '../src/platform/rbac/modules.js'
import { setupRoles } from './setup-roles.js'

const prisma = new PrismaClient()

async function main() {
  let permissions = 0
  for (const code of ALL_PERMISSION_CODES) {
    await prisma.permission.upsert({
      where: { id: `perm-${code}` },
      create: { id: `perm-${code}`, code, description: PERMISSION_DESCRIPTIONS[code] ?? code },
      update: { code, description: PERMISSION_DESCRIPTIONS[code] ?? code },
    })
    permissions++
  }

  let grants = 0
  const roles = await prisma.role.findMany({ select: { id: true, code: true } })
  for (const role of roles) {
    // The five live roles are module-based — handled by setupRoles below,
    // which keeps what Settings → Roles & permissions set.
    if (VISIBLE_ROLE_CODES.includes(role.code as RoleCode)) continue
    const matrix = MATRIX[role.code as RoleCode]
    if (!matrix) continue
    for (const grant of matrix) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: `perm-${grant.permission}` } },
        create: { roleId: role.id, permissionId: `perm-${grant.permission}`, scope: grant.scope },
        update: { scope: grant.scope },
      })
      grants++
    }
  }
  await setupRoles(prisma)
  console.log(`synced ${permissions} permissions and ${grants} legacy role grants; module roles topped up`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
