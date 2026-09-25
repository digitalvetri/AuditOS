/**
 * Every Zoho Books resource the Books tool exposes, as data. The routes are
 * generic over this table, so adding a resource is a row here — not a new
 * router, auth path or error handler.
 *
 * Only endpoints documented in the Zoho Books v3 API are listed. Anything
 * Zoho does not expose (statement reconciliation, official P&L, …) is left
 * out and the UI says it is unavailable.
 */
import type { PermissionCode } from '../../platform/rbac/matrix.js'

export interface ActionDef {
  method: 'POST' | 'PUT'
  /** Path under the resource, after `/{path}/{id}` — e.g. 'status/sent'. */
  sub: string
  perm: PermissionCode
  /** Whether the client's JSON body is forwarded to Zoho. */
  body?: boolean
  /** Override of the resource root for this action (bank uncategorised transactions). */
  root?: string
}

export interface EntityDef {
  path: string
  listKey: string
  key: string
  idField: string
  /** Fixed query on every list (contact_type=customer, …). */
  baseQuery?: Record<string, string>
  /** Fields forced onto every create body. */
  createDefaults?: Record<string, unknown>
  /** Query params the browser may pass through to the list call. */
  listParams: string[]
  create?: PermissionCode
  update?: PermissionCode
  remove?: PermissionCode
  pdf?: boolean
  /** Supports ignore_auto_number_generation when the user types a number. */
  numberField?: string
  actions?: Record<string, ActionDef>
}

const PAGING = ['page', 'per_page', 'sort_column', 'sort_order', 'search_text', 'filter_by']
const DATED = [...PAGING, 'date_start', 'date_end']
const M: PermissionCode = 'books.manage'
const A: PermissionCode = 'books.accountant'
const email: ActionDef = { method: 'POST', sub: 'email', perm: M, body: true }

