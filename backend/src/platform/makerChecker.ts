import { prisma, alive } from '../lib/prisma.js'

/**
 * Maker-checker: the person who prepared something should not be the one who
 * signs it off. A one-person firm has nobody else to ask, so the rule relaxes
 * when the caller's firm has exactly one active employee.
 */
export async function isSoleActiveEmployee(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { organisationId: true } })
  if (!user) return false
  const active = await prisma.employee.count({
    where: { organisationId: user.organisationId, status: 'active', ...alive },
  })
  return active <= 1
}
