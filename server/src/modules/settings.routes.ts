import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { addDays } from '../lib/dates.js'
import { can, requireSession, type Session } from '../platform/auth.js'
import { writeAudit } from '../platform/audit.js'
import type { Scope } from '../platform/rbac/matrix.js'
import {
  departmentToApi, designationToApi, expenseCategoryToApi, holidayToApi,
  leaveTypeToApi, permissionToApi, roleToApi, statutoryRateToApi,
  workLocationToApi, workScheduleToApi,
} from '../api/serialize.js'

/**
 * SETTINGS (§8.11). Part 1 owns every configuration table.
 *
 * Reads that other modules depend on (work schedules, departments,
 * designations, leave types, expense categories) are open to any signed-in
 * caller — the Leave form and the Employees filter need them. Every WRITE,
 * and the statutory-rate and role reads, require `settings.manage` at
 * organisation scope.
 *
 * Statutory rates are append-only with effective dating: posting a new row
 * caps the previous one at the day before it starts, so history stays intact
 * and a processed payroll run's snapshot still resolves.
 */
export const settingsRouter = Router()

function requireManage(session: Session) {
  if (!can(session, 'settings.manage', 'organisation')) throw ApiError.forbidden()
}

async function orgId(): Promise<string> {
  const org = await prisma.organisation.findFirstOrThrow({ where: { deletedAt: null } })
  return org.id
}

// ── Work schedules ────────────────────────────────────────────────────────
settingsRouter.get('/work-schedules/mine', handler(async (req, res) => {
  const session = requireSession(req)
  if (!session.employeeId) throw ApiError.unprocessable('no_employee', 'No employee record for this account.')
  const employee = await prisma.employee.findUniqueOrThrow({
    where: { id: session.employeeId }, include: { workSchedule: true },
  })
  ok(res, { schedule: workScheduleToApi(employee.workSchedule) })
}))

settingsRouter.get('/work-schedules', handler(async (_req, res) => {
  const rows = await prisma.workSchedule.findMany({ where: { deletedAt: null } })
  ok(res, { items: rows.map(workScheduleToApi) })
}))

// ── Departments ───────────────────────────────────────────────────────────
settingsRouter.get('/departments', handler(async (_req, res) => {
  const rows = await prisma.department.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } })
  ok(res, { items: rows.map(departmentToApi) })
}))

settingsRouter.post('/departments', handler(async (req, res) => {
  const session = requireSession(req)
  requireManage(session)
  const b = z.object({ name: z.string().trim().min(1), code: z.string().trim().min(1) })
    .safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('name and code are required.')
  const existing = await prisma.department.findFirst({
    where: { code: b.data.code.toUpperCase(), deletedAt: null },
  })
  if (existing) throw ApiError.conflict('duplicate', 'A department with this code already exists.')

  const row = await prisma.department.create({
    data: {
      organisationId: await orgId(),
      name: b.data.name.trim(),
      code: b.data.code.trim().toUpperCase(),
      createdBy: session.userId,
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'department.created',
    entityType: 'Department', entityId: row.id, after: departmentToApi(row), req,
  })
  ok(res, { department: departmentToApi(row) })
}))

settingsRouter.patch('/departments/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireManage(session)
  const before = await prisma.department.findUnique({ where: { id: req.params.id } })
  if (!before || before.deletedAt) throw ApiError.notFound('Department not found.')
  const b = z.object({ name: z.string().trim().optional(), code: z.string().trim().optional() })
    .parse(req.body ?? {})

  const row = await prisma.department.update({
    where: { id: before.id },
    data: {
      ...(b.name ? { name: b.name } : {}),
      ...(b.code ? { code: b.code.toUpperCase() } : {}),
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'department.updated', entityType: 'Department', entityId: row.id,
    before: departmentToApi(before), after: departmentToApi(row), req,
  })
  ok(res, { department: departmentToApi(row) })
}))

