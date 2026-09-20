/**
 * The GST master catalogue, as data.
 *
 * These are the same eleven services the Workstation → Services → GST page
 * lists (src/pages/workstation/gst/services.ts) plus the twelve default
 * categories. They are SEEDED, not hard-coded behaviour: `ensureCatalog()`
 * upserts them by slug/name once per organisation, after which a user can add
 * categories and services of their own and nothing here overwrites them.
 *
 * Seeding rather than reading the frontend file keeps the master catalogue a
 * database table, which is what lets §6's "also add this to GST Master
 * Services" work at all.
 */

export const CHECKLIST_KINDS = ['gst'] as const
export type ChecklistKind = (typeof CHECKLIST_KINDS)[number]

export const FREQUENCIES = ['one-time', 'monthly', 'quarterly', 'annual', 'event-based'] as const
export const SERVICE_TYPES = ['recurring', 'project', 'externally-triggered', 'retainer'] as const

/** Stored statuses. 'overdue' is derived on read and is deliberately absent. */
export const CHECKLIST_STATUSES = ['not_started', 'in_progress', 'pending', 'completed', 'not_required'] as const
export type ChecklistStatus = (typeof CHECKLIST_STATUSES)[number]

export const DEFAULT_CATEGORIES: { name: string; description: string }[] = [
  { name: 'GST Registration', description: 'Getting a GSTIN and everything that follows from it.' },
  { name: 'GST Returns', description: 'Periodic returns — GSTR-1, 3B, CMP-08.' },
  { name: 'GST Annual Returns', description: 'GSTR-9 and the 9C reconciliation statement.' },
  { name: 'GST Notices', description: 'Departmental notices and their replies.' },
  { name: 'GST Amendments', description: 'Changes to registration particulars.' },
  { name: 'GST Cancellation', description: 'Surrender, cancellation and revocation.' },
  { name: 'GST Refunds', description: 'Refund claims under RFD-01.' },
  { name: 'GST E-Invoice', description: 'IRN generation and e-invoicing support.' },
  { name: 'GST E-Way Bill', description: 'E-way bill generation and monitoring.' },
  { name: 'GST LUT', description: 'Letter of undertaking for zero-rated supply.' },
  { name: 'GST Appeals', description: 'Appeals against orders.' },
  { name: 'Other GST Services', description: 'Anything GST that does not fit the categories above.' },
]

export const DEFAULT_SERVICES: {
  slug: string
  name: string
  code: string | null
  category: string
  serviceType: (typeof SERVICE_TYPES)[number]
  defaultFrequency: (typeof FREQUENCIES)[number]
  description: string
}[] = [
  { slug: 'registration', name: 'Registration', code: 'REG-01', category: 'GST Registration', serviceType: 'project', defaultFrequency: 'one-time', description: 'Obtain a GSTIN — REG-01 through to the REG-06 certificate.' },
  { slug: 'return-filing', name: 'Return Filing', code: 'GSTR-1 / 3B / CMP-08', category: 'GST Returns', serviceType: 'recurring', defaultFrequency: 'monthly', description: 'Periodic outward-supply and summary returns.' },
  { slug: 'annual-return', name: 'Annual Return Filing', code: 'GSTR-9 / 9C', category: 'GST Annual Returns', serviceType: 'recurring', defaultFrequency: 'annual', description: 'Annual return and, above the threshold, the 9C reconciliation.' },
  { slug: 'notice-reply', name: 'Notice Reply', code: null, category: 'GST Notices', serviceType: 'externally-triggered', defaultFrequency: 'event-based', description: 'Reply to a departmental notice inside its window.' },
  { slug: 'amendment', name: 'Amendment', code: 'REG-14', category: 'GST Amendments', serviceType: 'project', defaultFrequency: 'event-based', description: 'Amend registration particulars.' },
  { slug: 'cancellation', name: 'Cancellation', code: 'REG-16', category: 'GST Cancellation', serviceType: 'project', defaultFrequency: 'one-time', description: 'Surrender or cancel a registration, and revoke if needed.' },
  { slug: 'lut-filing', name: 'LUT Filing', code: 'RFD-11', category: 'GST LUT', serviceType: 'recurring', defaultFrequency: 'annual', description: 'Letter of undertaking, renewed each financial year.' },
  { slug: 'e-invoicing', name: 'E-Invoicing Support', code: null, category: 'GST E-Invoice', serviceType: 'retainer', defaultFrequency: 'monthly', description: 'IRN generation support and e-invoice monitoring.' },
  { slug: 'refund', name: 'Refund', code: 'RFD-01', category: 'GST Refunds', serviceType: 'project', defaultFrequency: 'event-based', description: 'Refund claim and its follow-through.' },
  { slug: 'appeal', name: 'Appeal', code: 'APL-01', category: 'GST Appeals', serviceType: 'externally-triggered', defaultFrequency: 'event-based', description: 'Appeal against an order within the limitation period.' },
  { slug: 'composition', name: 'Composition Scheme Opt-in', code: 'CMP-02', category: 'Other GST Services', serviceType: 'recurring', defaultFrequency: 'annual', description: 'Opt into the composition scheme for a financial year.' },
]