export const ENTITIES: Record<string, EntityDef> = {
  customers: {
    path: 'contacts', listKey: 'contacts', key: 'contact', idField: 'contact_id',
    baseQuery: { contact_type: 'customer' }, createDefaults: { contact_type: 'customer' },
    listParams: PAGING, create: M, update: M, remove: A,
    actions: { active: { method: 'POST', sub: 'active', perm: M }, inactive: { method: 'POST', sub: 'inactive', perm: M } },
  },
  vendors: {
    path: 'contacts', listKey: 'contacts', key: 'contact', idField: 'contact_id',
    baseQuery: { contact_type: 'vendor' }, createDefaults: { contact_type: 'vendor' },
    listParams: PAGING, create: M, update: M, remove: A,
    actions: { active: { method: 'POST', sub: 'active', perm: M }, inactive: { method: 'POST', sub: 'inactive', perm: M } },
  },
  items: {
    path: 'items', listKey: 'items', key: 'item', idField: 'item_id',
    listParams: PAGING, create: M, update: M, remove: A,
    actions: { active: { method: 'POST', sub: 'active', perm: M }, inactive: { method: 'POST', sub: 'inactive', perm: M } },
  },
  estimates: {
    path: 'estimates', listKey: 'estimates', key: 'estimate', idField: 'estimate_id',
    listParams: [...DATED, 'customer_id'], create: M, update: M, remove: A, pdf: true, numberField: 'estimate_number',
    actions: {
      sent: { method: 'POST', sub: 'status/sent', perm: M },
      accepted: { method: 'POST', sub: 'status/accepted', perm: M },
      declined: { method: 'POST', sub: 'status/declined', perm: M },
      email,
    },
  },
  salesorders: {
    path: 'salesorders', listKey: 'salesorders', key: 'salesorder', idField: 'salesorder_id',
    listParams: [...DATED, 'customer_id'], create: M, update: M, remove: A, pdf: true, numberField: 'salesorder_number',
    actions: { open: { method: 'POST', sub: 'status/open', perm: M }, void: { method: 'POST', sub: 'status/void', perm: A }, email },
  },
  invoices: {
    path: 'invoices', listKey: 'invoices', key: 'invoice', idField: 'invoice_id',
    listParams: [...DATED, 'customer_id'], create: M, update: M, remove: A, pdf: true, numberField: 'invoice_number',
    actions: {
      sent: { method: 'POST', sub: 'status/sent', perm: M },
      draft: { method: 'POST', sub: 'status/draft', perm: M },
      void: { method: 'POST', sub: 'status/void', perm: A },
      email,
    },
  },
  purchaseorders: {
    path: 'purchaseorders', listKey: 'purchaseorders', key: 'purchaseorder', idField: 'purchaseorder_id',
    listParams: [...DATED, 'vendor_id'], create: M, update: M, remove: A, pdf: true, numberField: 'purchaseorder_number',
    actions: {
      open: { method: 'POST', sub: 'status/open', perm: M },
      billed: { method: 'POST', sub: 'status/billed', perm: M },
      cancelled: { method: 'POST', sub: 'status/cancelled', perm: A },
      email,
    },
  },
  bills: {
    path: 'bills', listKey: 'bills', key: 'bill', idField: 'bill_id',
    listParams: [...DATED, 'vendor_id'], create: M, update: M, remove: A,
    actions: { open: { method: 'POST', sub: 'status/open', perm: M }, void: { method: 'POST', sub: 'status/void', perm: A } },
  },
  expenses: {
    path: 'expenses', listKey: 'expenses', key: 'expense', idField: 'expense_id',
    listParams: [...PAGING, 'customer_id', 'vendor_id'], create: M, update: M, remove: A,
  },
  customerpayments: {
    path: 'customerpayments', listKey: 'customerpayments', key: 'payment', idField: 'payment_id',
    listParams: [...PAGING, 'customer_id'], create: A, update: A, remove: A,
  },
  vendorpayments: {
    path: 'vendorpayments', listKey: 'vendorpayments', key: 'vendorpayment', idField: 'payment_id',
    listParams: [...PAGING, 'vendor_id'], create: A, update: A, remove: A,
  },
  creditnotes: {
    path: 'creditnotes', listKey: 'creditnotes', key: 'creditnote', idField: 'creditnote_id',
    listParams: [...DATED, 'customer_id'], create: M, update: M, remove: A, pdf: true, numberField: 'creditnote_number',
    actions: {
      open: { method: 'POST', sub: 'status/open', perm: M },
      void: { method: 'POST', sub: 'status/void', perm: A },
      apply: { method: 'POST', sub: 'invoices', perm: A, body: true },
      refund: { method: 'POST', sub: 'refunds', perm: A, body: true },
      email,
    },
  },
  // Purchase-side debit notes are "vendor credits" in the Zoho Books API.
  vendorcredits: {
    path: 'vendorcredits', listKey: 'vendor_credits', key: 'vendor_credit', idField: 'vendor_credit_id',
    listParams: [...DATED, 'vendor_id'], create: M, update: M, remove: A, numberField: 'vendor_credit_number',
    actions: {
      open: { method: 'POST', sub: 'status/open', perm: M },
      void: { method: 'POST', sub: 'status/void', perm: A },
      apply: { method: 'POST', sub: 'bills', perm: A, body: true },
      refund: { method: 'POST', sub: 'refunds', perm: A, body: true },
    },
  },
  bankaccounts: {
    path: 'bankaccounts', listKey: 'bankaccounts', key: 'bankaccount', idField: 'account_id',
    listParams: PAGING, create: A, update: A,
    actions: { active: { method: 'POST', sub: 'active', perm: A }, inactive: { method: 'POST', sub: 'inactive', perm: A } },
  },
  banktransactions: {
    path: 'banktransactions', listKey: 'banktransactions', key: 'banktransaction', idField: 'transaction_id',
    listParams: [...PAGING, 'account_id', 'date_start', 'date_end'], create: A, remove: A,
    actions: {
      uncategorize: { method: 'POST', sub: 'uncategorize', perm: A },
      unmatch: { method: 'POST', sub: 'unmatch', perm: A },
      match: { method: 'PUT', sub: 'match', perm: A, body: true, root: 'banktransactions/uncategorized' },
      categorize: { method: 'POST', sub: 'categorize', perm: A, body: true, root: 'banktransactions/uncategorized' },
      exclude: { method: 'POST', sub: 'exclude', perm: A, root: 'banktransactions/uncategorized' },
      restore: { method: 'POST', sub: 'restore', perm: A, root: 'banktransactions/uncategorized' },
    },
  },
  taxes: {
    path: 'settings/taxes', listKey: 'taxes', key: 'tax', idField: 'tax_id',
    listParams: PAGING, create: 'books.settings', update: 'books.settings', remove: 'books.settings',
  },
  accounts: {
    path: 'chartofaccounts', listKey: 'chartofaccounts', key: 'chart_of_account', idField: 'account_id',
    listParams: PAGING,
  },
}

/** Zoho ids are numeric strings; anything else never reaches a URL. */
export function isZohoId(v: unknown): v is string {
  return typeof v === 'string' && /^\d{1,40}$/.test(v)
}
