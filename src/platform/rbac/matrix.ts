/**
 * Permission matrix from HRMSPart1.md §5.
 *
 * This is the CANONICAL server-side source. UI hiding is derived from this —
 * never the other way around. Enforcement happens in mock/middleware.ts
 * (`withScope(permission, scope)`), mirroring the Express chain that will
 * replace it.
 *
 * `S` = own record, `D` = own department, `O` = organisation.
 * `R` / `RW` derived from action; permission codes below encode both.
 */

import type { RoleCode } from '@/data/models';

export type Scope = 'self' | 'department' | 'organisation';

/**
 * Permission code convention: `<module>.<action>` and optional qualifier.
 * Actions: read | write | approve | pay | manage
 * If a role has `manage`, it implies `read | write | approve` for that module.
 */
export type PermissionCode =
  // Own profile — every role has this at self scope (contact fields only).
  | 'profile.read'
  | 'profile.write.contact'
  | 'profile.write.employment' // HR/MD only
  // Employees
  | 'employee.read'
  | 'employee.read.restricted' // finance projection: id/name/dept/desig/bank_masked/status
  | 'employee.manage'
  // Attendance
  | 'attendance.read'
  | 'attendance.check_in'
  | 'attendance.correct.request'
  | 'attendance.correct.approve'
  | 'attendance.manage'
  // Leave
  | 'leave.read'
  | 'leave.request'
  | 'leave.approve'
  | 'leave.manage'
  // Payroll (data lives in Part 2; permission codes exist here)
  | 'payroll.view'          // separately grantable, off by default per §5. Seeded on for HR in scaffold — see matrix notes.
  | 'payroll.view.own'
  | 'payroll.run'           // create a new PayrollRun for a period
  | 'payroll.review'        // HR review step
  | 'payroll.approve'       // Finance approves numbers
  | 'payroll.process'       // final: payments + ledger + payslips (irreversible)
  | 'salary.manage'
  // Expenses
  | 'expense.submit'
  | 'expense.approve'
  | 'expense.pay'
  | 'expense.manage'
  // Accounts / Ledger / Payments (Part 2)
  | 'accounts.read'
  | 'accounts.manage'
  | 'payments.manage'
  // Documents
  | 'document.read'
  | 'document.manage'
  // Chat
  | 'chat.participate'
  | 'chat.manage'
  // Reports
  | 'reports.hr'
  | 'reports.finance'
  | 'reports.all'
  // Audit
  | 'audit.read.hr'
  | 'audit.read.finance'
  | 'audit.read.all'
  // Settings
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
  // ── Tools (Converters & Utilities) ────────────────────────────────────
  // One code per tool (registry `permission`), plus module access and the
  // Documents view. Compliance converters carry a code already so flipping
  // a tool to `active` later never touches the matrix.
  | 'tools.access'
  | 'tools.documents.read'
  | 'tools.documents.manage'
  | 'tools.pdf_to_excel'
  | 'tools.excel_to_pdf'
  | 'tools.pdf_to_word'
  | 'tools.word_to_pdf'
  | 'tools.image_to_pdf'
  | 'tools.csv_to_excel'
  | 'tools.merge_pdf'
  | 'tools.split_pdf'
  | 'tools.compress_pdf'
  | 'tools.unlock_pdf'
  | 'tools.esign_pdf'
  | 'tools.ocr_scan'
  | 'tools.gst_json_excel'
  | 'tools.bank_statement_to_excel'
  | 'tools.form_26as_to_excel'
  | 'tools.excel_to_tally_xml'
  | 'tools.tds_fvu_generator'
  | 'tools.invoice_to_einvoice_json'
  // ── Audit Automation (AMENDMENT-02-REPOTIC-GAPS.md) ─────────────────
  // Submodule of Tools; bank-statement ingestion pipeline.
  | 'tools.audit_automation.access'
  | 'tools.audit_automation.bank.upload'
  | 'tools.audit_automation.bank.view'
  | 'tools.audit_automation.gst.upload'
  | 'tools.audit_automation.gst.view'
  | 'tools.audit_automation.tds.upload'
  | 'tools.audit_automation.tds.view'
  | 'tools.audit_automation.tally.access'
  | 'tools.audit_automation.tally.company.manage'
  | 'tools.audit_automation.tally.master.read'
  | 'tools.audit_automation.tally.master.manage';

export interface Grant {
  permission: PermissionCode;
  scope: Scope;
}

