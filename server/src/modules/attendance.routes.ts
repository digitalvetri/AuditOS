import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { daysBetween, istToday } from '../lib/dates.js'
import { haversineMeters } from '../lib/geo.js'
import { rateLimit } from '../lib/rateLimit.js'
import { computeCheckInStatus, computeCheckOutStatus } from '../domain/attendanceStatus.js'
import { can, requireSession, type Session } from '../platform/auth.js'
import { writeAudit } from '../platform/audit.js'
import { notifyEmployee, notifyUser } from '../platform/notify.js'
import { attendanceToApi, correctionToApi, employeeRef, employeeRefWithDept, stripCoords } from '../api/serialize.js'
import type { Scope } from '../platform/rbac/matrix.js'

/**
 * ATTENDANCE (§8.2 / §9)
 *
 * Nothing the client sends about verification is trusted. The geofence is
 * evaluated here from the raw coordinates; a client-supplied `verified` flag
 * is ignored and audited as a forgery attempt.
 */
export const attendanceRouter = Router()

function viewScope(session: Session): Scope {
  if (can(session, 'attendance.manage', 'organisation')) return 'organisation'
  if (can(session, 'attendance.read', 'organisation')) return 'organisation'
  if (can(session, 'attendance.read', 'department')) return 'department'
  return 'self'
}

const geoSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  accuracy_m: z.number(),
  location_type: z.enum(['office', 'client_site', 'remote', 'field']).optional(),
  off_site_reason: z.string().optional(),
  verified: z.unknown().optional(),
})

async function verifyGeofence(lat: number, lon: number, accuracyM: number) {
  if (accuracyM > 100) {
    return { ok: false as const, reason: 'GPS accuracy is poor. Move to an open area and retry.' }
  }
  const locations = await prisma.workLocation.findMany({ where: { isActive: true, deletedAt: null } })
  for (const l of locations) {
    if (haversineMeters(lat, lon, l.latitude, l.longitude) <= l.radiusM) {
      return { ok: true as const, locationId: l.id, name: l.name }
    }
  }
  return { ok: false as const, reason: 'You are not within any office geofence.' }
}

async function requireOwnEmployee(session: Session) {
  if (!session.employeeId) {
    throw ApiError.unprocessable('no_employee', 'This account has no employee record.')
  }
  const emp = await prisma.employee.findUnique({ where: { id: session.employeeId } })
  if (!emp) throw ApiError.unprocessable('no_employee', 'This account has no employee record.')
  if (emp.deletedAt || emp.status === 'inactive') {
    throw new ApiError(403, 'inactive', 'This employee account is inactive.')
  }
  return emp
}

