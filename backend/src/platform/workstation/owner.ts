import { prisma } from '../../lib/prisma.js'
import type { Session } from '../auth.js'
import { PARTNER_TIER_ROLES } from '../notify.js'

/**
 * Who a lead or client belongs to when the form names nobody.
 *
 * Leads, clients and services are added WITHOUT choosing a person — work is
 * handed out only from the Task module. The record still needs an owner for
 * visibility (staff who see only their own clients must keep seeing what
 * they create), so it is the person creating it, or — when that login is not
 * an employee — the first active partner.
 */
export async function defaultOwnerEmployeeId(session: Session): Promise<string | null> {
  if (session.employeeId) return session.employeeId
  const partner = await prisma.user.findFirst({
    where: { isActive: true, deletedAt: null, employeeId: { not: null }, role: { code: { in: [...PARTNER_TIER_ROLES] } } },
    orderBy: { createdAt: 'asc' },
    select: { employeeId: true },
  })
  return partner?.employeeId ?? null
}