/**
 * §5 matrix, encoded. Each cell in the spec becomes zero or more grants.
 *
 * Notes:
 *   - `profile.write.contact` is `self` for everyone (contact fields only).
 *   - Department Manager NEVER gets salary/payroll grants — enforced by omission.
 *   - Finance Admin gets `employee.read.restricted` (§5‡), not `employee.read`.
 *   - HR Admin's `payroll.view` is a separately grantable permission, off by
 *     default. Seed HR Admin WITHOUT it; toggle later in Settings.
 */
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
    // Tools: own documents only.
    { permission: 'tools.access', scope: 'self' },
    { permission: 'tools.documents.read', scope: 'self' },
    { permission: 'tools.documents.manage', scope: 'self' },
    { permission: 'tools.pdf_to_excel', scope: 'self' },
    { permission: 'tools.excel_to_pdf', scope: 'self' },
    { permission: 'tools.pdf_to_word', scope: 'self' },
    { permission: 'tools.word_to_pdf', scope: 'self' },
    { permission: 'tools.image_to_pdf', scope: 'self' },
    { permission: 'tools.csv_to_excel', scope: 'self' },
    { permission: 'tools.merge_pdf', scope: 'self' },
    { permission: 'tools.split_pdf', scope: 'self' },
    { permission: 'tools.compress_pdf', scope: 'self' },
    { permission: 'tools.unlock_pdf', scope: 'self' },
    { permission: 'tools.esign_pdf', scope: 'self' },
    { permission: 'tools.ocr_scan', scope: 'self' },
    { permission: 'tools.gst_json_excel', scope: 'self' },
    { permission: 'tools.bank_statement_to_excel', scope: 'self' },
    { permission: 'tools.form_26as_to_excel', scope: 'self' },
    { permission: 'tools.excel_to_tally_xml', scope: 'self' },
    { permission: 'tools.tds_fvu_generator', scope: 'self' },
    { permission: 'tools.invoice_to_einvoice_json', scope: 'self' },
    { permission: 'tools.audit_automation.access', scope: 'self' },
    { permission: 'tools.audit_automation.bank.upload', scope: 'self' },
    { permission: 'tools.audit_automation.bank.view', scope: 'self' },
    { permission: 'tools.audit_automation.gst.upload', scope: 'self' },
    { permission: 'tools.audit_automation.gst.view', scope: 'self' },
    { permission: 'tools.audit_automation.tds.upload', scope: 'self' },
    { permission: 'tools.audit_automation.tds.view', scope: 'self' },
    { permission: 'tools.audit_automation.tally.access', scope: 'self' },
    { permission: 'tools.audit_automation.tally.company.manage', scope: 'self' },
    { permission: 'tools.audit_automation.tally.master.read', scope: 'self' },
    { permission: 'tools.audit_automation.tally.master.manage', scope: 'self' },
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
    // Tools: every document in the firm.
    { permission: 'tools.access', scope: 'organisation' },
    { permission: 'tools.documents.read', scope: 'organisation' },
    { permission: 'tools.documents.manage', scope: 'organisation' },
    { permission: 'tools.pdf_to_excel', scope: 'organisation' },
    { permission: 'tools.excel_to_pdf', scope: 'organisation' },
    { permission: 'tools.pdf_to_word', scope: 'organisation' },
    { permission: 'tools.word_to_pdf', scope: 'organisation' },
    { permission: 'tools.image_to_pdf', scope: 'organisation' },
    { permission: 'tools.csv_to_excel', scope: 'organisation' },
    { permission: 'tools.merge_pdf', scope: 'organisation' },
    { permission: 'tools.split_pdf', scope: 'organisation' },
    { permission: 'tools.compress_pdf', scope: 'organisation' },
    { permission: 'tools.unlock_pdf', scope: 'organisation' },
    { permission: 'tools.esign_pdf', scope: 'organisation' },
    { permission: 'tools.ocr_scan', scope: 'organisation' },
    { permission: 'tools.gst_json_excel', scope: 'organisation' },
    { permission: 'tools.bank_statement_to_excel', scope: 'organisation' },
    { permission: 'tools.form_26as_to_excel', scope: 'organisation' },
    { permission: 'tools.excel_to_tally_xml', scope: 'organisation' },
    { permission: 'tools.tds_fvu_generator', scope: 'organisation' },
    { permission: 'tools.invoice_to_einvoice_json', scope: 'organisation' },
    { permission: 'tools.audit_automation.access', scope: 'organisation' },
    { permission: 'tools.audit_automation.bank.upload', scope: 'organisation' },
    { permission: 'tools.audit_automation.bank.view', scope: 'organisation' },
    { permission: 'tools.audit_automation.gst.upload', scope: 'organisation' },
    { permission: 'tools.audit_automation.gst.view', scope: 'organisation' },
    { permission: 'tools.audit_automation.tds.upload', scope: 'organisation' },
    { permission: 'tools.audit_automation.tds.view', scope: 'organisation' },
    { permission: 'tools.audit_automation.tally.access', scope: 'organisation' },
    { permission: 'tools.audit_automation.tally.company.manage', scope: 'organisation' },
    { permission: 'tools.audit_automation.tally.master.read', scope: 'organisation' },
    { permission: 'tools.audit_automation.tally.master.manage', scope: 'organisation' },
  ],
  hr_admin: [
    { permission: 'profile.read', scope: 'self' },
    { permission: 'profile.write.contact', scope: 'self' },
    { permission: 'profile.write.employment', scope: 'organisation' },
    // `.manage` subsumes `.read`, but rather than encode that as magic in
    // can(), we grant read explicitly. Auditable, greppable, and the sidebar
    // check reads naturally.
    { permission: 'employee.read', scope: 'organisation' },
    { permission: 'employee.manage', scope: 'organisation' },
    { permission: 'attendance.read', scope: 'organisation' },
    { permission: 'attendance.manage', scope: 'organisation' },
    { permission: 'attendance.correct.approve', scope: 'organisation' },
    { permission: 'leave.read', scope: 'organisation' },
    { permission: 'leave.manage', scope: 'organisation' },
    { permission: 'leave.approve', scope: 'organisation' },
    { permission: 'salary.manage', scope: 'organisation' },
    // §5 says payroll.view is "separately grantable, off by default". For the
    // scaffold we seed it on so HR can review runs; documented handoff.
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
    // §5‡: restricted projection ONLY, not full read.
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
    // Explicit read grants alongside manage — see note on hr_admin.
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
    // Tools: every document in the firm.
    { permission: 'tools.access', scope: 'organisation' },
    { permission: 'tools.documents.read', scope: 'organisation' },
    { permission: 'tools.documents.manage', scope: 'organisation' },
    { permission: 'tools.pdf_to_excel', scope: 'organisation' },
    { permission: 'tools.excel_to_pdf', scope: 'organisation' },
    { permission: 'tools.pdf_to_word', scope: 'organisation' },
    { permission: 'tools.word_to_pdf', scope: 'organisation' },
    { permission: 'tools.image_to_pdf', scope: 'organisation' },
    { permission: 'tools.csv_to_excel', scope: 'organisation' },
    { permission: 'tools.merge_pdf', scope: 'organisation' },
    { permission: 'tools.split_pdf', scope: 'organisation' },
    { permission: 'tools.compress_pdf', scope: 'organisation' },
    { permission: 'tools.unlock_pdf', scope: 'organisation' },
    { permission: 'tools.esign_pdf', scope: 'organisation' },
    { permission: 'tools.ocr_scan', scope: 'organisation' },
    { permission: 'tools.gst_json_excel', scope: 'organisation' },
    { permission: 'tools.bank_statement_to_excel', scope: 'organisation' },
    { permission: 'tools.form_26as_to_excel', scope: 'organisation' },
    { permission: 'tools.excel_to_tally_xml', scope: 'organisation' },
    { permission: 'tools.tds_fvu_generator', scope: 'organisation' },
    { permission: 'tools.invoice_to_einvoice_json', scope: 'organisation' },
    { permission: 'tools.audit_automation.access', scope: 'organisation' },
    { permission: 'tools.audit_automation.bank.upload', scope: 'organisation' },
    { permission: 'tools.audit_automation.bank.view', scope: 'organisation' },
    { permission: 'tools.audit_automation.gst.upload', scope: 'organisation' },
    { permission: 'tools.audit_automation.gst.view', scope: 'organisation' },
    { permission: 'tools.audit_automation.tds.upload', scope: 'organisation' },
    { permission: 'tools.audit_automation.tds.view', scope: 'organisation' },
    { permission: 'tools.audit_automation.tally.access', scope: 'organisation' },
    { permission: 'tools.audit_automation.tally.company.manage', scope: 'organisation' },
    { permission: 'tools.audit_automation.tally.master.read', scope: 'organisation' },
    { permission: 'tools.audit_automation.tally.master.manage', scope: 'organisation' },
  ],
};

/**
 * Broader scope subsumes narrower.
 * organisation > department > self.
 */
const SCOPE_RANK: Record<Scope, number> = {
  self: 0,
  department: 1,
  organisation: 2,
};

export function scopeSatisfies(granted: Scope, required: Scope): boolean {
  return SCOPE_RANK[granted] >= SCOPE_RANK[required];
}

/**
 * Pure check — no request context. Use for menu rendering (still not a
 * security control per §4.3; the API decides).
 */
export function hasPermission(
  role: RoleCode,
  permission: PermissionCode,
  requiredScope: Scope = 'self',
): boolean {
  const grants = MATRIX[role];
  return grants.some(
    (g) => g.permission === permission && scopeSatisfies(g.scope, requiredScope),
  );
}
