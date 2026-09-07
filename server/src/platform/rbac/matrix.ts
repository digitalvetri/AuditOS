/**
 * PERMISSION MATRIX — the canonical, server-side source (§5).
 *
 * The React client carries an identical copy at src/platform/rbac/matrix.ts,
 * but that copy exists only to decide what to render. This file is the
 * security control: it is what `requirePermission` checks and what the seed
 * writes into the Role / Permission / RolePermission tables.
 *
 * Permission code convention: `<module>.<action>[.<qualifier>]`, paired with a
 * scope (self | department | organisation) at the call site.
 */

export type RoleCode = 'employee' | 'dept_manager' | 'hr_admin' | 'finance_admin' | 'md'
export type Scope = 'self' | 'department' | 'organisation'

export type PermissionCode =
  | 'profile.read' | 'profile.write.contact' | 'profile.write.employment'
  | 'employee.read' | 'employee.read.restricted' | 'employee.manage'
  | 'attendance.read' | 'attendance.check_in' | 'attendance.correct.request'
  | 'attendance.correct.approve' | 'attendance.manage'
  | 'leave.read' | 'leave.request' | 'leave.approve' | 'leave.manage'
  | 'payroll.view' | 'payroll.view.own' | 'payroll.run' | 'payroll.review'
  | 'payroll.approve' | 'payroll.process' | 'salary.manage'
  | 'expense.submit' | 'expense.approve' | 'expense.pay' | 'expense.manage'
  | 'accounts.read' | 'accounts.manage' | 'payments.manage'
  | 'document.read' | 'document.manage'
  | 'chat.participate' | 'chat.manage'
  | 'reports.hr' | 'reports.finance' | 'reports.all'
  | 'audit.read.hr' | 'audit.read.finance' | 'audit.read.all'
  | 'settings.manage'
  // ── Workstation (AUDIT_OS_WORKSTATION.md §6) ─────────────────────────
  // Namespaced: `workstation.document.read` is CLIENT documents, never
  // EmployeeDocument. No Workstation code collides with an HRMS code.
  | 'workstation.access'
  | 'workstation.lead.read'
  | 'workstation.lead.manage'
  | 'workstation.lead.convert'
  | 'workstation.client.read'
  | 'workstation.client.manage'
  | 'workstation.service.read'
  | 'workstation.service.manage'
  | 'workstation.followup.read'
  | 'workstation.followup.manage'
  | 'workstation.document.read'
  | 'workstation.document.manage'
  | 'workstation.document.verify'
  | 'workstation.gst.read'
  | 'workstation.gst.manage'
  | 'workstation.eway.read'
  | 'workstation.eway.generate'
  | 'workstation.eway.cancel'

export interface Grant {
  permission: PermissionCode
  scope: Scope
}