settingsRouter.delete('/departments/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireManage(session)
  const target = await prisma.department.findUnique({ where: { id: req.params.id } })
  if (!target || target.deletedAt) throw ApiError.notFound('Department not found.')
  const inUse = await prisma.employee.count({ where: { departmentId: target.id, deletedAt: null } })
  if (inUse > 0) throw ApiError.conflict('in_use', 'Department has employees; reassign first.')

  // `code` is unique, so a tombstoned row would hold its code forever and the
  // same code could never be created again. Release it on delete; the audit
  // entry keeps the original value.
  await prisma.department.update({
    where: { id: target.id },
    data: {
      deletedAt: new Date(),
      code: `${target.code}-deleted-${Date.now().toString(36)}`,
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'department.deleted',
    entityType: 'Department', entityId: target.id, before: departmentToApi(target), req,
  })
  ok(res, { ok: true })
}))

// ── Designations ──────────────────────────────────────────────────────────
settingsRouter.get('/designations', handler(async (_req, res) => {
  const rows = await prisma.designation.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } })
  ok(res, { items: rows.map(designationToApi) })
}))

settingsRouter.post('/designations', handler(async (req, res) => {
  const session = requireSession(req)
  requireManage(session)
  const b = z.object({ name: z.string().trim().min(1) }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('name is required.')
  const row = await prisma.designation.create({
    data: {
      organisationId: await orgId(), name: b.data.name,
      createdBy: session.userId, updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'designation.created',
    entityType: 'Designation', entityId: row.id, after: designationToApi(row), req,
  })
  ok(res, { designation: designationToApi(row) })
}))

settingsRouter.patch('/designations/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireManage(session)
  const before = await prisma.designation.findUnique({ where: { id: req.params.id } })
  if (!before || before.deletedAt) throw ApiError.notFound('Designation not found.')
  const b = z.object({ name: z.string().trim().optional() }).parse(req.body ?? {})
  const row = await prisma.designation.update({
    where: { id: before.id },
    data: { ...(b.name ? { name: b.name } : {}), updatedBy: session.userId },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'designation.updated', entityType: 'Designation', entityId: row.id,
    before: designationToApi(before), after: designationToApi(row), req,
  })
  ok(res, { designation: designationToApi(row) })
}))

settingsRouter.delete('/designations/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireManage(session)
  const target = await prisma.designation.findUnique({ where: { id: req.params.id } })
  if (!target || target.deletedAt) throw ApiError.notFound('Designation not found.')
  const inUse = await prisma.employee.count({ where: { designationId: target.id, deletedAt: null } })
  if (inUse > 0) throw ApiError.conflict('in_use', 'Designation is in use.')
  await prisma.designation.update({
    where: { id: target.id }, data: { deletedAt: new Date(), updatedBy: session.userId },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'designation.deleted',
    entityType: 'Designation', entityId: target.id, before: designationToApi(target), req,
  })
  ok(res, { ok: true })
}))

// ── Work locations ────────────────────────────────────────────────────────
settingsRouter.get('/work-locations', handler(async (_req, res) => {
  const rows = await prisma.workLocation.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } })
  ok(res, { items: rows.map(workLocationToApi) })
}))

