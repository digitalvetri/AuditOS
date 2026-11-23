/**
 * PAGE ACCESS — per-employee switches on top of the role.
 *
 * The sidebar is six blocks of pages (frontend/src/shell/v2/Sidebar.tsx,
 * every row carries one of these keys). An Admin decides, page by page, what
 * one login can open (Employees → Page access):
 *   - User.hiddenPages: pages the role gives, switched OFF for this login.
 *   - User.extraPages:  pages the role does not give, switched ON for it.
 *
 * Switching a page OFF, per page:
 *   perms — the permission families the page owns are removed from the
 *           login's grants, so every existing can() check (API routes,
 *           dashboard widgets, client tabs) treats them as not held.
 *           An entry ending in '.' is a prefix; anything else is exact.
 *   api   — API path prefixes only this page uses are refused with a 403.
 *   neither — the page shares its API with other screens or with the
 *           person's own self-service (attendance, leave, the client
 *           picker…): the menu row and the page are hidden only.
 *
 * Switching a page ON adds the codes `grantCodes` gives it (its `grant`
 * list, else its `perms` families) at the scope the role would hold them.
 * Review/approval and partner sign-off codes are never handed out this way,
 * and Settings (which manages roles and logins) cannot be added at all.
 */
import { ALL_PERMISSION_CODES, type RoleCode, type Scope } from './rbac/matrix.js'
import { moduleOf, scopeFor } from './rbac/modules.js'

export type BlockKey = 'lead_client' | 'office_files' | 'official_docs' | 'workstation' | 'hr_admin' | 'tools'

export interface PageDef {
  key: string
  block: BlockKey
  perms?: string[]
  api?: string[]
  /** Codes switching the page ON adds (same syntax as perms). Default: perms. */
  grant?: string[]
  /** Prefixes left out of `grant` (a family shared with another page). */
  grantExcept?: string[]
  /** False: the page can be switched off but never added beyond the role. */
  grantable?: boolean
}

const SERVICE = ['workstation.service.read', 'workstation.service.manage']
const INVOICE = ['workstation.invoice.read', 'workstation.invoice.manage']
// IT / MCA worklists are compliance items.
const ANNUAL = [...SERVICE, 'workstation.compliance.read', 'workstation.compliance.manage']

export const PAGES: PageDef[] = [
  // Lead & Client
  { key: 'clients', block: 'lead_client', grant: ['workstation.client.read', 'workstation.client.manage'] },
  { key: 'leads', block: 'lead_client', perms: ['workstation.lead.'] },
  { key: 'follow_ups', block: 'lead_client', api: ['/api/follow-ups'], grant: ['workstation.followup.'] },
  { key: 'documents', block: 'lead_client', perms: ['workstation.document.'] },
  { key: 'calendar', block: 'lead_client', grant: ['workstation.followup.read'] },
  // Office files
  { key: 'quotations', block: 'office_files', perms: ['workstation.quotation.'] },
  { key: 'engagement_letters', block: 'office_files', perms: ['workstation.engagement.'] },
  { key: 'invoices', block: 'office_files', grant: INVOICE },
  { key: 'recurring_invoices', block: 'office_files', api: ['/api/recurring-invoices'], grant: INVOICE },
  { key: 'credit_notes', block: 'office_files', api: ['/api/credit-notes'], grant: INVOICE },
  { key: 'receivables', block: 'office_files', perms: ['payment_summary.'] },
  // Official docs
  { key: 'sales_register', block: 'official_docs', grant: ['workstation.invoice.read'] },
  { key: 'payroll_expenses', block: 'official_docs',
    // The firm's payroll and expense books; the person's own payslips and
    // expense claims (payroll.view.own, expense.submit) stay.
    perms: ['payroll.view', 'payroll.run', 'payroll.review', 'payroll.approve', 'payroll.process', 'salary.manage',
      'accounts.', 'payments.manage', 'expense.approve', 'expense.pay', 'expense.manage'],
    grant: ['accounts.read', 'payroll.view', 'expense.approve'] },
  { key: 'finance_mis', block: 'official_docs', perms: ['reports.'], api: ['/api/reports'], grant: ['reports.finance', 'reports.hr'] },
  { key: 'employee_records', block: 'official_docs', grant: ['document.read'] },
  { key: 'attendance', block: 'official_docs', grant: ['attendance.read'] },
  { key: 'audit_trail', block: 'official_docs', perms: ['audit.read.'] },
  // Workstation
  { key: 'ws_overview', block: 'workstation', grant: ['workstation.access'] },
  { key: 'tasks', block: 'workstation', perms: ['workstation.task.'] },
  { key: 'registration', block: 'workstation', api: ['/api/registrations', '/api/partnership', '/api/gst-registration'], grant: SERVICE },
  { key: 'gst_filing', block: 'workstation', perms: ['workstation.gst.'], api: ['/api/gstr1', '/api/gstr2b', '/api/gstr3b', '/api/gst-portal'],
    grant: [...SERVICE, 'workstation.gst.read', 'workstation.gst.manage', 'workstation.gst.portal.view'] },
  { key: 'tds_filing', block: 'workstation', perms: ['workstation.tds.'], api: ['/api/tds', '/api/tds-portal'], grant: [...SERVICE, 'workstation.tds.portal.view'] },
  { key: 'it_filing', block: 'workstation', grant: ANNUAL },
  { key: 'it_26as', block: 'workstation', api: ['/api/tds-recon'], grant: SERVICE },
  { key: 'it_ais', block: 'workstation', grant: SERVICE },
  // MCA forms: compliance items on their own worklists (shared API).
  { key: 'mca_llp', block: 'workstation', grant: ANNUAL },
  { key: 'mca_company', block: 'workstation', grant: ANNUAL },
  { key: 'eway_bill', block: 'workstation', perms: ['workstation.eway.'] },
  { key: 'notice_reply', block: 'workstation', perms: ['workstation.notice.'] },
  { key: 'dsc_register', block: 'workstation', perms: ['workstation.dsc.'] },
  { key: 'data_entry', block: 'workstation', api: ['/api/bookkeeping'], grant: SERVICE },
  { key: 'tally_export', block: 'workstation', api: ['/api/tally-export'], grant: SERVICE },
  // Adding Zoho Books gives view only; editing a client's real books stays with the role.
  { key: 'zoho_books', block: 'workstation', perms: ['books.'], grant: ['books.access', 'books.reports'] },
  { key: 'audit_section', block: 'workstation', perms: ['workstation.audit.'] },
  { key: 'compliance_calendar', block: 'workstation', perms: ['workstation.compliance.'] },
  { key: 'document_formats', block: 'workstation', perms: ['workstation.doc.'] },
  // HR & Admin
  { key: 'employees', block: 'hr_admin', grant: ['employee.read'] },
  { key: 'leave', block: 'hr_admin', grant: ['leave.read'] },
  { key: 'messages', block: 'hr_admin', perms: ['chat.'], grant: ['chat.participate'] },
  { key: 'articleship', block: 'hr_admin', api: ['/api/articleship'], grant: ['employee.read'] },
  { key: 'settings', block: 'hr_admin', perms: ['settings.manage'], grantable: false },
  // Tools
  { key: 'tools', block: 'tools', api: ['/api/tools', '/api/tool-jobs', '/api/tool-documents'], grant: ['tools.'], grantExcept: ['tools.audit_automation.'] },
  { key: 'repotic', block: 'tools', perms: ['tools.audit_automation.'] },
  { key: 'integrations', block: 'tools', perms: ['integrations.'] },
]

