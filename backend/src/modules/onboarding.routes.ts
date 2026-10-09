import { Router } from 'express'
import { ApiError, handler, ok } from '../lib/http.js'
import { prisma, alive } from '../lib/prisma.js'
import { requireSession, type Session } from '../platform/auth.js'
import { writeAudit } from '../platform/audit.js'

/**
 * FIRST-RUN SETUP CHECKLIST — GET/POST /api/settings/onboarding.
 *
 * Shown on the dashboard to the Admin and Super Admin until they dismiss it
 * (Organisation.onboardingDismissedAt). Every step's completion is read live
 * from the tables it describes, so the list ticks itself off as the firm is
 * set up — nothing is stored per step.
 */
export const onboardingRouter = Router()

const OWNER_ROLES = new Set(['md', 'hr_admin'])

function requireOwner(session: Session) {
  if (!OWNER_ROLES.has(session.roleCode)) throw ApiError.forbidden()
}

async function orgOf(session: Session) {
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { organisationId: true } })
  const org = (user && await prisma.organisation.findFirst({ where: { id: user.organisationId, ...alive } }))
    ?? await prisma.organisation.findFirst({ where: alive, orderBy: { createdAt: 'asc' } })
  if (!org) throw ApiError.notFound('No firm is set up.')
  return org
}

async function checklist(session: Session) {
  const org = await orgOf(session)
  // The app serves one firm; client-side tables are counted firm-wide.
  const [banks, staff, clients, services, obligations, audits] = await Promise.all([
    prisma.firmBankAccount.count({ where: { isActive: true } }),
    prisma.employee.count({ where: { ...alive, status: { not: 'inactive' } } }),
    prisma.client.count({ where: alive }),
    prisma.clientService.count({ where: alive }),
    prisma.clientObligation.count({ where: { ...alive, isActive: true } }),
    prisma.auditEngagement.count({ where: alive }),
  ])
  const steps = [
    {
      key: 'firm', label: 'Firm details & bank account',
      description: 'The firm name prints on every letterhead; invoices need a bank account to show for payment.',
      done: Boolean(org.name?.trim()) && banks > 0, count: banks,
      href: '/workstation/invoices/new',
    },
    {
      key: 'staff', label: 'Add your staff',
      description: 'Partners, managers and articles — so work can be assigned.',
      done: staff > 1, count: staff, href: '/hrms/employees?add=1',
    },
    {
      key: 'clients', label: 'Add clients',
      description: 'Import your client list from Excel, or add them one by one.',
      done: clients > 0, count: clients, href: '/workstation/clients?import=1',
    },
    {
      key: 'services', label: 'Assign services to clients',
      description: 'GST, TDS, audit, bookkeeping — what you do for each client.',
      done: services > 0, count: services, href: '/workstation/services',
    },
    {
      key: 'compliance', label: 'Set compliance obligations',
      description: 'Which returns each client must file, so the calendar knows the due dates.',
      done: obligations > 0, count: obligations, href: '/workstation/compliance',
    },
    {
      key: 'audit', label: 'Create your first audit file',
      description: 'One file per client, year and audit type — working papers, review notes, UDIN.',
      done: audits > 0, count: audits, href: '/workstation/audits',
    },
  ]
  const done = steps.filter((s) => s.done).length
  return {
    dismissed_at: org.onboardingDismissedAt?.toISOString() ?? null,
    steps,
    done,
    total: steps.length,
    complete: done === steps.length,
  }
}

onboardingRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  requireOwner(session)
  ok(res, await checklist(session))
}))

/** POST { dismissed: true | false } — hide the checklist, or bring it back. */
onboardingRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  requireOwner(session)
  const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  if (typeof b.dismissed !== 'boolean') throw ApiError.badRequest('Send { dismissed: true } or { dismissed: false }.', { dismissed: 'Must be true or false.' })
  const org = await orgOf(session)
  const after = await prisma.organisation.update({
    where: { id: org.id },
    data: { onboardingDismissedAt: b.dismissed ? new Date() : null, updatedBy: session.userId },
  })
  await writeAudit({
    actorUserId: session.userId, action: b.dismissed ? 'onboarding.dismiss' : 'onboarding.restore',
    entityType: 'Organisation', entityId: org.id,
    before: { onboarding_dismissed_at: org.onboardingDismissedAt }, after: { onboarding_dismissed_at: after.onboardingDismissedAt }, req,
  })
  ok(res, await checklist(session))
}))