export const MATRIX: Record<RoleCode, Grant[]> = {
  employee: [
    { permission: 'profile.read', scope: 'self' },
    { permission: 'profile.write.contact', scope: 'self' },
    { permission: 'employee.read', scope: 'self' },
    { permission: 'attendance.read', scope: 'self' },
    { permission: 'attendance.check_in', scope: 'self' },
    { permission: 'attendance.correct.request', scope: 'self' },
    { permission: 'leave.read', scope: 'self' },
    { permission: 'leave.request', scope: 'self' },
    { permission: 'payroll.view.own', scope: 'self' },
    { permission: 'expense.submit', scope: 'self' },
    { permission: 'document.read', scope: 'self' },
    { permission: 'chat.participate', scope: 'organisation' },
    { permission: 'reports.hr', scope: 'self' },
    // Workstation: assignment-scoped. `self` here means "rows assigned
    // to me" — resolved by assignedClientIds(), never a post-fetch filter.
    { permission: 'workstation.access', scope: 'self' },
    { permission: 'workstation.lead.read', scope: 'self' },
    { permission: 'workstation.lead.manage', scope: 'self' },
    { permission: 'workstation.client.read', scope: 'self' },
    { permission: 'workstation.service.read', scope: 'self' },
    { permission: 'workstation.service.manage', scope: 'self' },
    { permission: 'workstation.followup.read', scope: 'self' },
    { permission: 'workstation.followup.manage', scope: 'self' },
    { permission: 'workstation.document.read', scope: 'self' },
    { permission: 'workstation.document.manage', scope: 'self' },
    { permission: 'workstation.gst.read', scope: 'self' },
    { permission: 'workstation.gst.manage', scope: 'self' },
    { permission: 'workstation.eway.read', scope: 'self' },
    { permission: 'workstation.eway.generate', scope: 'self' },
  ],
  dept_manager: [
    { permission: 'profile.read', scope: 'self' },
    { permission: 'profile.write.contact', scope: 'self' },
    { permission: 'employee.read', scope: 'department' },
    { permission: 'attendance.read', scope: 'department' },
    { permission: 'attendance.check_in', scope: 'self' },
    { permission: 'attendance.correct.request', scope: 'self' },
    { permission: 'attendance.correct.approve', scope: 'department' },
    { permission: 'leave.read', scope: 'department' },
    { permission: 'leave.request', scope: 'self' },
    { permission: 'leave.approve', scope: 'department' },
    { permission: 'payroll.view.own', scope: 'self' },
    { permission: 'expense.submit', scope: 'self' },
    { permission: 'expense.approve', scope: 'department' },
    { permission: 'document.read', scope: 'department' },
    { permission: 'chat.participate', scope: 'organisation' },
    { permission: 'reports.hr', scope: 'department' },
    // Workstation: full operational access (§14 Operations Manager / MD).
    { permission: 'workstation.access', scope: 'organisation' },
    { permission: 'workstation.lead.read', scope: 'organisation' },
    { permission: 'workstation.lead.manage', scope: 'organisation' },
    { permission: 'workstation.lead.convert', scope: 'organisation' },
    { permission: 'workstation.client.read', scope: 'organisation' },
    { permission: 'workstation.client.manage', scope: 'organisation' },
    { permission: 'workstation.service.read', scope: 'organisation' },
    { permission: 'workstation.service.manage', scope: 'organisation' },
    { permission: 'workstation.followup.read', scope: 'organisation' },
    { permission: 'workstation.followup.manage', scope: 'organisation' },
    { permission: 'workstation.document.read', scope: 'organisation' },
    { permission: 'workstation.document.manage', scope: 'organisation' },
    { permission: 'workstation.document.verify', scope: 'organisation' },
    { permission: 'workstation.gst.read', scope: 'organisation' },
    { permission: 'workstation.gst.manage', scope: 'organisation' },
    { permission: 'workstation.eway.read', scope: 'organisation' },
    { permission: 'workstation.eway.generate', scope: 'organisation' },
    { permission: 'workstation.eway.cancel', scope: 'organisation' },
  ],
  hr_admin: [
    { permission: 'profile.read', scope: 'self' },
    { permission: 'profile.write.contact', scope: 'self' },
    { permission: 'profile.write.employment', scope: 'organisation' },
    { permission: 'employee.read', scope: 'organisation' },
    { permission: 'employee.manage', scope: 'organisation' },
    { permission: 'attendance.read', scope: 'organisation' },
    { permission: 'attendance.manage', scope: 'organisation' },
    { permission: 'attendance.correct.approve', scope: 'organisation' },
    { permission: 'leave.read', scope: 'organisation' },
    { permission: 'leave.manage', scope: 'organisation' },
    { permission: 'leave.approve', scope: 'organisation' },
    { permission: 'salary.manage', scope: 'organisation' },
    // §5 makes payroll.view separately grantable and off by default. The demo
    // seed grants it so HR can drive a run end to end; revoke it in Settings
    // to see the spec default.
    { permission: 'payroll.view', scope: 'organisation' },
    { permission: 'payroll.run', scope: 'organisation' },
    { permission: 'payroll.review', scope: 'organisation' },
    { permission: 'document.read', scope: 'organisation' },
    { permission: 'document.manage', scope: 'organisation' },
    { permission: 'chat.participate', scope: 'organisation' },
    { permission: 'reports.hr', scope: 'organisation' },
    { permission: 'audit.read.hr', scope: 'organisation' },
    { permission: 'settings.manage', scope: 'organisation' },
  ],
  finance_admin: [
    { permission: 'profile.read', scope: 'self' },
    { permission: 'profile.write.contact', scope: 'self' },
    // §5‡ — the restricted six-field projection, never a full employee read.
    { permission: 'employee.read.restricted', scope: 'organisation' },
    { permission: 'payroll.approve', scope: 'organisation' },
    { permission: 'payroll.process', scope: 'organisation' },
    { permission: 'payroll.view', scope: 'organisation' },
    { permission: 'expense.approve', scope: 'organisation' },
    { permission: 'expense.pay', scope: 'organisation' },
    { permission: 'accounts.manage', scope: 'organisation' },
    { permission: 'payments.manage', scope: 'organisation' },
    { permission: 'chat.participate', scope: 'organisation' },
    { permission: 'reports.finance', scope: 'organisation' },
    { permission: 'audit.read.finance', scope: 'organisation' },
  ],
  md: [
    { permission: 'profile.read', scope: 'self' },
    { permission: 'profile.write.contact', scope: 'self' },
    { permission: 'profile.write.employment', scope: 'organisation' },
    { permission: 'employee.read', scope: 'organisation' },
    { permission: 'employee.manage', scope: 'organisation' },
    { permission: 'attendance.read', scope: 'organisation' },
    { permission: 'attendance.manage', scope: 'organisation' },
    { permission: 'attendance.correct.approve', scope: 'organisation' },
    { permission: 'leave.read', scope: 'organisation' },
    { permission: 'leave.manage', scope: 'organisation' },
    { permission: 'leave.approve', scope: 'organisation' },
    { permission: 'salary.manage', scope: 'organisation' },
    { permission: 'payroll.run', scope: 'organisation' },
    { permission: 'payroll.review', scope: 'organisation' },
    { permission: 'payroll.approve', scope: 'organisation' },
    { permission: 'payroll.process', scope: 'organisation' },
    { permission: 'payroll.view', scope: 'organisation' },
    { permission: 'expense.submit', scope: 'self' },
    { permission: 'expense.approve', scope: 'organisation' },
    { permission: 'expense.pay', scope: 'organisation' },
    { permission: 'accounts.read', scope: 'organisation' },
    { permission: 'accounts.manage', scope: 'organisation' },
    { permission: 'payments.manage', scope: 'organisation' },
    { permission: 'document.read', scope: 'organisation' },
    { permission: 'document.manage', scope: 'organisation' },
    { permission: 'chat.participate', scope: 'organisation' },
    { permission: 'chat.manage', scope: 'organisation' },
    { permission: 'reports.all', scope: 'organisation' },
    { permission: 'audit.read.all', scope: 'organisation' },
    { permission: 'settings.manage', scope: 'organisation' },
    // Workstation: full operational access (§14 Operations Manager / MD).
    { permission: 'workstation.access', scope: 'organisation' },
    { permission: 'workstation.lead.read', scope: 'organisation' },
    { permission: 'workstation.lead.manage', scope: 'organisation' },
    { permission: 'workstation.lead.convert', scope: 'organisation' },
    { permission: 'workstation.client.read', scope: 'organisation' },
    { permission: 'workstation.client.manage', scope: 'organisation' },
    { permission: 'workstation.service.read', scope: 'organisation' },
    { permission: 'workstation.service.manage', scope: 'organisation' },
    { permission: 'workstation.followup.read', scope: 'organisation' },
    { permission: 'workstation.followup.manage', scope: 'organisation' },
    { permission: 'workstation.document.read', scope: 'organisation' },
    { permission: 'workstation.document.manage', scope: 'organisation' },
    { permission: 'workstation.document.verify', scope: 'organisation' },
    { permission: 'workstation.gst.read', scope: 'organisation' },
    { permission: 'workstation.gst.manage', scope: 'organisation' },
    { permission: 'workstation.eway.read', scope: 'organisation' },
    { permission: 'workstation.eway.generate', scope: 'organisation' },
    { permission: 'workstation.eway.cancel', scope: 'organisation' },
  ],
}

