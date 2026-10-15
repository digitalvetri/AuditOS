/**
 * ROLE SECTIONS — what Settings → Roles & permissions edits.
 *
 * Every permission code belongs to exactly one section (Employees,
 * Attendance, Tasks, each tool, …) or is a module GATE. A role holds each
 * section at one level:
 *
 *   none  — no code in it
 *   own   — its own records only (self scope): check in, apply for leave,
 *           see own payslips… (HRMS personal sections only)
 *   view  — read everyone's records (organisation scope)
 *   full  — every code in the section, organisation scope
 *
 * A role whose rows match no level exactly reads back as "custom".
 *
 * GATES ("open the module" codes such as workstation.access) are never
 * edited directly: a role holds a gate exactly when it holds some section
 * behind it. Which clients a person sees is the Client visibility section
 * (clients.view_all) — Workstation reads are organisation scope, narrowed to
 * assigned clients unless it is on.
 */
import { ALL_PERMISSION_CODES, type PermissionCode, type Scope } from './matrix.js'
import type { ModuleCode } from './modules.js'

export type Level = 'none' | 'own' | 'view' | 'full'
export type Grant = { code: PermissionCode; scope: Scope }

export interface Section {
  code: string
  module: ModuleCode
  /** Sub-heading inside the module (e.g. "Converters", "Audit Automation"). */
  group?: string
  name: string
  /** Levels offered, lowest first (none is always offered). */
  levels: Partial<Record<Exclude<Level, 'none'>, Grant[]>>
  /** Labels when the generic ones would mislead ("Allowed", "All clients"). */
  labels?: Partial<Record<Level, string>>
  /** The gates this section opens. */
  gates: PermissionCode[]
}

const org = (...codes: PermissionCode[]): Grant[] => codes.map((code) => ({ code, scope: 'organisation' }))
const self = (...codes: PermissionCode[]): Grant[] => codes.map((code) => ({ code, scope: 'self' }))

/** Codes that only open a module or submodule; granted from the sections behind them. */
export const GATES: { code: PermissionCode; name: string }[] = [
  { code: 'workstation.access', name: 'Open Workstation' },
  { code: 'tools.access', name: 'Open Tools' },
  { code: 'tools.audit_automation.access', name: 'Open Audit Automation' },
  { code: 'tools.audit_automation.bookkeeping.access', name: 'Open Tally accounting' },
]

const W: PermissionCode[] = ['workstation.access']
const T: PermissionCode[] = ['tools.access']
const AA: PermissionCode[] = ['tools.access', 'tools.audit_automation.access']
const BK: PermissionCode[] = ['tools.access', 'tools.audit_automation.access', 'tools.audit_automation.bookkeeping.access']

/** A Workstation register: View reads it, Full adds every write code. */
const register = (code: string, name: string, read: PermissionCode, ...manage: PermissionCode[]): Section => ({
  code: `workstation.${code}`, module: 'workstation', name, gates: W,
  levels: { view: org(read), full: org(read, ...manage) },
})

/** A single-code tool: allowed or not. */
const tool = (code: PermissionCode, name: string, group: string): Section => ({
  code, module: 'tools', group, name, gates: T,
  levels: { full: org(code) }, labels: { full: 'Allowed' },
})

