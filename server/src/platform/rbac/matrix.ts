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
  // ── Audit Automation (AMENDMENT-02-REPOTIC-GAPS.md) ───────────────────
  // Submodule of Tools with its own pipeline (bank statement ingestion).
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
  | 'tools.audit_automation.tally.master.manage'

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
  'tools.access': 'Open the Tools module',
  'tools.documents.read': 'View converted documents',
  'tools.documents.manage': 'Delete converted documents',
  'tools.pdf_to_excel': 'Use the PDF to Excel tool',
  'tools.excel_to_pdf': 'Use the Excel to PDF tool',
  'tools.pdf_to_word': 'Use the PDF to Word tool',
  'tools.word_to_pdf': 'Use the Word to PDF tool',
  'tools.image_to_pdf': 'Use the Image to PDF tool',
  'tools.csv_to_excel': 'Use the CSV to Excel tool',
  'tools.merge_pdf': 'Use the Merge PDF tool',
  'tools.split_pdf': 'Use the Split PDF tool',
  'tools.compress_pdf': 'Use the Compress PDF tool',
  'tools.unlock_pdf': 'Use the Unlock PDF tool',
  'tools.esign_pdf': 'Use the e-Sign PDF tool',
  'tools.ocr_scan': 'Use the OCR Scan tool',
  'tools.gst_json_excel': 'Use the GST JSON ⇄ Excel tool',
  'tools.bank_statement_to_excel': 'Use the Bank Statement to Excel tool',
  'tools.form_26as_to_excel': 'Use the Form 26AS to Excel tool',
  'tools.excel_to_tally_xml': 'Use the Excel to Tally XML tool',
  'tools.tds_fvu_generator': 'Use the TDS Text/FVU Generator tool',
  'tools.invoice_to_einvoice_json': 'Use the Invoice to e-Invoice JSON tool',
  'tools.audit_automation.access': 'Open the Audit Automation submodule',
  'tools.audit_automation.bank.upload': 'Upload a bank statement for automated processing',
  'tools.audit_automation.bank.view': 'View bank-statement processing jobs',
  'tools.audit_automation.gst.upload': 'Upload GSTR-2B or Purchase Register and run reconciliation',
  'tools.audit_automation.gst.view': 'View GST reconciliation jobs and results',
  'tools.audit_automation.tds.upload': 'Upload Form 26AS or TDS books and run reconciliation',
  'tools.audit_automation.tds.view': 'View TDS reconciliation jobs and results',
  'tools.audit_automation.tally.access': 'Open the Tally accounting module',
  'tools.audit_automation.tally.company.manage': 'Create and edit Tally companies and financial years',
  'tools.audit_automation.tally.master.read': 'View Tally groups and ledgers',
  'tools.audit_automation.tally.master.manage': 'Create, edit and delete Tally groups and ledgers',
}
