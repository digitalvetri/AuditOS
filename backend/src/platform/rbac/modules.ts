/**
 * ROLE MODULES — the access model Settings → Roles & permissions edits.
 *
 * Every permission code belongs to exactly one of four modules. A role either
 * holds a module in full (every code in it, organisation scope) or not at all.
 * The fine-grained MATRIX stays as the template the tests seed from; the live
 * RolePermission rows are written from these module grants.
 */
import { ALL_PERMISSION_CODES, type PermissionCode, type RoleCode } from './matrix.js'

export type ModuleCode = 'hrms' | 'workstation' | 'tools' | 'integrations'

export const MODULES: { code: ModuleCode; name: string }[] = [
  { code: 'hrms', name: 'HRMS' },
  { code: 'workstation', name: 'Workstation' },
  { code: 'tools', name: 'Tools' },
  { code: 'integrations', name: 'Integrations' },
]

export function moduleOf(code: string): ModuleCode {
  if (code.startsWith('workstation.')) return 'workstation'
  if (code.startsWith('tools.') || code.startsWith('books.')) return 'tools'
  if (code.startsWith('integrations.')) return 'integrations'
  return 'hrms'
}

export function moduleCodes(module: ModuleCode): PermissionCode[] {
  return ALL_PERMISSION_CODES.filter((c) => moduleOf(c) === module)
}

/** The five roles shown in Settings and offered on an employee, in order. */
export const VISIBLE_ROLES: { id: string; code: RoleCode; name: string; description: string; modules: ModuleCode[] }[] = [
  { id: 'role-md', code: 'md', name: 'Super Admin', description: 'Full access', modules: ['hrms', 'workstation', 'tools', 'integrations'] },
  { id: 'role-hr-admin', code: 'hr_admin', name: 'Admin', description: 'Full access', modules: ['hrms', 'workstation', 'tools', 'integrations'] },
  { id: 'role-dept-manager', code: 'dept_manager', name: 'Senior Associate', description: 'Full access', modules: ['hrms', 'workstation', 'tools', 'integrations'] },
  { id: 'role-employee', code: 'employee', name: 'Associate', description: 'Workstation and Tools', modules: ['workstation', 'tools'] },
  { id: 'role-intern', code: 'intern', name: 'Intern', description: 'Workstation and Tools', modules: ['workstation', 'tools'] },
]

export const VISIBLE_ROLE_CODES: RoleCode[] = VISIBLE_ROLES.map((r) => r.code)
