/**
 * BOOKKEEPING SERVICE — vocabulary and validators.
 *
 * Status sets are plain string unions kept here rather than Prisma enums,
 * matching every other module in this schema (ClientService, Task, FollowUp
 * all do the same), so a new status is a one-line change and never a
 * migration.
 */
export const ENGAGEMENT_STATUSES = ['active', 'on_hold', 'completed', 'cancelled'] as const
export const BILLING_FREQUENCIES = ['monthly', 'quarterly', 'annual'] as const

export const PERIOD_STATUSES = [
  'not_started', 'in_progress', 'awaiting_documents', 'under_review', 'completed', 'blocked',
] as const

/**
 * @deprecated Reads only. The checklist is now a rendering of tasks grouped
 * by stage — see WORKFLOW_STAGES below. Left in place for one release so
 * legacy API responses do not crash old clients.
 */
export const CHECKLIST_STATUSES = [
  'pending', 'in_progress', 'completed', 'blocked', 'not_applicable',
] as const

export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'] as const
export const TASK_CATEGORIES = [
  'data_collection', 'sales', 'purchases', 'expenses', 'banking',
  'reconciliation', 'review', 'client_communication', 'reporting', 'other',
] as const

export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const

export const PENDING_STATUSES = [
  'requested', 'partially_received', 'received', 'under_review', 'resolved', 'overdue',
] as const
export const PENDING_CATEGORIES = [
  'bank_statement', 'sales_data', 'purchase_bills', 'expense_documents',
  'payment_details', 'other',
] as const

export const DOCREQ_STATUSES = ['requested', 'received', 'under_review', 'accepted', 'rejected'] as const
export const DOCUMENT_TYPES = [
  'bank_statement', 'purchase_bills', 'sales_register', 'expense_documents',
  'payment_proof', 'other',
] as const

export const DELIVERABLE_STATUSES = ['draft', 'in_review', 'approved', 'delivered'] as const
export const DELIVERABLE_TYPES = [
  'monthly_books', 'financial_report', 'bank_reconciliation', 'ledger',
  'trial_balance', 'profit_and_loss', 'balance_sheet', 'other',
] as const

/**
 * The canonical monthly workflow. Each entry becomes one BookkeepingTask on
 * every period; the "checklist" and "workflow panel" in the UI are just two
 * renderings of these rows grouped by stage. Ordering is the sequence a firm
 * actually works the month in.
 *
 * `defaultOffsetDays` is the number of days AFTER period end at which a
 * seeded task defaults to due — collection early, review late. The auto due
 * date generator arrives in PR-2; today the field is captured but tasks are
 * seeded with a null due date and the user still supplies it manually.
 */
export interface WorkflowStageSpec {
  readonly sequence: number
  readonly name: string
  readonly slug: string
  readonly defaultCategory: string
  readonly defaultOffsetDays: number
  readonly gateRuleSlug: string | null
}

export const WORKFLOW_STAGES: readonly WorkflowStageSpec[] = [
  { sequence: 1, name: 'Collect Documents', slug: 'collect_docs', defaultCategory: 'data_collection', defaultOffsetDays: 0, gateRuleSlug: null },
  { sequence: 2, name: 'Collect Bank Statement', slug: 'collect_bank', defaultCategory: 'data_collection', defaultOffsetDays: 0, gateRuleSlug: 'has_bank_statement_document' },
  { sequence: 3, name: 'Record Sales', slug: 'record_sales', defaultCategory: 'sales', defaultOffsetDays: 3, gateRuleSlug: null },
  { sequence: 4, name: 'Record Purchases', slug: 'record_purchases', defaultCategory: 'purchases', defaultOffsetDays: 3, gateRuleSlug: null },
  { sequence: 5, name: 'Record Expenses', slug: 'record_expenses', defaultCategory: 'expenses', defaultOffsetDays: 3, gateRuleSlug: null },
  { sequence: 6, name: 'Reconcile Bank', slug: 'reconcile_bank', defaultCategory: 'reconciliation', defaultOffsetDays: 5, gateRuleSlug: 'has_bank_statement_import' },
  { sequence: 7, name: 'Review Accounts', slug: 'review_accounts', defaultCategory: 'review', defaultOffsetDays: 5, gateRuleSlug: 'has_trial_balance_import' },
  { sequence: 8, name: 'Review Reports', slug: 'review_reports', defaultCategory: 'review', defaultOffsetDays: 5, gateRuleSlug: 'reports_generated' },
  { sequence: 9, name: 'Final Review', slug: 'final_review', defaultCategory: 'review', defaultOffsetDays: 5, gateRuleSlug: 'all_other_tasks_complete' },
] as const

/**
 * Maps every label the legacy checklist ever seeded to a workflow stage slug.
 * Used ONCE by the data migration in seed.ts; not read at runtime after that.
 * When multiple legacy items map to the same stage, the migration takes the
 * least-advanced status among them — a stage only counts as done when every
 * sub-item that fed it was done.
 */
export const CHECKLIST_LABEL_TO_STAGE_SLUG: Readonly<Record<string, string>> = {
  'Bank statement received': 'collect_bank',
  'Sales data received': 'collect_docs',
  'Purchase bills received': 'collect_docs',
  'Expense documents received': 'collect_docs',
  'Sales entered': 'record_sales',
  'Purchases entered': 'record_purchases',
  'Expenses entered': 'record_expenses',
  'Bank reconciled': 'reconcile_bank',
  'Accounts reviewed': 'review_accounts',
  'Reports reviewed': 'review_reports',
  'Client queries resolved': 'final_review',
  'Final review completed': 'final_review',
}

/**
 * @deprecated The 12-item checklist is legacy; new periods carry
 * WORKFLOW_STAGES tasks. Retained only for the migration script that
 * translates existing BookkeepingChecklistItem rows onto tasks.
 */
export const CHECKLIST_TEMPLATE: readonly string[] = [
  'Bank statement received',
  'Sales data received',
  'Purchase bills received',
  'Expense documents received',
  'Sales entered',
  'Purchases entered',
  'Expenses entered',
  'Bank reconciled',
  'Accounts reviewed',
  'Reports reviewed',
  'Client queries resolved',
  'Final review completed',
]

/**
 * @deprecated The old 10-item flat list; the new WORKFLOW_STAGES supersedes
 * this and carries slug, sequence, category, offset and gate rule per stage.
 * The exported string[] view is kept for the /settings endpoint's legacy
 * consumers until every caller reads workflow_stages instead.
 */
export const WORKFLOW_STEPS: readonly string[] = WORKFLOW_STAGES.map((s) => s.name)

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** Three-letter abbreviations, used for the compact period-grid header. */
export const MONTH_ABBREVS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

export const periodLabel = (year: number, month: number) => `${MONTH_NAMES[month - 1]} ${year}`

/**
 * Status merge for the checklist → task migration. When several legacy
 * checklist rows collapse into one stage task, the STAGE task is only
 * `completed` if every contributing row was completed; a single blocked row
 * turns the stage blocked; otherwise the least-advanced live status wins.
 * Cancelled has no equivalent on the checklist side and never appears here.
 */
export function mergeChecklistStatuses(statuses: readonly string[]): string {
  if (statuses.length === 0) return 'pending'
  if (statuses.some((s) => s === 'blocked')) return 'blocked'
  if (statuses.every((s) => s === 'completed')) return 'completed'
  if (statuses.every((s) => s === 'not_applicable')) return 'completed'
  if (statuses.some((s) => s === 'in_progress' || s === 'completed')) return 'in_progress'
  return 'pending'
}
