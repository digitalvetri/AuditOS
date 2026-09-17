/**
 * Permission sync — upserts every permission code in the RBAC matrix and
 * every role grant, WITHOUT touching any other data.
 *
 * `npm run seed` also does this, but it seeds demo data alongside; this
 * script is the safe way to roll out new permission codes (such as the
 * Tally voucher/report/audit codes) onto an existing database.
 *
 * Run: npm --prefix server run sync:permissions
 */
import '../src/lib/env.js'
import { PrismaClient } from '@prisma/client'
import { ALL_PERMISSION_CODES, MATRIX, PERMISSION_DESCRIPTIONS, type RoleCode } from '../src/platform/rbac/matrix.js'

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
  console.log(`synced ${permissions} permissions and ${grants} role grants across ${roles.length} roles`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