// ── POST /api/attendance/check-in ────────────────────────────────────────
attendanceRouter.post('/check-in', handler(async (req, res) => {
  const session = requireSession(req)
  const employee = await requireOwnEmployee(session)
  if (!rateLimit(`checkin:${session.userId}`, 10, 60_000)) throw ApiError.tooMany()

  const parsed = geoSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    throw ApiError.badRequest('latitude, longitude and accuracy_m are required numbers.')
  }
  const body = parsed.data

  // §8.2 — a client that claims to have verified itself is recorded, not believed.
  if (body.verified !== undefined) {
    await writeAudit({
      actorUserId: session.userId, action: 'attendance.client_forgery_attempt',
      entityType: 'Attendance', entityId: employee.id,
      after: { forged_field: 'verified', value: body.verified }, req,
    })
  }

  const locType = body.location_type ?? 'office'
  if ((locType === 'client_site' || locType === 'field') && !body.off_site_reason?.trim()) {
    throw ApiError.unprocessable('reason_required', 'Off-site check-in requires a reason.')
  }

  const today = istToday()
  const existing = await prisma.attendance.findUnique({
    where: { employeeId_date: { employeeId: employee.id, date: today } },
  })
  if (existing?.checkInAt) {
    throw ApiError.conflict('already_checked_in', 'You are already checked in today.', {
      check_in_at: existing.checkInAt.toISOString(),
    })
  }

  const geo = await verifyGeofence(body.latitude, body.longitude, body.accuracy_m)
  if (locType === 'office' && !geo.ok) {
    throw ApiError.unprocessable('geofence', geo.reason)
  }
  const locationId = geo.ok ? geo.locationId : null
  const locationName = geo.ok ? geo.name : null

  const now = new Date()
  const data = {
    employeeId: employee.id,
    date: today,
    checkInAt: now,
    checkOutAt: null,
    checkInLat: body.latitude,
    checkInLong: body.longitude,
    checkInAccuracyM: body.accuracy_m,
    checkOutLat: null,
    checkOutLong: null,
    checkOutAccuracyM: null,
    checkInLocationId: locationId,
    checkOutLocationId: null,
    locationType: locType,
    offSiteReason: body.off_site_reason?.trim() ?? null,
    workedMinutes: null,
    breakMinutes: null,
    status: computeCheckInStatus(now),
    source: 'web_geo',
    correctionStatus: 'none',
    updatedBy: session.userId,
  }
  const row = await prisma.attendance.upsert({
    where: { employeeId_date: { employeeId: employee.id, date: today } },
    update: data,
    create: { ...data, createdBy: session.userId },
  })

  await writeAudit({
    actorUserId: session.userId,
    action: locType === 'office' ? 'attendance.check_in' : 'attendance.check_in.off_site',
    entityType: 'Attendance', entityId: row.id,
    after: { date: row.date, check_in_at: row.checkInAt, location_type: locType, location_id: locationId }, req,
  })
  await notifyUser({
    userId: session.userId, type: 'attendance.checked_in', module: 'attendance',
    title: 'Checked in',
    body: locType === 'office'
      ? `${locationName ?? 'Office'} — location verified`
      : `Off-site (${locType}) — flagged for review`,
    entityType: 'Attendance', entityId: row.id, actionUrl: '/hrms/attendance',
  })

  ok(res, { attendance: attendanceToApi(row), location: { id: locationId, name: locationName } })
}))

// ── POST /api/attendance/check-out ───────────────────────────────────────
attendanceRouter.post('/check-out', handler(async (req, res) => {
  const session = requireSession(req)
  const employee = await requireOwnEmployee(session)
  if (!rateLimit(`checkout:${session.userId}`, 10, 60_000)) throw ApiError.tooMany()

  const parsed = geoSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    throw ApiError.badRequest('latitude, longitude and accuracy_m are required numbers.')
  }
  const body = parsed.data

  const today = istToday()
  const row = await prisma.attendance.findUnique({
    where: { employeeId_date: { employeeId: employee.id, date: today } },
  })
  if (!row?.checkInAt) throw ApiError.unprocessable('no_open_session', 'No open check-in for today.')
  if (row.checkOutAt) {
    throw ApiError.conflict('already_checked_out', 'You have already checked out today.', {
      check_out_at: row.checkOutAt.toISOString(),
    })
  }

  const now = new Date()
  const { status, workedMinutes, breakMinutes } = computeCheckOutStatus(row.checkInAt, now)
  const geo = await verifyGeofence(body.latitude, body.longitude, body.accuracy_m)

  const updated = await prisma.attendance.update({
    where: { id: row.id },
    data: {
      checkOutAt: now,
      checkOutLat: body.latitude,
      checkOutLong: body.longitude,
      checkOutAccuracyM: body.accuracy_m,
      checkOutLocationId: geo.ok ? geo.locationId : null,
      workedMinutes,
      breakMinutes,
      // A WFH day stays WFH; otherwise the computed status wins.
      status: row.status === 'wfh' ? 'wfh' : status,
      updatedBy: session.userId,
    },
  })

  await writeAudit({
    actorUserId: session.userId, action: 'attendance.check_out',
    entityType: 'Attendance', entityId: row.id,
    before: { check_out_at: null, worked_minutes: null },
    after: { check_out_at: now.toISOString(), worked_minutes: workedMinutes, status }, req,
  })
  ok(res, { attendance: attendanceToApi(updated) })
}))

