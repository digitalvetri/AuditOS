/**
 * npm run setup:owners [-- --reset-passwords]
 *
 * Creates the Super Admin and Admin logins from env (backend/.env locally,
 * docker/.env.docker in Docker). Passwords never live in the repository.
 */
// Loads backend/.env (real env vars win), same loader the server uses.
import '../src/lib/env.js'
import { PrismaClient } from '@prisma/client'
import { ensureOwners, type OwnerSpec } from './owners.js'

const prisma = new PrismaClient()

function owner(prefix: string, roleCode: OwnerSpec['roleCode']): OwnerSpec | null {
  const email = process.env[`${prefix}_EMAIL`]
  const password = process.env[`${prefix}_PASSWORD`]
  if (!email && !password) return null
  if (!email || !password) throw new Error(`Set both ${prefix}_EMAIL and ${prefix}_PASSWORD.`)
  return { email, password, roleCode }
}

async function main() {
  const owners = [owner('OWNER_SUPERADMIN', 'md'), owner('OWNER_ADMIN', 'hr_admin')].filter((o): o is OwnerSpec => !!o)
  if (owners.length === 0) {
    // Fine on a running firm; fatal on a fresh one — nobody could ever sign in.
    const admins = await prisma.user.count({
      where: { isActive: true, deletedAt: null, role: { code: { in: ['md', 'hr_admin'] } } },
    })
    if (admins === 0) {
      throw new Error('No Admin or Super Admin login exists and no OWNER_* variables are set — nobody could sign in. Set OWNER_SUPERADMIN_* / OWNER_ADMIN_* and run again.')
    }
    console.log('[setup-owners] No OWNER_* variables set — existing Admin logins kept.')
    return
  }
  const results = await ensureOwners(prisma, owners, { resetPasswords: process.argv.includes('--reset-passwords') })
  for (const r of results) console.log(`[setup-owners] ${r.email}: ${r.action}`)
}

main()
  .catch((e) => { console.error('[setup-owners]', e instanceof Error ? e.message : e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
