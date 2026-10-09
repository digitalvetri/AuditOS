import type { PrismaClient } from '@prisma/client'
import { hashPassword } from '../src/platform/auth.js'
import { passwordProblem } from '../src/platform/password.js'
import { nextEmployeeCode } from '../src/lib/sequence.js'
import { istToday } from '../src/lib/dates.js'

export interface OwnerSpec { email: string; password: string; roleCode: 'md' | 'hr_admin'; name?: string }

/**
 * The firm's two owner logins (Super Admin, Admin). Idempotent: an existing
 * owner keeps its password unless resetPasswords is set.
 *
 * The Admin also gets a staff record so they can use Messages (chats are
 * between staff), marked excludeFromHr so it never appears in attendance,
 * leave or payroll. The Super Admin stays login-only: it is hidden from
 * everyone, so it has no presence in chats either.
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
      const user = await prisma.user.create({
        data: { organisationId: org.id, email, passwordHash: hashPassword(o.password), roleId: role.id },
      })
      if (o.roleCode === 'hr_admin') await ensureOwnerStaffRecord(prisma, org.id, user.id, email, o.name)
      results.push({ email, action: 'created' })
      continue
    }
    const linked = o.roleCode === 'hr_admin' && !existing.employeeId
      ? await ensureOwnerStaffRecord(prisma, org.id, existing.id, email, o.name)
      : false
    const data: Record<string, unknown> = {}
    if (existing.roleId !== role.id) data.roleId = role.id
    if (!existing.isActive || existing.deletedAt) { data.isActive = true; data.deletedAt = null }
    if (opts.resetPasswords) {
      data.passwordHash = hashPassword(o.password)
      data.mustChangePassword = false
      data.sessionVersion = { increment: 1 }
    }
    if (Object.keys(data).length === 0) { results.push({ email, action: linked ? 'updated' : 'unchanged' }); continue }
    await prisma.user.update({ where: { id: existing.id }, data })
    results.push({ email, action: 'updated' })
  }
  return results
}

/** Give the Admin owner a staff record for Messages, outside HR tracking. */
async function ensureOwnerStaffRecord(prisma: PrismaClient, organisationId: string, userId: string, email: string, name?: string): Promise<boolean> {
  const schedule = await prisma.workSchedule.findFirst({ where: { deletedAt: null } })
  if (!schedule) return false // the seed creates one; without it, stay login-only
  const fullName = (name ?? '').trim() || 'Admin'
  const [firstName, ...rest] = fullName.split(/\s+/)
  await prisma.$transaction(async (tx) => {
    // Re-use a staff record already holding this email (e.g. created by hand).
    const existing = await tx.employee.findUnique({ where: { email } })
    const employee = existing
      ? await tx.employee.update({ where: { id: existing.id }, data: { excludeFromHr: true } })
      : await tx.employee.create({
          data: {
            organisationId, employeeCode: await nextEmployeeCode(tx), firstName, lastName: rest.join(' '),
            fullName, email, status: 'active', joiningDate: istToday(), workScheduleId: schedule.id,
            excludeFromHr: true,
          },
        })
    await tx.user.update({ where: { id: userId }, data: { employeeId: employee.id } })
  })
  return true
}