settingsRouter.post('/work-locations', handler(async (req, res) => {
  const session = requireSession(req)
  requireManage(session)
  const b = z.object({
    name: z.string().trim().min(1),
    address: z.string().optional(),
    latitude: z.number(),
    longitude: z.number(),
    radius_m: z.number().int().positive().optional(),
    is_active: z.boolean().optional(),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('name, latitude, longitude are required.')

  const row = await prisma.workLocation.create({
    data: {
      organisationId: await orgId(),
      name: b.data.name,
      address: b.data.address ?? '',
      latitude: b.data.latitude,
      longitude: b.data.longitude,
      radiusM: b.data.radius_m ?? 150,
      isActive: b.data.is_active ?? true,
      createdBy: session.userId,
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'work_location.created',
    entityType: 'WorkLocation', entityId: row.id, after: workLocationToApi(row), req,
  })
  ok(res, { workLocation: workLocationToApi(row) })
}))

settingsRouter.patch('/work-locations/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireManage(session)
  const before = await prisma.workLocation.findUnique({ where: { id: req.params.id } })
  if (!before || before.deletedAt) throw ApiError.notFound('Work location not found.')
  const b = z.object({
    name: z.string().trim().optional(),
    address: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    radius_m: z.number().int().positive().optional(),
    is_active: z.boolean().optional(),
  }).parse(req.body ?? {})

  const row = await prisma.workLocation.update({
    where: { id: before.id },
    data: {
      ...(b.name ? { name: b.name } : {}),
      ...(b.address !== undefined ? { address: b.address } : {}),
      ...(b.latitude !== undefined ? { latitude: b.latitude } : {}),
      ...(b.longitude !== undefined ? { longitude: b.longitude } : {}),
      ...(b.radius_m !== undefined ? { radiusM: b.radius_m } : {}),
      ...(b.is_active !== undefined ? { isActive: b.is_active } : {}),
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'work_location.updated', entityType: 'WorkLocation', entityId: row.id,
    before: workLocationToApi(before), after: workLocationToApi(row), req,
  })
  ok(res, { workLocation: workLocationToApi(row) })
}))

// ── Holidays ──────────────────────────────────────────────────────────────
settingsRouter.get('/holidays', handler(async (_req, res) => {
  const rows = await prisma.holiday.findMany({ where: { deletedAt: null }, orderBy: { date: 'asc' } })
  ok(res, { items: rows.map(holidayToApi) })
}))

settingsRouter.post('/holidays', handler(async (req, res) => {
  const session = requireSession(req)
  requireManage(session)
  const b = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    name: z.string().trim().min(1),
    is_optional: z.boolean().optional(),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('date and name are required.')

  const clash = await prisma.holiday.findFirst({ where: { date: b.data.date, deletedAt: null } })
  if (clash) throw ApiError.conflict('duplicate', 'A holiday already exists on this date.')

  const row = await prisma.holiday.create({
    data: {
      organisationId: await orgId(),
      date: b.data.date,
      name: b.data.name,
      isOptional: b.data.is_optional ?? false,
      createdBy: session.userId,
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'holiday.created',
    entityType: 'Holiday', entityId: row.id, after: holidayToApi(row), req,
  })
  ok(res, { holiday: holidayToApi(row) })
}))

settingsRouter.delete('/holidays/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireManage(session)
  const target = await prisma.holiday.findUnique({ where: { id: req.params.id } })
  if (!target || target.deletedAt) throw ApiError.notFound('Holiday not found.')
  await prisma.holiday.update({
    where: { id: target.id }, data: { deletedAt: new Date(), updatedBy: session.userId },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'holiday.deleted',
    entityType: 'Holiday', entityId: target.id, before: holidayToApi(target), req,
  })
  ok(res, { ok: true })
}))

// ── Leave types (read + patch; never deleted — history references them) ──
settingsRouter.get('/leave-types', handler(async (_req, res) => {
  const rows = await prisma.leaveType.findMany({ where: { deletedAt: null }, orderBy: { code: 'asc' } })
  ok(res, { items: rows.map(leaveTypeToApi) })
}))

settingsRouter.patch('/leave-types/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireManage(session)
  const before = await prisma.leaveType.findUnique({ where: { id: req.params.id } })
  if (!before || before.deletedAt) throw ApiError.notFound('Leave type not found.')
  const b = z.object({
    name: z.string().trim().optional(),
    annual_entitlement: z.number().nullable().optional(),
    carry_forward_max: z.number().optional(),
    half_day_allowed: z.boolean().optional(),
    min_notice_days: z.number().int().min(0).optional(),
    accrue_during_probation: z.boolean().optional(),
  }).parse(req.body ?? {})

  const row = await prisma.leaveType.update({
    where: { id: before.id },
    data: {
      ...(b.name ? { name: b.name } : {}),
      ...(b.annual_entitlement !== undefined ? { annualEntitlement: b.annual_entitlement } : {}),
      ...(b.carry_forward_max !== undefined ? { carryForwardMax: b.carry_forward_max } : {}),
      ...(b.half_day_allowed !== undefined ? { halfDayAllowed: b.half_day_allowed } : {}),
      ...(b.min_notice_days !== undefined ? { minNoticeDays: b.min_notice_days } : {}),
      ...(b.accrue_during_probation !== undefined ? { accrueDuringProbation: b.accrue_during_probation } : {}),
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'leave_type.updated', entityType: 'LeaveType', entityId: row.id,
    before: leaveTypeToApi(before), after: leaveTypeToApi(row), req,
  })
  ok(res, { leaveType: leaveTypeToApi(row) })
}))

// ── Expense categories ────────────────────────────────────────────────────
settingsRouter.get('/expense-categories', handler(async (_req, res) => {
  const rows = await prisma.expenseCategory.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } })
  ok(res, { items: rows.map(expenseCategoryToApi) })
}))