// ── GET /api/attendance/today ────────────────────────────────────────────
attendanceRouter.get('/today', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = viewScope(session)
  const today = istToday()

  const mine = session.employeeId
    ? await prisma.attendance.findUnique({
        where: { employeeId_date: { employeeId: session.employeeId, date: today } },
      })
    : null

  let counts: Record<string, number> | null = null
  if (scope === 'organisation' || scope === 'department') {
    const eligible = await prisma.employee.findMany({
      where: {
        status: 'active', deletedAt: null,
        ...(scope === 'department' ? { departmentId: session.departmentId ?? '__none__' } : {}),
      },
      select: { id: true },
    })
    const ids = eligible.map((e) => e.id)
    const rows = await prisma.attendance.findMany({
      where: { date: today, employeeId: { in: ids }, deletedAt: null },
    })
    counts = {
      total: ids.length,
      present: rows.filter((r) => r.status === 'present').length,
      late: rows.filter((r) => r.status === 'late').length,
      absent: ids.length - rows.filter((r) => r.checkInAt).length,
      wfh: rows.filter((r) => r.status === 'wfh').length,
      on_leave: rows.filter((r) => r.status === 'on_leave').length,
      missing_check_in: rows.filter((r) => r.status === 'missing_check_in').length,
      missing_check_out: rows.filter((r) => r.status === 'missing_check_out').length,
    }
  }

  ok(res, { today: mine ? attendanceToApi(mine) : null, counts, scope })
}))

// ── Corrections ──────────────────────────────────────────────────────────
// Declared BEFORE the parametric list route so '/corrections' is not eaten.

attendanceRouter.post('/corrections', handler(async (req, res) => {
  const session = requireSession(req)
  const employee = await requireOwnEmployee(session)
  const b = z.object({
    date: z.string().min(1),
    requested_check_in_at: z.string().optional(),
    requested_check_out_at: z.string().optional(),
    reason: z.string().trim().min(1),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('date and reason are required.')
  const body = b.data
  if (!body.requested_check_in_at && !body.requested_check_out_at) {
    throw ApiError.badRequest('At least one requested time is required.')
  }

  const today = istToday()
  if (body.date > today) throw ApiError.unprocessable('future_date', 'Cannot correct a future date.')
  if (daysBetween(body.date, today) > 7) {
    throw ApiError.unprocessable('window_expired', 'Corrections are limited to the last 7 days.')
  }

  const attendance = await prisma.attendance.findUnique({
    where: { employeeId_date: { employeeId: employee.id, date: body.date } },
  })

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.attendanceCorrection.create({
      data: {
        attendanceId: attendance?.id ?? null,
        employeeId: employee.id,
        date: body.date,
        requestedCheckInAt: body.requested_check_in_at ? new Date(body.requested_check_in_at) : null,
        requestedCheckOutAt: body.requested_check_out_at ? new Date(body.requested_check_out_at) : null,
        reason: body.reason.trim(),
        createdBy: session.userId,
        updatedBy: session.userId,
      },
    })
    if (attendance) {
      await tx.attendance.update({ where: { id: attendance.id }, data: { correctionStatus: 'requested' } })
    }
    return created
  })

  await writeAudit({
    actorUserId: session.userId, action: 'attendance.correction.requested',
    entityType: 'AttendanceCorrection', entityId: row.id, after: correctionToApi(row), req,
  })
  if (employee.managerId) {
    await notifyEmployee(employee.managerId, {
      type: 'attendance.correction.pending', module: 'attendance',
      title: 'Attendance correction to review',
      body: `${employee.fullName} requested a correction for ${body.date}.`,
      entityType: 'AttendanceCorrection', entityId: row.id, actionUrl: '/hrms/attendance',
    })
  }
  ok(res, { correction: correctionToApi(row) })
}))

