import { Router } from 'express'
import { z } from 'zod'
import { env } from '../lib/env.js'
import { ApiError, handler, ok } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { rateLimit } from '../lib/rateLimit.js'
import {
  authenticate, hashPassword, passwordMatches, requireSession, sessionCookie, signToken, verifyCredentials,
} from '../platform/auth.js'
import { writeAudit } from '../platform/audit.js'
import { passwordProblem } from '../platform/password.js'

/**
 * AUTH (§9)
 *   POST /api/auth/login   { email, password } → { user, role, employee }
 *   POST /api/auth/logout  204
 *   GET  /api/auth/me      current session
 *   POST /api/auth/change-password  { current_password, new_password }
 *
 * The response shape is exactly what src/platform/auth/AuthContext.tsx
 * already consumes, so switching VITE_MOCK_MODE off changes nothing in React.
 */
export const authRouter = Router()

const loginSchema = z.object({
  email: z.string().trim().min(1).email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
})

async function sessionPayload(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { role: { include: { permissions: { include: { permission: true } } } }, employee: true },
  })
  return {
    user: { id: user.id, email: user.email },
    // An Admin-issued password: the client must route to /set-password.
    must_change_password: user.mustChangePassword,
    role: { id: user.role.id, code: user.role.code, name: user.role.name },
    // The live grants, so the client's menus follow Settings → Roles.
    grants: user.role.permissions
      .filter((rp) => !rp.permission.deletedAt)
      .map((rp) => ({ permission: rp.permission.code, scope: rp.scope })),
    employee: user.employee
      ? {
          id: user.employee.id,
          full_name: user.employee.fullName,
          department_id: user.employee.departmentId,
          designation_id: user.employee.designationId,
          photo_url: user.employee.photoUrl,
          employee_code: user.employee.employeeCode,
        }
      : null,
  }
}

authRouter.post('/login', handler(async (req, res) => {
  // Throttle by IP: credential stuffing should not get unlimited attempts.
  if (!rateLimit(`login:${req.ip}`, 20, 60_000)) throw ApiError.tooMany()

  const parsed = loginSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    throw ApiError.badRequest('Email and password are required.', parsed.error.flatten().fieldErrors)
  }
  const user = await verifyCredentials(parsed.data.email, parsed.data.password)
  if (!user) {
    // One message for every failure mode — no account enumeration.
    await writeAudit({
      actorUserId: null,
      action: 'auth.login_failed',
      entityType: 'User',
      entityId: parsed.data.email.toLowerCase(),
      req,
    })
    throw new ApiError(401, 'invalid_credentials', 'Invalid email or password.')
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
  const [name, value, options] = sessionCookie(signToken(user.id, user.sessionVersion))
  res.cookie(name, value, options)
  // The Super Admin's sign-ins stay out of everyone's activity feeds.
  const role = await prisma.role.findUnique({ where: { id: user.roleId }, select: { code: true } })
  if (role?.code !== 'md') {
    await writeAudit({
      actorUserId: user.id, action: 'auth.login', entityType: 'User', entityId: user.id, req,
    })
  }
  ok(res, await sessionPayload(user.id))
}))

authRouter.post('/logout', authenticate, handler(async (req, res) => {
  const session = requireSession(req)
  // This browser must stop receiving the signed-out user's notifications.
  const pushEndpoint = typeof req.body?.push_endpoint === 'string' ? req.body.push_endpoint : null
  if (pushEndpoint) {
    await prisma.pushSubscription.deleteMany({ where: { endpoint: pushEndpoint, userId: session.userId } })
  }
  res.clearCookie(env.cookieName, { path: '/' })
  if (session.roleCode !== 'md') {
    await writeAudit({
      actorUserId: session.userId, action: 'auth.logout', entityType: 'User', entityId: session.userId, req,
    })
  }
  res.status(204).end()
}))

authRouter.get('/me', authenticate, handler(async (req, res) => {
  ok(res, await sessionPayload(requireSession(req).userId))
}))

const changeSchema = z.object({
  current_password: z.string().min(1, 'Enter your current password.'),
  new_password: z.string().min(1, 'Enter a new password.'),
})

// POST /api/auth/change-password — every user, including the forced first change.
authRouter.post('/change-password', authenticate, handler(async (req, res) => {
  const session = requireSession(req)
  if (!rateLimit(`pwchange:${session.userId}`, 10, 60_000)) throw ApiError.tooMany()
  const parsed = changeSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    throw ApiError.badRequest('Enter your current and new password.', parsed.error.flatten().fieldErrors)
  }
  const { current_password: current, new_password: next } = parsed.data
  const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } })
  if (!passwordMatches(user.passwordHash, current)) {
    const m = 'Your current password is incorrect.'
    throw ApiError.badRequest(m, { current_password: [m] })
  }
  const problem = passwordProblem(next)
  if (problem) throw ApiError.badRequest(problem, { new_password: [problem] })
  if (next === current) {
    const m = 'Choose a password different from your current one.'
    throw ApiError.badRequest(m, { new_password: [m] })
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: hashPassword(next), mustChangePassword: false,
      sessionVersion: { increment: 1 }, updatedBy: user.id,
    },
  })
  // This browser stays signed in; every other session ends with the old version.
  const [name, value, options] = sessionCookie(signToken(updated.id, updated.sessionVersion))
  res.cookie(name, value, options)
  await writeAudit({
    actorUserId: user.id, action: 'auth.password_changed', entityType: 'User', entityId: user.id, req,
  })
  ok(res, await sessionPayload(user.id))
}))