export const PAGE_KEYS: string[] = PAGES.map((p) => p.key)
const BY_KEY = new Map(PAGES.map((p) => [p.key, p]))

const matchesPerm = (code: string, entry: string) => (entry.endsWith('.') ? code.startsWith(entry) : code === entry)

/** Codes a page adds when switched ON beyond the role. Never tier or Settings codes. */
export function grantCodes(key: string): string[] {
  const page = BY_KEY.get(key)
  if (!page || page.grantable === false) return []
  const entries = page.grant ?? page.perms ?? []
  const codes = ALL_PERMISSION_CODES.filter((c) =>
    entries.some((e) => matchesPerm(c, e))
    && !(page.grantExcept ?? []).some((e) => matchesPerm(c, e))
    && !['approvals', 'partner', 'books_edit'].includes(moduleOf(c))
    && c !== 'settings.manage')
  // Every Workstation screen sits behind workstation.access.
  if (codes.some((c) => c.startsWith('workstation.')) && !codes.includes('workstation.access')) codes.push('workstation.access')
  return codes
}

export const GRANTABLE_PAGE_KEYS: string[] = PAGE_KEYS.filter((k) => grantCodes(k).length > 0)

/** Keep only known keys, once each, in catalogue order. */
export function cleanHiddenPages(keys: readonly string[] | null | undefined): string[] {
  const set = new Set(keys ?? [])
  return PAGE_KEYS.filter((k) => set.has(k))
}

/** Known, grantable keys not also switched off, in catalogue order. */
export function cleanExtraPages(keys: readonly string[] | null | undefined, hidden: readonly string[] = []): string[] {
  const set = new Set(keys ?? [])
  return GRANTABLE_PAGE_KEYS.filter((k) => set.has(k) && !hidden.includes(k))
}

/** Take the families of switched-off pages out of a list of grants. */
export function effectiveGrants<G extends { permission: string }>(grants: G[], hidden: readonly string[]): G[] {
  const entries = hidden.flatMap((k) => BY_KEY.get(k)?.perms ?? [])
  if (!entries.length) return grants
  return grants.filter((g) => !entries.some((e) => matchesPerm(g.permission, e)))
}

/**
 * The grants a login holds: its role's, plus the codes of pages switched on
 * for it, less the families of pages switched off for it.
 */
export function loginGrants(
  roleCode: string,
  roleGrants: { permission: string; scope: Scope }[],
  hidden: readonly string[],
  extra: readonly string[],
): { permission: string; scope: Scope }[] {
  const held = new Set(roleGrants.map((g) => g.permission))
  const added = cleanExtraPages(extra, hidden).flatMap(grantCodes)
    .filter((c, i, all) => !held.has(c) && all.indexOf(c) === i)
    .map((permission) => ({ permission, scope: scopeFor(roleCode as RoleCode, permission) }))
  return effectiveGrants([...roleGrants, ...added], hidden)
}

/** The switched-off page that owns this API path, if any. */
export function hiddenPageForPath(path: string, hidden: readonly string[]): string | null {
  for (const k of hidden) {
    for (const prefix of BY_KEY.get(k)?.api ?? []) {
      if (path === prefix || path.startsWith(prefix + '/')) return k
    }
  }
  return null
}