attendanceRouter.get('/corrections', handler(async (req, res) => {
  const session = requireSession(req)
  const status = typeof req.query.status === 'string' ? req.query.status : undefined
  const orgWide = can(session, 'attendance.correct.approve', 'organisation')
  const deptWide = can(session, 'attendance.correct.approve', 'department')

  const where: Record<string, unknown> = { deletedAt: null }
  if (orgWide) {
    // everything
  } else if (deptWide && session.departmentId) {
    const ids = await prisma.employee.findMany({
      where: { departmentId: session.departmentId }, select: { id: true },
    })
    where.employeeId = { in: ids.map((e) => e.id) }
  } else if (session.employeeId) {
    where.employeeId = session.employeeId
  } else {
    return ok(res, { items: [], count: 0 })
  }
  if (status) where.status = status

  const rows = await prisma.attendanceCorrection.findMany({
    where, include: { employee: true }, orderBy: { createdAt: 'desc' },
  })
  const items = rows.map((r) => ({ ...correctionToApi(r), employee: employeeRef(r.employee) }))
  ok(res, { items, count: items.length })
}))

async function loadCorrectionForReview(session: Session, id: string) {
  const orgWide = can(session, 'attendance.correct.approve', 'organisation')
  const deptWide = can(session, 'attendance.correct.approve', 'department')
  if (!orgWide && !deptWide) throw ApiError.forbidden()

  const corr = await prisma.attendanceCorrection.findUnique({
    where: { id }, include: { employee: true },
  })
  if (!corr) throw ApiError.notFound('Correction not found.')
  if (corr.status !== 'pending') {
    throw ApiError.conflict('already_reviewed', 'This correction has already been reviewed.')
  }
  if (!orgWide && corr.employee.departmentId !== session.departmentId) throw ApiError.forbidden()
  return corr
}

attendanceRouter.post('/corrections/:id/approve', handler(async (req, res) => {
  const session = requireSession(req)
  const corr = await loadCorrectionForReview(session, req.params.id)
  const now = new Date()

  const { fresh, before, after } = await prisma.$transaction(async (tx) => {
    const updated = await tx.attendanceCorrection.update({
      where: { id: corr.id },
      data: { status: 'approved', reviewedBy: session.userId, reviewedAt: now, updatedBy: session.userId },
    })

    const existing = await tx.attendance.findUnique({
      where: { employeeId_date: { employeeId: corr.employeeId, date: corr.date } },
    })
    const checkIn = corr.requestedCheckInAt ?? existing?.checkInAt ?? null
    const checkOut = corr.requestedCheckOutAt ?? existing?.checkOutAt ?? null

    let status = 'absent'
    let workedMinutes: number | null = null
    let breakMinutes: number | null = null
    if (checkIn && checkOut) {
      const computed = computeCheckOutStatus(checkIn, checkOut)
      status = existing?.status === 'wfh' ? 'wfh' : computed.status
      workedMinutes = computed.workedMinutes
      breakMinutes = computed.breakMinutes
    } else if (checkIn) {
      status = existing?.status === 'wfh' ? 'wfh' : computeCheckInStatus(checkIn)
    }

    const row = await tx.attendance.upsert({
      where: { employeeId_date: { employeeId: corr.employeeId, date: corr.date } },
      update: {
        checkInAt: checkIn, checkOutAt: checkOut, workedMinutes, breakMinutes,
        status, correctionStatus: 'approved', updatedBy: session.userId,
      },
      create: {
        employeeId: corr.employeeId, date: corr.date,
        checkInAt: checkIn, checkOutAt: checkOut, workedMinutes, breakMinutes,
        status, source: 'manual', correctionStatus: 'approved',
        createdBy: session.userId, updatedBy: session.userId,
      },
    })
    return {
      fresh: updated,
      before: existing ? attendanceToApi(existing) : null,
      after: attendanceToApi(row),
    }
  })

  await writeAudit({
    actorUserId: session.userId, action: 'attendance.correction.approved',
    entityType: 'AttendanceCorrection', entityId: corr.id, before, after, req,
  })
  await notifyEmployee(corr.employeeId, {
    type: 'attendance.correction.approved', module: 'attendance',
    title: 'Attendance correction approved',
    body: `Your correction for ${corr.date} was approved.`,
    entityType: 'AttendanceCorrection', entityId: corr.id, actionUrl: '/hrms/attendance',
  })
  ok(res, { correction: correctionToApi(fresh) })
}))

