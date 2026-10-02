import type { NextFunction, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { env } from '../lib/env.js'
import { ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import type { PermissionCode, RoleCode, Scope } from './rbac/matrix.js'
import { scopeSatisfies } from './rbac/matrix.js'

/**
 * AUTHENTICATION — step 1 of the shared pipeline:
 *   authenticate → authorize → validate → handle → audit
 *
 * The session is a JWT carried in an httpOnly, SameSite=Lax cookie. That is
 * what lets the React app keep using `fetch(path, { credentials: 'include' })`
 * with no token plumbing and no token sitting in localStorage where a script
 * injection could read it. A Bearer header is also accepted for non-browser
 * callers (the Socket.IO handshake uses it).
 */

export interface Session {
  userId: string
  email: string
  roleId: string
  roleCode: RoleCode
  roleName: string
  /** Grants resolved from the RolePermission rows, not from a hard-coded map. */
  grants: { permission: string; scope: Scope }[]
  employeeId: string | null
  departmentId: string | null
  employeeFullName: string | null
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: Session
    }
  }
}

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.jwtSecret, { expiresIn: env.sessionTtlSeconds })
}

export function sessionCookie(token: string): [string, string, Record<string, unknown>] {
  return [
    env.cookieName,
    token,
    {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: env.cookieSecure,
      maxAge: env.sessionTtlSeconds * 1000,
      path: '/',
    },
  ]
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10)
}

/**
 * Verify credentials. Returns null for a bad password, an unknown email, a
 * soft-deleted user OR an inactive one — the caller cannot tell which, which
 * is the point.
 */
export async function verifyCredentials(email: string, password: string) {
  const user = await prisma.user.findFirst({
    where: { email: email.trim().toLowerCase(), deletedAt: null },
  })
  if (!user || !user.isActive) return null
  return bcrypt.compareSync(password, user.passwordHash) ? user : null
}

export async function loadSession(userId: string): Promise<Session | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, isActive: true, deletedAt: null },
    include: {
      role: { include: { permissions: { include: { permission: true } } } },
      employee: true,
    },
  })
  if (!user) return null
  // A deactivated employee cannot act even if a cookie survives.
  if (user.employee && (user.employee.deletedAt || user.employee.status === 'inactive')) return null

  return {
    userId: user.id,
    email: user.email,
    roleId: user.roleId,
    roleCode: user.role.code as RoleCode,
    roleName: user.role.name,
    grants: user.role.permissions.map((rp) => ({
      permission: rp.permission.code,
      scope: rp.scope as Scope,
    })),
    employeeId: user.employeeId,
    departmentId: user.employee?.departmentId ?? null,
    employeeFullName: user.employee?.fullName ?? null,
  }
}

function tokenFrom(req: Request): string | null {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7)
  const cookie = (req.cookies as Record<string, string> | undefined)?.[env.cookieName]
  return cookie ?? null
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = tokenFrom(req)
    if (!token) throw ApiError.unauthorized()
    let payload: jwt.JwtPayload
    try {
      payload = jwt.verify(token, env.jwtSecret) as jwt.JwtPayload
    } catch {
      throw ApiError.unauthorized('Your session has expired. Sign in again.')
    }
    const session = await loadSession(String(payload.sub))
    if (!session) throw ApiError.unauthorized('This account is no longer active.')
    req.session = session
    next()
  } catch (err) {
    next(err)
  }
}

export function requireSession(req: Request): Session {
  if (!req.session) throw ApiError.unauthorized()
  return req.session
}

/** Does this session hold `permission` at (at least) `required` scope? */
export function can(session: Session, permission: PermissionCode, required: Scope = 'self'): boolean {
  return session.grants.some(
    (g) => g.permission === permission && scopeSatisfies(g.scope, required),
  )
}

/** Authorize step. 403 — never 404, never an empty 200. */
export function requirePermission(permission: PermissionCode, scope: Scope = 'self') {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const session = requireSession(req)
      if (!can(session, permission, scope)) throw ApiError.forbidden()
      next()
    } catch (err) {
      next(err)
    }
  }
}