export const SECTIONS: Section[] = [
  // ── HRMS ──────────────────────────────────────────────────────────────
  { code: 'hrms.profile', module: 'hrms', group: 'People', name: 'My profile', gates: [],
    levels: { own: self('profile.read', 'profile.write.contact'), full: org('profile.read', 'profile.write.contact') },
    labels: { own: 'Own profile' } },
  { code: 'hrms.employees', module: 'hrms', group: 'People', name: 'Employees', gates: [],
    levels: {
      own: self('employee.read'),
      view: org('employee.read'),
      full: org('employee.read', 'employee.manage', 'profile.write.employment', 'employee.read.restricted'),
    }, labels: { own: 'Own record' } },
  { code: 'hrms.attendance', module: 'hrms', group: 'People', name: 'Attendance', gates: [],
    levels: {
      own: self('attendance.read', 'attendance.check_in', 'attendance.correct.request'),
      view: [...org('attendance.read'), ...self('attendance.check_in', 'attendance.correct.request')],
      full: org('attendance.read', 'attendance.check_in', 'attendance.correct.request', 'attendance.correct.approve', 'attendance.manage'),
    } },
  { code: 'hrms.leave', module: 'hrms', group: 'People', name: 'Leave', gates: [],
    levels: {
      own: self('leave.read', 'leave.request'),
      view: [...org('leave.read'), ...self('leave.request')],
      full: org('leave.read', 'leave.request', 'leave.approve', 'leave.manage'),
    } },
  { code: 'hrms.documents', module: 'hrms', group: 'People', name: 'Employee documents', gates: [],
    levels: { own: self('document.read'), view: org('document.read'), full: org('document.read', 'document.manage') } },
  { code: 'hrms.messages', module: 'hrms', group: 'People', name: 'Messages', gates: [],
    levels: { view: org('chat.participate'), full: org('chat.participate', 'chat.manage') },
    labels: { view: 'Use chats' } },

  { code: 'hrms.payroll', module: 'hrms', group: 'Finance', name: 'Payroll & salary', gates: [],
    levels: {
      own: self('payroll.view.own'),
      view: [...self('payroll.view.own'), ...org('payroll.view')],
      full: org('payroll.view.own', 'payroll.view', 'salary.manage', 'payroll.run', 'payroll.review', 'payroll.approve', 'payroll.process'),
    }, labels: { own: 'Own payslips' } },
  { code: 'hrms.expenses', module: 'hrms', group: 'Finance', name: 'Expenses', gates: [],
    // expense.manage is checked by the expenses route but is not a seeded code (not in ALL_PERMISSION_CODES).
    levels: { own: self('expense.submit'), full: org('expense.submit', 'expense.approve', 'expense.pay') },
    labels: { own: 'Own claims' } },
  { code: 'hrms.payments', module: 'hrms', group: 'Finance', name: 'Payments & payment summary', gates: [],
    levels: { view: org('payment_summary.read'), full: org('payment_summary.read', 'payment_summary.manage', 'payments.manage') } },
  { code: 'hrms.accounts', module: 'hrms', group: 'Finance', name: 'Ledger (accounts)', gates: [],
    levels: { view: org('accounts.read'), full: org('accounts.read', 'accounts.manage') } },

  { code: 'hrms.reports', module: 'hrms', group: 'Admin', name: 'Reports', gates: [],
    levels: { own: self('reports.hr'), view: org('reports.hr'), full: org('reports.hr', 'reports.finance', 'reports.all') },
    labels: { own: 'Own figures', view: 'HR reports', full: 'All reports' } },
  { code: 'hrms.audit_log', module: 'hrms', group: 'Admin', name: 'Audit log', gates: [],
    levels: { view: org('audit.read.hr'), full: org('audit.read.hr', 'audit.read.finance', 'audit.read.all') },
    labels: { view: 'HR entries', full: 'Full log' } },
  { code: 'hrms.settings', module: 'hrms', group: 'Admin', name: 'Settings (incl. roles)', gates: [],
    levels: { full: org('settings.manage') }, labels: { full: 'Manage' } },

  // ── Workstation ───────────────────────────────────────────────────────
  { code: 'workstation.client_visibility', module: 'workstation', group: 'Clients', name: 'Client visibility', gates: [],
    levels: { full: org('clients.view_all') }, labels: { none: 'Assigned only', full: 'All clients' } },
  register('clients', 'Clients', 'workstation.client.read', 'workstation.client.manage'),
  register('leads', 'Leads', 'workstation.lead.read', 'workstation.lead.manage', 'workstation.lead.convert'),
  register('services', 'Client services', 'workstation.service.read', 'workstation.service.manage'),
  register('followups', 'Follow-ups', 'workstation.followup.read', 'workstation.followup.manage'),
  register('client_documents', 'Client documents', 'workstation.document.read', 'workstation.document.manage', 'workstation.document.verify'),
  register('tasks', 'Tasks & time', 'workstation.task.read', 'workstation.task.manage', 'workstation.task.report'),
  register('quotations', 'Quotations', 'workstation.quotation.read', 'workstation.quotation.manage', 'workstation.quotation.approve'),
  register('invoices', 'Invoices', 'workstation.invoice.read', 'workstation.invoice.manage'),
  register('engagements', 'Engagement letters', 'workstation.engagement.read', 'workstation.engagement.manage'),
  register('letters', 'Letters & docs', 'workstation.doc.read', 'workstation.doc.manage'),
  register('gst', 'GST filings', 'workstation.gst.read', 'workstation.gst.manage'),
  register('compliance', 'Compliance calendar', 'workstation.compliance.read', 'workstation.compliance.manage'),
  register('notices', 'Notices', 'workstation.notice.read', 'workstation.notice.manage'),
  register('dsc', 'DSC register', 'workstation.dsc.read', 'workstation.dsc.manage'),
  register('eway', 'E-way bills', 'workstation.eway.read', 'workstation.eway.generate', 'workstation.eway.cancel'),
  register('audit', 'Audit files', 'workstation.audit.read', 'workstation.audit.manage', 'workstation.audit.review', 'workstation.audit.sign'),
  { code: 'workstation.registration_templates', module: 'workstation', name: 'Registration templates', gates: W,
    levels: { full: org('workstation.registration.template.manage') }, labels: { full: 'Edit' } },
  { code: 'workstation.portal_logins', module: 'workstation', name: 'Portal logins', gates: W,
    levels: {
      view: org('workstation.gst.portal.view', 'workstation.tds.portal.view', 'workstation.registration.portal.view'),
      full: org('workstation.gst.portal.view', 'workstation.tds.portal.view', 'workstation.registration.portal.view',
        'workstation.gst.portal.reveal', 'workstation.tds.portal.reveal', 'workstation.registration.portal.reveal'),
    }, labels: { view: 'Masked', full: 'Reveal passwords' } },

  // ── Tools ─────────────────────────────────────────────────────────────
  { code: 'tools.documents', module: 'tools', group: 'General', name: 'Converted documents', gates: T,
    levels: { view: org('tools.documents.read'), full: org('tools.documents.read', 'tools.documents.manage') } },
  tool('tools.pdf_to_excel', 'PDF to Excel', 'Conversion'),
  tool('tools.excel_to_pdf', 'Excel to PDF', 'Conversion'),
  tool('tools.pdf_to_word', 'PDF to Word', 'Conversion'),
  tool('tools.word_to_pdf', 'Word to PDF', 'Conversion'),
  tool('tools.image_to_pdf', 'Image to PDF', 'Conversion'),
  tool('tools.csv_to_excel', 'CSV to Excel', 'Conversion'),
  tool('tools.merge_pdf', 'Merge PDF', 'PDF utilities'),
  tool('tools.split_pdf', 'Split PDF', 'PDF utilities'),
  tool('tools.compress_pdf', 'Compress PDF', 'PDF utilities'),
  tool('tools.unlock_pdf', 'Unlock PDF', 'PDF utilities'),
  tool('tools.esign_pdf', 'e-Sign PDF', 'PDF utilities'),
  tool('tools.ocr_scan', 'OCR Scan', 'PDF utilities'),
  tool('tools.gst_json_excel', 'GST JSON ⇄ Excel', 'Compliance converters'),
  tool('tools.bank_statement_to_excel', 'Bank Statement to Excel', 'Compliance converters'),
  tool('tools.form_26as_to_excel', 'Form 26AS to Excel', 'Compliance converters'),
  tool('tools.excel_to_tally_xml', 'Excel to Tally XML', 'Compliance converters'),
  tool('tools.tds_fvu_generator', 'TDS Text/FVU Generator', 'Compliance converters'),
  tool('tools.invoice_to_einvoice_json', 'Invoice to e-Invoice JSON', 'Compliance converters'),
  { code: 'tools.aa_bank', module: 'tools', group: 'Audit Automation', name: 'Bank statement processing', gates: AA,
    levels: { view: org('tools.audit_automation.bank.view'), full: org('tools.audit_automation.bank.view', 'tools.audit_automation.bank.upload') } },
  { code: 'tools.aa_gst', module: 'tools', group: 'Audit Automation', name: 'GST reconciliation', gates: AA,
    levels: { view: org('tools.audit_automation.gst.view'), full: org('tools.audit_automation.gst.view', 'tools.audit_automation.gst.upload') } },
  { code: 'tools.aa_tds', module: 'tools', group: 'Audit Automation', name: 'TDS reconciliation', gates: AA,
    levels: { view: org('tools.audit_automation.tds.view'), full: org('tools.audit_automation.tds.view', 'tools.audit_automation.tds.upload') } },
  { code: 'tools.tally', module: 'tools', group: 'Audit Automation', name: 'Tally accounting', gates: BK,
    levels: {
      view: org('tools.audit_automation.bookkeeping.master.read', 'tools.audit_automation.bookkeeping.voucher.read',
        'tools.audit_automation.bookkeeping.report.read', 'tools.audit_automation.bookkeeping.audit.read'),
      full: org('tools.audit_automation.bookkeeping.master.read', 'tools.audit_automation.bookkeeping.voucher.read',
        'tools.audit_automation.bookkeeping.report.read', 'tools.audit_automation.bookkeeping.audit.read',
        'tools.audit_automation.bookkeeping.company.manage', 'tools.audit_automation.bookkeeping.master.manage',
        'tools.audit_automation.bookkeeping.voucher.manage', 'tools.audit_automation.bookkeeping.voucher.cancel',
        'tools.audit_automation.bookkeeping.settings.manage', 'tools.audit_automation.bookkeeping.data.manage'),
    } },
  { code: 'tools.books', module: 'tools', group: 'Books', name: 'Books (Zoho Books)', gates: T,
    levels: {
      view: org('books.access', 'books.reports'),
      full: org('books.access', 'books.reports', 'books.manage', 'books.accountant', 'books.settings'),
    } },

  // ── Integrations ──────────────────────────────────────────────────────
  { code: 'integrations.zoho_payments', module: 'integrations', name: 'Zoho Payments', gates: [],
    levels: { full: org('integrations.access') } },
]

