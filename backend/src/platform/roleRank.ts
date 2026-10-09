import { ApiError } from '../lib/http.js'
import type { Session } from './auth.js'

/**
 * Who may hand out which role, and whose login they may touch. One rule for
 * every path that assigns a role or changes a login (Settings → Users,
 * Employees create / role / password, Settings → Roles), so they cannot
 * drift apart:
 *
 *   - Super Admin ('md') is granted, changed or reset only by a Super Admin.
 *   - Admin and Super Admin manage every other login.
 *   - Anyone else with staff-management rights (e.g. a Senior Associate)
 *     only assigns or touches roles ranked BELOW their own.
 *
 * A login the caller may not touch answers 404, so the hidden Super Admin is
 * never confirmed to exist.
 */
const RANK: Record<string, number> = {
  md: 50,
  hr_admin: 40,
  finance_admin: 35, // legacy role, kept below Admin
  dept_manager: 30,
  employee: 20,
  intern: 10,
}

export const SUPER_ADMIN_ROLE = 'md'
const ACCOUNT_ADMIN_ROLES = new Set(['md', 'hr_admin'])

const rank = (code: string) => RANK[code] ?? 0

export function isSuperAdmin(session: Session): boolean {
  return session.roleCode === SUPER_ADMIN_ROLE
}

/** Admin or Super Admin. */
export function isAccountAdmin(session: Session): boolean {
  return ACCOUNT_ADMIN_ROLES.has(session.roleCode)
}

/** May this caller give someone the role `code`? */
export function canAssignRole(session: Session, code: string): boolean {
  if (code === SUPER_ADMIN_ROLE) return isSuperAdmin(session)
  if (isAccountAdmin(session)) return true
  return rank(code) < rank(session.roleCode)
}

/** May this caller change or reset a login that currently holds `code`? */
export function canManageLogin(session: Session, code: string): boolean {
  return canAssignRole(session, code)
}

/** May this caller see / edit the permissions of role `code` (Settings → Roles)? */
export function canEditRole(session: Session, code: string): boolean {
  if (code === SUPER_ADMIN_ROLE) return isSuperAdmin(session)
  if (isAccountAdmin(session)) return true
  return rank(code) < rank(session.roleCode)
}

export function assertCanAssignRole(session: Session, code: string): void {
  if (!canAssignRole(session, code)) {
    throw ApiError.badRequest('Choose a valid role.', { role_id: ['Choose a valid role.'] })
  }
}

export function assertCanManageLogin(session: Session, code: string): void {
  if (!canManageLogin(session, code)) throw ApiError.notFound('User not found.')
}