settingsRouter.post('/expense-categories', handler(async (req, res) => {
  const session = requireSession(req)
  requireManage(session)
  const b = z.object({
    name: z.string().trim().min(1),
    code: z.string().trim().min(1),
    is_active: z.boolean().optional(),
    requires_receipt: z.boolean().optional(),
    gl_account: z.string().nullable().optional(),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('name and code required.')

  const clash = await prisma.expenseCategory.findFirst({
    where: { code: b.data.code.toUpperCase(), deletedAt: null },
  })
  if (clash) throw ApiError.conflict('duplicate', 'A category with this code already exists.')

  const row = await prisma.expenseCategory.create({
    data: {
      organisationId: await orgId(),
      name: b.data.name,
      code: b.data.code.toUpperCase(),
      isActive: b.data.is_active ?? true,
      requiresReceipt: b.data.requires_receipt ?? true,
      glAccount: b.data.gl_account ?? null,
      createdBy: session.userId,
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'expense_category.created',
    entityType: 'ExpenseCategory', entityId: row.id, after: expenseCategoryToApi(row), req,
  })
  ok(res, { category: expenseCategoryToApi(row) })
}))

settingsRouter.patch('/expense-categories/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireManage(session)
  const before = await prisma.expenseCategory.findUnique({ where: { id: req.params.id } })
  if (!before || before.deletedAt) throw ApiError.notFound('Category not found.')
  const b = z.object({
    name: z.string().trim().optional(),
    code: z.string().trim().optional(),
    is_active: z.boolean().optional(),
    requires_receipt: z.boolean().optional(),
    gl_account: z.string().nullable().optional(),
  }).parse(req.body ?? {})

  const row = await prisma.expenseCategory.update({
    where: { id: before.id },
    data: {
      ...(b.name ? { name: b.name } : {}),
      ...(b.code ? { code: b.code.toUpperCase() } : {}),
      ...(b.is_active !== undefined ? { isActive: b.is_active } : {}),
      ...(b.requires_receipt !== undefined ? { requiresReceipt: b.requires_receipt } : {}),
      ...(b.gl_account !== undefined ? { glAccount: b.gl_account } : {}),
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'expense_category.updated',
    entityType: 'ExpenseCategory', entityId: row.id,
    before: expenseCategoryToApi(before), after: expenseCategoryToApi(row), req,
  })
  ok(res, { category: expenseCategoryToApi(row) })
}))

// ── Statutory rates (append-only, effective-dated) ───────────────────────
settingsRouter.get('/statutory-rates', handler(async (req, res) => {
  const session = requireSession(req)
  requireManage(session)
  const code = typeof req.query.code === 'string' ? req.query.code : undefined
  const rows = await prisma.statutoryRate.findMany({
    where: { deletedAt: null, ...(code ? { code } : {}) },
    orderBy: [{ code: 'asc' }, { effectiveFrom: 'desc' }],
  })
  ok(res, { items: rows.map(statutoryRateToApi) })
}))

settingsRouter.post('/statutory-rates', handler(async (req, res) => {
  const session = requireSession(req)
  requireManage(session)
  const b = z.object({
    code: z.string().trim().min(1),
    value: z.string(),
    effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    effective_to: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('code, value (string), effective_from required.')
  const { code, value, effective_from } = b.data

  const row = await prisma.$transaction(async (tx) => {
    // Cap the currently-effective row at the day before the new one starts.
    const superseded = await tx.statutoryRate.findMany({
      where: { code, effectiveTo: null, deletedAt: null, effectiveFrom: { lt: effective_from } },
    })
    for (const s of superseded) {
      await tx.statutoryRate.update({
        where: { id: s.id },
        data: { effectiveTo: addDays(effective_from, -1), updatedBy: session.userId },
      })
    }
    return tx.statutoryRate.create({
      data: {
        organisationId: await orgId(),
        code,
        value,
        effectiveFrom: effective_from,
        effectiveTo: b.data.effective_to ?? null,
        notes: b.data.notes ?? null,
        createdBy: session.userId,
        updatedBy: session.userId,
      },
    })
  })

  await writeAudit({
    actorUserId: session.userId, action: 'statutory_rate.superseded',
    entityType: 'StatutoryRate', entityId: row.id, after: statutoryRateToApi(row), req,
  })
  ok(res, { rate: statutoryRateToApi(row) })
}))

// ── Roles + permission matrix ────────────────────────────────────────────
// The matrix is derived from RolePermission rows, not from the hard-coded
// MATRIX constant, so what a caller reads here is what `can()` enforces on
// the next request. MATRIX is only the seed source for these rows.

const SCOPES = ['self', 'department', 'organisation'] as const
const scopeSchema = z.enum(SCOPES)

async function loadMatrixFromDb(): Promise<Record<string, { permission: string; scope: Scope }[]>> {
  const grants = await prisma.rolePermission.findMany({
    include: { role: true, permission: true },
  })
  const matrix: Record<string, { permission: string; scope: Scope }[]> = {}
  for (const g of grants) {
    if (g.role.deletedAt || g.permission.deletedAt) continue
    const list = matrix[g.role.code] ?? []
    list.push({ permission: g.permission.code, scope: g.scope as Scope })
    matrix[g.role.code] = list
  }
  for (const code of Object.keys(matrix)) {
    matrix[code].sort((a, b) => a.permission.localeCompare(b.permission))
  }
  return matrix
}

settingsRouter.get('/roles', handler(async (req, res) => {
  const session = requireSession(req)
  requireManage(session)
  const [roles, permissions, matrix] = await Promise.all([
    prisma.role.findMany({ where: { deletedAt: null }, orderBy: { code: 'asc' } }),
    prisma.permission.findMany({ where: { deletedAt: null }, orderBy: { code: 'asc' } }),
    loadMatrixFromDb(),
  ])
  ok(res, {
    roles: roles.map(roleToApi),
    permissions: permissions.map(permissionToApi),
    matrix,
  })
}))

/**
 * Grant or revoke a single (role, permission) pair. A missing row means the
 * role does not hold the permission; `scope: null` in the body means "remove
 * the row." Any other body sets or upserts the scope.
 *
 * Lockout guards, both non-negotiable:
 *   - The caller cannot remove `settings.manage` from their own role — one
 *     click would strip their ability to undo the click.
 *   - The last role holding `settings.manage` cannot lose it — the firm must
 *     always have someone who can reach Settings.
 */
settingsRouter.put('/roles/:roleId/permissions/:permissionCode', handler(async (req, res) => {
  const session = requireSession(req)
  requireManage(session)

  const body = z.object({ scope: scopeSchema.nullable() }).safeParse(req.body ?? {})
  if (!body.success) {
    throw ApiError.badRequest('scope must be self, department, organisation, or null.')
  }
  const nextScope = body.data.scope

  const [role, permission] = await Promise.all([
    prisma.role.findUnique({ where: { id: req.params.roleId } }),
    prisma.permission.findUnique({ where: { code: req.params.permissionCode } }),
  ])
  if (!role || role.deletedAt) throw ApiError.notFound('Role not found.')
  if (!permission || permission.deletedAt) throw ApiError.notFound('Permission not found.')

  const before = await prisma.rolePermission.findUnique({
    where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
  })

  const isRevoke = nextScope === null
  if (isRevoke && permission.code === 'settings.manage') {
    if (role.id === session.roleId) {
      throw ApiError.conflict(
        'self_lockout',
        'You cannot remove settings.manage from your own role.',
      )
    }
    const otherHolders = await prisma.rolePermission.count({
      where: {
        permissionId: permission.id,
        roleId: { not: role.id },
        role: { deletedAt: null },
      },
    })
    if (otherHolders === 0) {
      throw ApiError.conflict(
        'last_admin',
        'At least one role must keep settings.manage.',
      )
    }
  }

  let after: { permission: string; scope: Scope } | null
  if (isRevoke) {
    if (before) {
      await prisma.rolePermission.delete({ where: { id: before.id } })
    }
    after = null
  } else {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      update: { scope: nextScope },
      create: { roleId: role.id, permissionId: permission.id, scope: nextScope },
    })
    after = { permission: permission.code, scope: nextScope }
  }

  await writeAudit({
    actorUserId: session.userId,
    action: isRevoke ? 'role_permission.revoked' : 'role_permission.granted',
    entityType: 'RolePermission',
    entityId: `${role.id}:${permission.id}`,
    before: before ? { permission: permission.code, scope: before.scope as Scope } : null,
    after,
    req,
  })

  ok(res, {
    role: roleToApi(role),
    grant: after,
  })
}))
