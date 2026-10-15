/**
 * ROLE MODULES — the four modules Settings → Roles & permissions groups its
 * sections under (rbac/sections.ts). A module is "full" when every section in
 * it is at its top level, "none" when none is held. The fine-grained MATRIX
 * stays as the template the tests seed from; the live RolePermission rows are
 * written from section levels.
 */
import { ALL_PERMISSION_CODES, type PermissionCode, type RoleCode } from './matrix.js'
import { gatesFor, grantsAt, moduleOfCode, SECTIONS, topLevel, type Grant, type Level } from './sections.js'

export type ModuleCode = 'hrms' | 'workstation' | 'tools' | 'integrations'

export const MODULES: { code: ModuleCode; name: string }[] = [
  { code: 'hrms', name: 'HRMS' },
  { code: 'workstation', name: 'Workstation' },
  { code: 'tools', name: 'Tools' },
  { code: 'integrations', name: 'Integrations' },
]

export function moduleOf(code: string): ModuleCode {
  return moduleOfCode(code)
}

export function moduleCodes(module: ModuleCode): PermissionCode[] {
  return ALL_PERMISSION_CODES.filter((c) => moduleOf(c) === module)
}

/**
 * The five roles shown in Settings and offered on an employee, in order.
 * Default access: every section of `modules` in full, then `sections`
 * overrides (Associates see their assigned clients only).
 */
export const VISIBLE_ROLES: { id: string; code: RoleCode; name: string; description: string; modules: ModuleCode[]; sections?: Record<string, Level> }[] = [
  { id: 'role-md', code: 'md', name: 'Super Admin', description: 'Full access', modules: ['hrms', 'workstation', 'tools', 'integrations'] },
  { id: 'role-hr-admin', code: 'hr_admin', name: 'Admin', description: 'Full access', modules: ['hrms', 'workstation', 'tools', 'integrations'] },
  { id: 'role-dept-manager', code: 'dept_manager', name: 'Senior Associate', description: 'Full access', modules: ['hrms', 'workstation', 'tools', 'integrations'] },
  { id: 'role-employee', code: 'employee', name: 'Associate', description: 'Workstation and Tools', modules: ['workstation', 'tools'], sections: { 'workstation.client_visibility': 'none' } },
  { id: 'role-intern', code: 'intern', name: 'Intern', description: 'Workstation and Tools', modules: ['workstation', 'tools'], sections: { 'workstation.client_visibility': 'none' } },
]

/** A role's default grants: its section levels plus the gates they open. */
export function defaultGrants(role: (typeof VISIBLE_ROLES)[number]): Grant[] {
  const grants = SECTIONS.flatMap((s) => {
    const level = role.sections?.[s.code] ?? (role.modules.includes(s.module) ? topLevel(s) : 'none')
    return grantsAt(s, level)
  })
  const held = new Map(grants.map((g) => [g.code as string, g.scope as string]))
  return [...grants, ...gatesFor(held).map((code) => ({ code, scope: 'organisation' as const }))]
}

export const VISIBLE_ROLE_CODES: RoleCode[] = VISIBLE_ROLES.map((r) => r.code)
