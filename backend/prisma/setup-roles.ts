import type { Prisma, PrismaClient } from '@prisma/client'
import { ALL_PERMISSION_CODES, PERMISSION_DESCRIPTIONS } from '../src/platform/rbac/matrix.js'
import { MODULES, moduleCodes, scopeFor, VISIBLE_ROLES } from '../src/platform/rbac/modules.js'
import { AUDIT_CHAIN_LOCK, auditHash, type AuditHashInput } from '../src/platform/audit.js'
import { lockSequence } from '../src/lib/sequence.js'
import { stringifyJson } from '../src/lib/json.js'

/**
 * The five roles (Super Admin, Admin, Senior Associate, Associate, Intern)
 * and their module access. A module a role holds is granted in full: every
 * code in it, at the scope `scopeFor` gives that role (organisation, except
 * an Associate's or Intern's own tool documents).
 *
 * Without `force` (the seed, sync:permissions, Docker `migrate`): a role that
 * is new, or still carries its pre-module name, gets the default modules;
 * every other role keeps what Settings → Roles & permissions set, and only
 * picks up permission codes added since to a module it already holds.
 *
 * With `force` (`npm run setup:roles`): every role is reset to the defaults.
 *
 * Either way, Associate and Intern get the Tools lock-down once (see
 * `lockDownTools`), so databases set up while Books sat inside Tools lose
 * those grants on the next deploy.
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
  const grant = (roleId: string, roleCode: string, codes: string[]) =>
    prisma.rolePermission.createMany({
      data: codes
        .filter((c) => idOf.has(c))
        .map((c) => ({ roleId, permissionId: idOf.get(c)!, scope: scopeFor(roleCode, c) })),
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
      await grant(role.id, r.code, r.modules.flatMap(moduleCodes))
      console.log(`Role ${r.name}: defaults (${r.modules.join(', ')})`)
    }
    // Before the top-up: it must not read the old Books rows as "holds Books".
    if (LOCKDOWN_ROLES.includes(r.code) && await lockDownTools(prisma, role.id)) {
      console.log(`Role ${r.name}: Books editing removed; tool documents limited to their own`)
    }
    if (!applyDefaults) {
      // Top up: new codes in a module the role already holds.
      const rows = await prisma.rolePermission.findMany({ where: { roleId: role.id }, include: { permission: true } })
      const held = new Set(rows.map((rp) => rp.permission.code))
      const holds = MODULES.filter((m) => moduleCodes(m.code).some((c) => held.has(c)))
      await grant(role.id, r.code, holds.flatMap((m) => moduleCodes(m.code)).filter((c) => !held.has(c)))
    }
  }
}

/**
 * One-time correction for Associate and Intern. Books used to sit inside the
 * Tools module, and tool documents were granted at organisation scope, so
 * every database set up before this change gave them every `books.*` code and
 * the whole firm's tool documents. Removes their Books edit grants (manage,
 * accountant, settings — they keep viewing assigned clients' Books) and sets
 * `tools.documents.read/manage` to self scope.
 *
 * Runs once per role: the audit-log row it writes is the marker, so a later
 * deliberate grant in Settings → Roles & permissions is not undone by the
 * next deploy. The revoke and the marker commit together, on the caller's
 * client. Returns true when it changed anything.
 */
export const TOOLS_LOCKDOWN_ACTION = 'role_defaults.tools_lockdown'
const LOCKDOWN_ROLES: string[] = ['employee', 'intern']
const OWN_DOCUMENT_CODES = ['tools.documents.read', 'tools.documents.manage']

async function lockDownTools(prisma: PrismaClient, roleId: string): Promise<boolean> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lockSequence(tx, AUDIT_CHAIN_LOCK)
    const done = await tx.auditLog.findFirst({ where: { action: TOOLS_LOCKDOWN_ACTION, entityType: 'Role', entityId: roleId }, select: { id: true } })
    if (done) return false
    const books = await tx.rolePermission.deleteMany({ where: { roleId, permission: { code: { in: moduleCodes('books_edit') } } } })
    const docs = await tx.rolePermission.updateMany({
      where: { roleId, permission: { code: { in: OWN_DOCUMENT_CODES } }, scope: { not: 'self' } },
      data: { scope: 'self' },
    })
    const content: AuditHashInput = {
      actorUserId: null,
      action: TOOLS_LOCKDOWN_ACTION,
      entityType: 'Role',
      entityId: roleId,
      beforeJson: null,
      afterJson: stringifyJson({ books_edit_grants_removed: books.count, document_grants_limited_to_self: docs.count }),
      ip: null,
      createdAt: new Date(),
    }
    const last = await tx.auditLog.findFirst({ where: { hash: { not: null } }, orderBy: { seq: 'desc' }, select: { hash: true } })
    const prevHash = last?.hash ?? null
    await tx.auditLog.create({ data: { ...content, prevHash, hash: auditHash(prevHash, content) } })
    return books.count + docs.count > 0
  }, { maxWait: 15_000, timeout: 15_000 })
}

// `npm run setup:roles` — reset the five roles to their default access.
if (process.argv[1] && /setup-roles\.(ts|js)$/.test(process.argv[1])) {
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()
  setupRoles(prisma, { force: true })
    .catch((e) => { console.error(e); process.exitCode = 1 })
    .finally(() => prisma.$disconnect())
}
