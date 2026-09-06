import { Router } from 'express'
import { z } from 'zod'
import { env } from '../lib/env.js'
import { ApiError, handler, ok } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { rateLimit } from '../lib/rateLimit.js'
import { authenticate, requireSession, sessionCookie, signToken, verifyCredentials } from '../platform/auth.js'
import { writeAudit } from '../platform/audit.js'

/**
 * AUTH (§9)
 *   POST /api/auth/login   { email, password } → { user, role, employee }
 *   POST /api/auth/logout  204
 *   GET  /api/auth/me      current session
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
    include: { role: true, employee: true },
  })
  return {
    user: { id: user.id, email: user.email },
    role: { id: user.role.id, code: user.role.code, name: user.role.name },
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
  const [name, value, options] = sessionCookie(signToken(user.id))
  res.cookie(name, value, options)
  await writeAudit({
    actorUserId: user.id, action: 'auth.login', entityType: 'User', entityId: user.id, req,
  })
  ok(res, await sessionPayload(user.id))
}))

authRouter.post('/logout', authenticate, handler(async (req, res) => {
  const session = requireSession(req)
  res.clearCookie(env.cookieName, { path: '/' })
  await writeAudit({
    actorUserId: session.userId, action: 'auth.logout', entityType: 'User', entityId: session.userId, req,
  })
  res.status(204).end()
}))

authRouter.get('/me', authenticate, handler(async (req, res) => {
  ok(res, await sessionPayload(requireSession(req).userId))
}))
