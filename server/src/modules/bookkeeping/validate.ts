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
 * The standard monthly checklist, copied into every new period. Kept in the
 * order the work is actually done so the list doubles as the month's script.
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

/** The ten-step monthly workflow shown on Monthly Work. */
export const WORKFLOW_STEPS: readonly string[] = [
  'Collect Documents', 'Collect Bank Statements', 'Record Sales', 'Record Purchases',
  'Record Expenses', 'Reconcile Bank', 'Review Accounts', 'Review Reports',
  'Final Review', 'Complete',
]

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export const periodLabel = (year: number, month: number) => `${MONTH_NAMES[month - 1]} ${year}`