attendanceRouter.post('/corrections/:id/reject', handler(async (req, res) => {
  const session = requireSession(req)
  const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : ''
  if (!notes) throw ApiError.badRequest('A reason for rejection is required.')
  const corr = await loadCorrectionForReview(session, req.params.id)

  const fresh = await prisma.$transaction(async (tx) => {
    const updated = await tx.attendanceCorrection.update({
      where: { id: corr.id },
      data: {
        status: 'rejected', reviewedBy: session.userId, reviewedAt: new Date(),
        reviewNotes: notes, updatedBy: session.userId,
      },
    })
    if (corr.attendanceId) {
      await tx.attendance.update({ where: { id: corr.attendanceId }, data: { correctionStatus: 'rejected' } })
    }
    return updated
  })

  await writeAudit({
    actorUserId: session.userId, action: 'attendance.correction.rejected',
    entityType: 'AttendanceCorrection', entityId: corr.id, after: { notes }, req,
  })
  await notifyEmployee(corr.employeeId, {
    type: 'attendance.correction.rejected', module: 'attendance',
    title: 'Attendance correction rejected',
    body: `Your correction for ${corr.date} was rejected: ${notes}`,
    entityType: 'AttendanceCorrection', entityId: corr.id, actionUrl: '/hrms/attendance',
  })
  ok(res, { correction: correctionToApi(fresh) })
}))

// ── GET /api/attendance?from&to&employeeId&departmentId&status&locationType ──
attendanceRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = viewScope(session)
  const q = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    employeeId: z.string().optional(),
    departmentId: z.string().optional(),
    status: z.string().optional(),
    locationType: z.string().optional(),
  }).parse(req.query)

  const where: Record<string, unknown> = { deletedAt: null }
  const employeeWhere: Record<string, unknown> = {}
  if (scope === 'self') {
    if (!session.employeeId) return ok(res, { items: [], count: 0, scope })
    where.employeeId = session.employeeId
  } else if (scope === 'department') {
    employeeWhere.departmentId = session.departmentId ?? '__none__'
  }

  if (q.employeeId) {
    const target = await prisma.employee.findUnique({ where: { id: q.employeeId } })
    if (!target) throw ApiError.forbidden()
    if (scope === 'self' && target.id !== session.employeeId) throw ApiError.forbidden()
    if (scope === 'department' && target.departmentId !== session.departmentId) throw ApiError.forbidden()
    where.employeeId = q.employeeId
  }
  if (q.departmentId) employeeWhere.departmentId = q.departmentId
  if (Object.keys(employeeWhere).length) where.employee = employeeWhere
  if (q.from || q.to) {
    where.date = { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) }
  }
  if (q.status) where.status = q.status
  if (q.locationType) where.locationType = q.locationType

  const rows = await prisma.attendance.findMany({
    where, include: { employee: true }, orderBy: [{ date: 'desc' }, { employeeId: 'asc' }], take: 2000,
  })

  const items = rows.map((r) => {
    const base = attendanceToApi(r)
    // Peers at department scope never see another person's coordinates.
    const projected = scope === 'department' && r.employeeId !== session.employeeId ? stripCoords(base) : base
    return { ...projected, employee: employeeRefWithDept(r.employee) }
  })
  ok(res, { items, count: items.length, scope })
}))
