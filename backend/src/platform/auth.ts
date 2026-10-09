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
  /** An Admin-issued password is still in use: only the change-password flow may run. */
  mustChangePassword: boolean
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: Session
    }
  }
}

/** `v` is the user's sessionVersion; bumping it ends every older session. */
export function signToken(userId: string, version = 0): string {
  return jwt.sign({ sub: userId, v: version }, env.jwtSecret, { expiresIn: env.sessionTtlSeconds })
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

/** Sync variants: seeds, tests and admin tools. Request paths use the async ones. */
export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10)
}

export function passwordMatches(hash: string, plain: string): boolean {
  return bcrypt.compareSync(plain, hash)
}

/** Off the event loop's critical path: bcrypt's async API yields between rounds. */
export function hashPasswordAsync(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10)
}

export function passwordMatchesAsync(hash: string, plain: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

/**
 * A real bcrypt hash of a random string, at the same cost as stored hashes.
 * Unknown emails and locked accounts are compared against it so every path
 * spends about the same time in bcrypt — response timing does not reveal
 * whether an account exists.
 */
const DUMMY_HASH = bcrypt.hashSync(`dummy-${Math.random().toString(36)}-${Date.now()}`, 10)

// ── Per-account lockout ────────────────────────────────────────────────────
/** Consecutive failures before the account locks. */
export const LOCKOUT_THRESHOLD = 5
const LOCK_BASE_MS = 60_000
const LOCK_MAX_MS = 30 * 60_000

/** 1 min at the threshold, doubling for each further failure, capped at 30 min. */
export function lockDurationMs(failures: number): number {
  if (failures < LOCKOUT_THRESHOLD) return 0
  return Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** (failures - LOCKOUT_THRESHOLD))
}

/**
 * Failures against emails with no account, kept in memory and on the same
 * schedule, so "locked" is not a tell that an account exists.
 */
const ghostFailures = new Map<string, { count: number; lockedUntil: number; at: number }>()
setInterval(() => {
  const cutoff = Date.now() - LOCK_MAX_MS * 2
  for (const [k, v] of ghostFailures) if (v.at < cutoff && v.lockedUntil < Date.now()) ghostFailures.delete(k)
}, 60_000).unref()

export type LoginAttempt =
  | { ok: true; user: NonNullable<Awaited<ReturnType<typeof findLoginUser>>> }
  | { ok: false; lockedForMs: number }

function findLoginUser(email: string) {
  return prisma.user.findFirst({ where: { email, deletedAt: null } })
}

/**
 * One sign-in attempt with the brute-force guard applied. While an account is
 * locked its password is not even checked. `lockedForMs > 0` means "locked,
 * try again in that long"; 0 means just "wrong credentials".
 */
export async function attemptLogin(rawEmail: string, password: string, now = Date.now()): Promise<LoginAttempt> {
  const email = rawEmail.trim().toLowerCase()
  const user = await findLoginUser(email)

  if (!user) {
    await passwordMatchesAsync(DUMMY_HASH, password)
    const g = ghostFailures.get(email) ?? { count: 0, lockedUntil: 0, at: now }
    if (g.lockedUntil > now) return { ok: false, lockedForMs: g.lockedUntil - now }
    if (ghostFailures.size > 50_000) ghostFailures.clear()
    g.count += 1
    g.at = now
    g.lockedUntil = now + lockDurationMs(g.count)
    ghostFailures.set(email, g)
    return { ok: false, lockedForMs: 0 }
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > now) {
    await passwordMatchesAsync(DUMMY_HASH, password)
    return { ok: false, lockedForMs: user.lockedUntil.getTime() - now }
  }

  const matches = await passwordMatchesAsync(user.passwordHash, password)
  if (matches && user.isActive) {
    if (user.failedLoginCount !== 0 || user.lockedUntil) {
      await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } })
    }
    return { ok: true, user }
  }

  // Atomic increment, so parallel guesses cannot each read the same count.
  const bumped = await prisma.user.update({
    where: { id: user.id }, data: { failedLoginCount: { increment: 1 } }, select: { failedLoginCount: true },
  })
  const lockMs = lockDurationMs(bumped.failedLoginCount)
  if (lockMs > 0) {
    await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: new Date(now + lockMs) } })
  }
  return { ok: false, lockedForMs: 0 }
}

/**
 * Verify credentials. Returns null for a bad password, an unknown email, a
 * soft-deleted user OR an inactive one — the caller cannot tell which, which
 * is the point. No lockout bookkeeping; sign-in uses `attemptLogin`.
 */
export async function verifyCredentials(email: string, password: string) {
  const user = await findLoginUser(email.trim().toLowerCase())
  if (!user) {
    await passwordMatchesAsync(DUMMY_HASH, password)
    return null
  }
  const matches = await passwordMatchesAsync(user.passwordHash, password)
  return matches && user.isActive ? user : null
}

export async function loadSession(userId: string, tokenVersion?: number): Promise<Session | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, isActive: true, deletedAt: null },
    include: {
      role: { include: { permissions: { include: { permission: true } } } },
      employee: true,
    },
  })
  if (!user) return null
  // A password change, admin reset or deactivation bumps sessionVersion:
  // tokens minted before it no longer resume a session.
  if (tokenVersion !== undefined && tokenVersion !== user.sessionVersion) return null
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
    mustChangePassword: user.mustChangePassword,
  }
}

function tokenFrom(req: Request): string | null {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7)
  const cookie = (req.cookies as Record<string, string> | undefined)?.[env.cookieName]
  return cookie ?? null
}

/**
 * The session this request carries, or null — never throws. For the one
 * public "am I signed in?" check, so a signed-out visitor is a 200, not a 401.
 */
export async function optionalSession(req: Request): Promise<Session | null> {
  const token = tokenFrom(req)
  if (!token) return null
  try {
    const payload = jwt.verify(token, env.jwtSecret) as jwt.JwtPayload
    return await loadSession(String(payload.sub), typeof payload.v === 'number' ? payload.v : 0)
  } catch {
    return null
  }
}

/** The only API calls allowed while an Admin-issued password is still in use. */
const PASSWORD_CHANGE_PATHS = new Set(['/api/auth/me', '/api/auth/logout', '/api/auth/change-password'])

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
    const version = typeof payload.v === 'number' ? payload.v : 0
    const session = await loadSession(String(payload.sub), version)
    if (!session) throw ApiError.unauthorized('Your session has ended. Sign in again.')
    if (session.mustChangePassword && !PASSWORD_CHANGE_PATHS.has(req.originalUrl.split('?')[0])) {
      throw new ApiError(403, 'password_change_required', 'Set a new password to continue.')
    }
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