const SCOPE_RANK: Record<Scope, number> = { self: 0, department: 1, organisation: 2 }

export function scopeSatisfies(granted: Scope, required: Scope): boolean {
  return SCOPE_RANK[granted] >= SCOPE_RANK[required]
}

/** Static check against the matrix. Used by the seed and by tests. */
export function matrixHasPermission(role: RoleCode, permission: PermissionCode, required: Scope = 'self'): boolean {
  return MATRIX[role].some((g) => g.permission === permission && scopeSatisfies(g.scope, required))
}

export const ALL_PERMISSION_CODES: PermissionCode[] = Array.from(
  new Set(Object.values(MATRIX).flatMap((grants) => grants.map((g) => g.permission))),
)

export const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  'profile.read': 'View own profile',
  'profile.write.contact': 'Edit own contact details',
  'profile.write.employment': 'Edit employment fields on any profile',
  'employee.read': 'View the employee directory',
  'employee.read.restricted': 'View the finance projection of employees',
  'employee.manage': 'Create, edit and deactivate employees',
  'attendance.read': 'View attendance records',
  'attendance.check_in': 'Check in and out',
  'attendance.correct.request': 'Request an attendance correction',
  'attendance.correct.approve': 'Approve attendance corrections',
  'attendance.manage': 'Administer attendance',
  'leave.read': 'View leave records',
  'leave.request': 'Apply for leave',
  'leave.approve': 'Approve or reject leave',
  'leave.manage': 'Administer leave',
  'payroll.view': 'View payroll runs and salary figures',
  'payroll.view.own': 'View own payslips',
  'payroll.run': 'Create and calculate a payroll run',
  'payroll.review': 'Move a payroll run through review',
  'payroll.approve': 'Approve a payroll run',
  'payroll.process': 'Process a run: payments, ledger and payslips',
  'salary.manage': 'Read and update salary structures',
  'expense.submit': 'Raise an expense claim',
  'expense.approve': 'Approve or reject expenses',
  'expense.pay': 'Mark an expense reimbursed',
  'expense.manage': 'Administer expenses',
  'accounts.read': 'Read the internal ledger',
  'accounts.manage': 'Post contra entries to the ledger',
  'payments.manage': 'View and record payments',
  'document.read': 'View employee documents',
  'document.manage': 'Upload and delete employee documents',
  'chat.participate': 'Use group chats and direct messages',
  'chat.manage': 'Administer conversations',
  'reports.hr': 'Run HR reports',
  'reports.finance': 'Run finance reports',
  'reports.all': 'Run every report',
  'audit.read.hr': 'Read the HR audit log',
  'audit.read.finance': 'Read the finance audit log',
  'audit.read.all': 'Read the full audit log',
  'settings.manage': 'Manage organisation configuration',
  'workstation.access': 'Open the Workstation module',
  'workstation.lead.read': 'View leads',
  'workstation.lead.manage': 'Create and edit leads',
  'workstation.lead.convert': 'Convert a won lead into a client',
  'workstation.client.read': 'View clients',
  'workstation.client.manage': 'Create and edit clients',
  'workstation.service.read': 'View client services',
  'workstation.service.manage': 'Assign and progress client services',
  'workstation.followup.read': 'View follow-ups',
  'workstation.followup.manage': 'Create, reschedule and complete follow-ups',
  'workstation.document.read': 'View client documents',
  'workstation.document.manage': 'Request and upload client documents',
  'workstation.document.verify': 'Verify or reject a client document',
  'workstation.gst.read': 'View GST profiles and filings',
  'workstation.gst.manage': 'Update GST filing status',
  'workstation.eway.read': 'View e-way bills',
  'workstation.eway.generate': 'Generate a (simulated) e-way bill',
  'workstation.eway.cancel': 'Cancel a (simulated) e-way bill',
}
