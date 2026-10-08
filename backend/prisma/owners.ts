import type { PrismaClient } from '@prisma/client'
import { hashPassword } from '../src/platform/auth.js'
import { passwordProblem } from '../src/platform/password.js'

export interface OwnerSpec { email: string; password: string; roleCode: 'md' | 'hr_admin' }

/**
 * The firm's two owner logins (Super Admin, Admin). Login-only — no Employee
 * record, so they never appear in attendance, leave or payroll. Idempotent:
 * an existing owner keeps its password unless resetPasswords is set.
 */
export async function ensureOwners(prisma: PrismaClient, owners: OwnerSpec[], opts: { resetPasswords: boolean }) {
  const org = await prisma.organisation.findFirstOrThrow({ where: { deletedAt: null } })
  const results: { email: string; action: 'created' | 'updated' | 'unchanged' }[] = []
  for (const o of owners) {
    const email = o.email.trim().toLowerCase()
    const problem = passwordProblem(o.password)
    if (problem) throw new Error(`${email}: ${problem}`)
    const role = await prisma.role.findUniqueOrThrow({ where: { code: o.roleCode } })
    const existing = await prisma.user.findUnique({ where: { email } })
    if (!existing) {
      await prisma.user.create({
        data: { organisationId: org.id, email, passwordHash: hashPassword(o.password), roleId: role.id },
      })
      results.push({ email, action: 'created' })
      continue
    }
    const data: Record<string, unknown> = {}
    if (existing.roleId !== role.id) data.roleId = role.id
    if (!existing.isActive || existing.deletedAt) { data.isActive = true; data.deletedAt = null }
    if (opts.resetPasswords) {
      data.passwordHash = hashPassword(o.password)
      data.mustChangePassword = false
      data.sessionVersion = { increment: 1 }
    }
    if (Object.keys(data).length === 0) { results.push({ email, action: 'unchanged' }); continue }
    await prisma.user.update({ where: { id: existing.id }, data })
    results.push({ email, action: 'updated' })
  }
  return results
}
