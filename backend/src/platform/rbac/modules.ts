/**
 * ROLE MODULES — the access model Settings → Roles & permissions edits.
 *
 * Every permission code belongs to exactly one of six modules. A role either
 * holds a module in full (every code in it, at the scope `scopeFor` gives that
 * role) or not at all.
 * The fine-grained MATRIX stays as the template the tests seed from; the live
 * RolePermission rows are written from these module grants.
 */
import { ALL_PERMISSION_CODES, type PermissionCode, type RoleCode, type Scope } from './matrix.js'

export type ModuleCode = 'hrms' | 'workstation' | 'tools' | 'books' | 'books_edit' | 'integrations'

export const MODULES: { code: ModuleCode; name: string }[] = [
  { code: 'hrms', name: 'HRMS' },
  { code: 'workstation', name: 'Workstation' },
  { code: 'tools', name: 'Tools' },
  // Zoho Books writes reach a client's real books (delete, void, unlock a
  // filed period), so Books is split off Tools: viewing (the clients a person
  // is assigned to, unless they see every client) and editing.
  { code: 'books', name: 'Books — view' },
  { code: 'books_edit', name: 'Books — edit' },
  { code: 'integrations', name: 'Integrations' },
]

const BOOKS_VIEW_CODES: string[] = ['books.access', 'books.reports']

export function moduleOf(code: string): ModuleCode {
  if (code.startsWith('workstation.')) return 'workstation'
  // Only the listed read codes are "view"; any other Books code — including
  // one added later — is "edit", so a deploy's top-up never hands it to a
  // view-only role.
  if (code.startsWith('books.')) return BOOKS_VIEW_CODES.includes(code) ? 'books' : 'books_edit'
  if (code.startsWith('tools.')) return 'tools'
  if (code.startsWith('integrations.')) return 'integrations'
  return 'hrms'
}

export function moduleCodes(module: ModuleCode): PermissionCode[] {
  return ALL_PERMISSION_CODES.filter((c) => moduleOf(c) === module)
}

/** The five roles shown in Settings and offered on an employee, in order. */
export const VISIBLE_ROLES: { id: string; code: RoleCode; name: string; description: string; modules: ModuleCode[] }[] = [
  { id: 'role-md', code: 'md', name: 'Super Admin', description: 'Full access', modules: ['hrms', 'workstation', 'tools', 'books', 'books_edit', 'integrations'] },
  { id: 'role-hr-admin', code: 'hr_admin', name: 'Admin', description: 'Full access', modules: ['hrms', 'workstation', 'tools', 'books', 'books_edit', 'integrations'] },
  { id: 'role-dept-manager', code: 'dept_manager', name: 'Senior Associate', description: 'Full access', modules: ['hrms', 'workstation', 'tools', 'books', 'books_edit', 'integrations'] },
  { id: 'role-employee', code: 'employee', name: 'Associate', description: 'Workstation and Tools', modules: ['workstation', 'tools', 'books'] },
  { id: 'role-intern', code: 'intern', name: 'Intern', description: 'Workstation and Tools', modules: ['workstation', 'tools', 'books'] },
]

export const VISIBLE_ROLE_CODES: RoleCode[] = VISIBLE_ROLES.map((r) => r.code)

/**
 * Roles that hold Tools but see only their own converted documents and tool
 * jobs. Everyone else holding Tools sees the whole firm's.
 */
const OWN_DOCUMENTS_ONLY: RoleCode[] = ['employee', 'intern']
const OWN_DOCUMENT_CODES: string[] = ['tools.documents.read', 'tools.documents.manage']

/** The scope a module grant gives `permission` on `role`. */
export function scopeFor(role: string, permission: string): Scope {
  return OWN_DOCUMENTS_ONLY.includes(role as RoleCode) && OWN_DOCUMENT_CODES.includes(permission) ? 'self' : 'organisation'
}