export const LEVEL_ORDER: Level[] = ['none', 'own', 'view', 'full']
const GENERIC_LABEL: Record<Level, string> = { none: 'No access', own: 'Own records', view: 'View', full: 'Full access' }

export function levelsOf(s: Section): Level[] {
  return LEVEL_ORDER.filter((l) => l === 'none' || s.levels[l as Exclude<Level, 'none'>])
}
export const labelOf = (s: Section, l: Level) => s.labels?.[l] ?? GENERIC_LABEL[l]
export const grantsAt = (s: Section, l: Level): Grant[] => (l === 'none' ? [] : s.levels[l] ?? [])
export const topLevel = (s: Section): Level => levelsOf(s).at(-1)!

/** Every code a section can grant. */
export function sectionCodes(s: Section): PermissionCode[] {
  return [...new Set(Object.values(s.levels).flatMap((g) => g!.map((x) => x.code)))]
}

const SECTION_OF = new Map<string, Section>(SECTIONS.flatMap((s) => sectionCodes(s).map((c) => [c, s] as const)))
const GATE_CODES = new Set<string>(GATES.map((g) => g.code))

export const sectionOf = (code: string): Section | undefined => SECTION_OF.get(code)
export const isGate = (code: string) => GATE_CODES.has(code)

/** The module a code belongs to (a gate: the module it opens). */
export function moduleOfCode(code: string): ModuleCode {
  const s = SECTION_OF.get(code)
  if (s) return s.module
  if (code.startsWith('workstation.')) return 'workstation'
  if (code.startsWith('tools.') || code.startsWith('books.')) return 'tools'
  if (code.startsWith('integrations.')) return 'integrations'
  return 'hrms'
}

/**
 * The level a role's grants match for a section: the level whose code+scope
 * set equals what the role holds in the section. Anything else is 'custom'.
 */
export function levelHeld(s: Section, held: Map<string, string>): Level | 'custom' {
  const codes = sectionCodes(s)
  const mine = codes.filter((c) => held.has(c))
  if (!mine.length) return 'none'
  for (const l of levelsOf(s)) {
    if (l === 'none') continue
    const g = grantsAt(s, l)
    if (g.length === mine.length && g.every((x) => held.get(x.code) === x.scope)) return l
  }
  return 'custom'
}

/** Gates a set of grants implies: a gate is held when any section behind it is. */
export function gatesFor(held: Map<string, string>): PermissionCode[] {
  const out = new Set<PermissionCode>()
  for (const s of SECTIONS) if (sectionCodes(s).some((c) => held.has(c))) for (const g of s.gates) out.add(g)
  return [...out]
}

/** Every permission code is in exactly one section or is a gate (checked by the tests). */
export function unassignedCodes(): PermissionCode[] {
  return ALL_PERMISSION_CODES.filter((c) => !SECTION_OF.has(c) && !GATE_CODES.has(c))
}
