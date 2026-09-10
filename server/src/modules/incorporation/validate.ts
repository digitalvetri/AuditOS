import { ApiError } from '../../lib/http.js'

/**
 * INCORPORATION SERVICE — vocabulary, the stage machine and its validators.
 *
 * Status sets are plain string unions kept here rather than Prisma enums,
 * matching every other module in this schema (ClientService, Task, FollowUp
 * and all of Bookkeeping do the same), so adding a status is a one-line
 * change and never a migration. This file is the authority the `oneOf()`
 * validators check on every write — the doc comments in schema.prisma
 * describe these lists, they do not enforce them.
 */

// ── Case ──────────────────────────────────────────────────────────────────
/** The 20 stages, in workflow order. */
export const STAGES = [
  'new',
  'information_collection',
  'documents_pending',
  'dsc_pending',
  'name_preparation',
  'name_submitted',
  'name_approved',
  'name_rework',
  'filing_preparation',
  'filing_submitted',
  'government_processing',
  'government_query',
  'resubmission',
  'approved',
  'certificate_received',
  'post_registration_setup',
  'post_incorporation_handover',
  'completed',
  'on_hold',
  'cancelled',
] as const
export type Stage = (typeof STAGES)[number]

export const STAGE_LABELS: Record<Stage, string> = {
  new: 'New',
  information_collection: 'Information Collection',
  documents_pending: 'Documents Pending',
  dsc_pending: 'DSC Pending',
  name_preparation: 'Name Preparation',
  name_submitted: 'Name Submitted',
  name_approved: 'Name Approved',
  name_rework: 'Name Rework',
  filing_preparation: 'Filing Preparation',
  filing_submitted: 'Filing Submitted',
  government_processing: 'Government Processing',
  government_query: 'Government Query',
  resubmission: 'Resubmission',
  approved: 'Approved',
  certificate_received: 'Certificate Received',
  post_registration_setup: 'Post-Registration Setup',
  post_incorporation_handover: 'Post-Incorporation Handover',
  completed: 'Completed',
  on_hold: 'On Hold',
  cancelled: 'Cancelled',
}

/** Stages a case can be parked from, and returned to. */
const TERMINAL: Stage[] = ['completed', 'cancelled']

/**
 * The forward transition table (§4.3). `on_hold` and `cancelled` are reachable
 * from anything that has not finished, so they are added by `allowedNext()`
 * rather than repeated on twenty rows.
 */
const FORWARD: Record<Stage, Stage[]> = {
  new: ['information_collection'],
  information_collection: ['documents_pending'],
  documents_pending: ['dsc_pending', 'name_preparation'],
  dsc_pending: ['name_preparation'],
  name_preparation: ['name_submitted'],
  name_submitted: ['name_approved', 'name_rework'],
  name_rework: ['name_preparation', 'name_submitted'],
  name_approved: ['filing_preparation'],
  filing_preparation: ['filing_submitted'],
  filing_submitted: ['government_processing'],
  government_processing: ['government_query', 'approved'],
  government_query: ['resubmission'],
  resubmission: ['government_processing'],
  approved: ['certificate_received'],
  certificate_received: ['post_registration_setup', 'post_incorporation_handover'],
  post_registration_setup: ['post_incorporation_handover'],
  post_incorporation_handover: ['completed'],
  completed: [],
  // A held case returns to the stage it was held FROM — resolved from the
  // row's heldFromStage, so it is not in this static table.
  on_hold: [],
  cancelled: [],
}

/**
 * What the server will accept next from `stage`. The UI renders exactly this
 * list and nothing else, so a control can never offer a move the server would
 * refuse.
 */
export function allowedNext(stage: string, heldFromStage: string | null): Stage[] {
  const s = stage as Stage
  if (s === 'on_hold') {
    // Resume, plus the two exits that are always available.
    const back = (heldFromStage as Stage | null) ?? 'new'
    return Array.from(new Set<Stage>([back, 'cancelled']))
  }
  const next = [...(FORWARD[s] ?? [])]
  if (!TERMINAL.includes(s)) next.push('on_hold', 'cancelled')
  return Array.from(new Set(next))
}

/**
 * WORKFLOW ORDER — the stages that form the forward line. `on_hold` and
 * `cancelled` are parking states, not points on it, so they sit outside.
 */
const WORKFLOW_ORDER: Stage[] = STAGES.filter(
  (s) => s !== 'on_hold' && s !== 'cancelled',
) as Stage[]

const ordinal = (s: string) => WORKFLOW_ORDER.indexOf(s as Stage)

/**
 * A move to an EARLIER stage on the workflow line. Permitted only for an
 * elevated caller, only with a reason, and logged as a distinct action.
 *
 * This is deliberately NOT "anything the forward table rejects". Skipping
 * ahead — say New straight to Certificate Received — is also outside the
 * table, but it is not a reversal: it is an illegal jump, and no reason makes
 * it legal. Conflating the two would let an elevated caller type a sentence
 * and skip the whole workflow.
 */
export function isBackwardMove(from: string, to: string): boolean {
  if (from === to) return false
  // Parking and un-parking are governed by the transition table, not by order.
  if (to === 'on_hold' || to === 'cancelled' || from === 'on_hold') return false
  // The TABLE WINS. Several legitimate moves run backwards along the line —
  // Name Rework returns to Name Submitted, Resubmission returns to Government
  // Processing — and those are ordinary progress, not reversals to be gated
  // behind an elevated role and a written reason.
  if (allowedNext(from, null).includes(to as Stage)) return false
  const a = ordinal(from)
  const b = ordinal(to)
  if (a < 0 || b < 0) return false
  return b < a
}

export function assertStageTransition(from: string, to: string, heldFromStage: string | null): void {
  if (from === to) {
    throw ApiError.unprocessable('invalid_transition', 'The case is already at that stage.', { from, to })
  }
  const allowed = allowedNext(from, heldFromStage)
  if (!allowed.includes(to as Stage)) {
    throw ApiError.unprocessable(
      'invalid_transition',
      `A case cannot move from "${STAGE_LABELS[from as Stage] ?? from}" to "${STAGE_LABELS[to as Stage] ?? to}".`,
      { from, to, allowed },
    )
  }
}

export const CASE_STATUSES = ['active', 'on_hold', 'completed', 'cancelled'] as const

/**
 * The PLATFORM priority vocabulary, reused rather than re-declared — Task,
 * BookkeepingTask and BookkeepingPendingItem all speak these four words.
 */
export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const

/** The case status implied by a stage. Derived, never sent up by a client. */
export function statusForStage(stage: string): string {
  if (stage === 'completed') return 'completed'
  if (stage === 'cancelled') return 'cancelled'
  if (stage === 'on_hold') return 'on_hold'
  return 'active'
}

// ── Entity types ──────────────────────────────────────────────────────────
export const PARTY_ROLES = [
  'promoter', 'director', 'shareholder', 'partner', 'designated_partner',
  'proprietor', 'authorized_person', 'nominee', 'other',
] as const

export const PARTY_ROLE_LABELS: Record<string, string> = {
  promoter: 'Promoter',
  director: 'Director',
  shareholder: 'Shareholder',
  partner: 'Partner',
  designated_partner: 'Designated Partner',
  proprietor: 'Proprietor',
  authorized_person: 'Authorized Person',
  nominee: 'Nominee',
  other: 'Other',
}

/**
 * Seeded entity types. These are DATA — Settings edits them, and adding
 * "Section 8 Company" never touches a component. The roles differ per type on
 * purpose: an LLP has designated partners, a proprietorship has a proprietor.
 */
export const ENTITY_TYPE_SEED: {
  code: string; name: string; description: string
  roles: string[]; minParties: number; maxParties: number | null; targetDays: number
}[] = [
  {
    code: 'PVT_LTD', name: 'Private Limited Company',
    description: 'Company limited by shares with two or more members.',
    roles: ['promoter', 'director', 'shareholder', 'authorized_person'],
    minParties: 2, maxParties: null, targetDays: 30,
  },
  {
    code: 'OPC', name: 'One Person Company',
    description: 'Single-member company. A nominee is recorded alongside the sole member.',
    roles: ['promoter', 'director', 'nominee', 'authorized_person'],
    minParties: 1, maxParties: 3, targetDays: 25,
  },
  {
    code: 'LLP', name: 'Limited Liability Partnership',
    description: 'Partnership with limited liability; partners and designated partners.',
    roles: ['partner', 'designated_partner', 'authorized_person'],
    minParties: 2, maxParties: null, targetDays: 35,
  },
  {
    code: 'PARTNERSHIP', name: 'Partnership Firm',
    description: 'Firm constituted by a partnership deed.',
    roles: ['partner', 'authorized_person'],
    minParties: 2, maxParties: null, targetDays: 20,
  },
  {
    code: 'PROPRIETORSHIP', name: 'Proprietorship',
    description: 'Single proprietor trading in their own name.',
    roles: ['proprietor', 'authorized_person'],
    minParties: 1, maxParties: 2, targetDays: 15,
  },
  {
    code: 'OTHER', name: 'Other / Custom',
    description: 'Any other entity type. Roles and checklist are set per case.',
    roles: ['promoter', 'director', 'partner', 'designated_partner', 'proprietor', 'authorized_person', 'nominee', 'other'],
    minParties: 1, maxParties: null, targetDays: 30,
  },
]

export function rolesOf(entityType: { partyRolesJson: string }): string[] {
  try {
    const parsed: unknown = JSON.parse(entityType.partyRolesJson)
    if (Array.isArray(parsed)) return parsed.filter((r): r is string => typeof r === 'string')
  } catch {
    // A malformed row must not take down the case it belongs to.
  }
  return [...PARTY_ROLES]
}

// ── Item vocabularies ─────────────────────────────────────────────────────
export const CHECKLIST_STATUSES = [
  'pending', 'in_progress', 'completed', 'blocked', 'not_applicable',
] as const

export const CHECKLIST_CATEGORIES = [
  'client', 'people', 'documents', 'dsc', 'name', 'filing', 'government', 'completion',
] as const

export const DOCREQ_STATUSES = [
  'required', 'requested', 'received', 'under_review', 'approved', 'rejected', 'not_applicable',
] as const

export const DOC_CATEGORIES = [
  'identity_kyc', 'address_proof', 'registered_office', 'party', 'dsc',
  'name_application', 'government_filing', 'government_query', 'certificate',
  'pan_tan', 'other',
] as const

export const DSC_STATUSES = [
  'not_required', 'pending', 'requested', 'received', 'verified', 'expired', 'issue',
] as const

export const NAME_STATUSES = [
  'draft', 'ready', 'submitted', 'approved', 'rejected', 'rework', 'other',
] as const

export const FILING_STATUSES = [
  'not_started', 'preparing', 'ready_for_review', 'submitted', 'processing',
  'query', 'resubmission', 'approved', 'rejected', 'closed',
] as const

export const FILING_TYPES = [
  'spice_plus_part_a', 'spice_plus_part_b', 'agile_pro', 'inc_9', 'fillip',
  'run_llp', 'llp_agreement', 'pan_tan', 'other',
] as const

export const QUERY_STATUSES = [
  'new', 'assigned', 'preparing_response', 'ready', 'submitted', 'resolved', 'escalated',
] as const

export const DELIVERABLE_STATUSES = ['pending', 'prepared', 'delivered'] as const

export const DELIVERABLE_TYPES = [
  'certificate_of_incorporation', 'pan', 'tan', 'din', 'moa', 'aoa',
  'llp_agreement', 'acknowledgement', 'other',
] as const

export const FEE_CATEGORIES = [
  'professional_fee', 'government_fee', 'dsc_fee', 'stamp_duty', 'other',
] as const

export const FEE_STATUSES = ['pending', 'invoiced', 'partly_paid', 'paid', 'waived'] as const

/** A query is overdue when its due date has passed and it is not resolved. */
export function isQueryOverdue(
  q: { responseDueDate: string | null; status: string },
  asOf: string,
): boolean {
  if (!q.responseDueDate) return false
  if (q.status === 'resolved') return false
  return q.responseDueDate < asOf
}

// ── Checklist template ────────────────────────────────────────────────────
/**
 * THE BASELINE CHECKLIST (§4.6). Instantiated onto every case at creation,
 * in the order the work is actually done, so the list doubles as the script
 * for the engagement. Entity-type-specific rows are added on top of these in
 * Settings; nothing here is hardcoded into a component.
 *
 * Every label is phrased as SOMETHING AN EMPLOYEE DID. "Name status updated",
 * never "name approved by MCA" — this system records our work, not the
 * government's.
 */
export const CHECKLIST_TEMPLATE: {
  category: string; label: string; stage: string | null; documentCategory?: string
}[] = [
  { category: 'client', label: 'Client confirmed', stage: 'information_collection' },
  { category: 'client', label: 'Entity type confirmed', stage: 'information_collection' },
  { category: 'client', label: 'Business activity confirmed', stage: 'information_collection' },
  { category: 'client', label: 'Proposed name collected', stage: 'information_collection' },
  { category: 'client', label: 'Registered office information collected', stage: 'information_collection' },

  { category: 'people', label: 'Required person information received', stage: 'information_collection' },
  { category: 'people', label: 'Identification information received', stage: 'documents_pending' },
  { category: 'people', label: 'Address information received', stage: 'documents_pending' },

  { category: 'documents', label: 'Documents requested', stage: 'documents_pending', documentCategory: 'identity_kyc' },
  { category: 'documents', label: 'Documents received', stage: 'documents_pending' },
  { category: 'documents', label: 'Documents reviewed', stage: 'documents_pending' },
  { category: 'documents', label: 'Missing documents resolved', stage: 'documents_pending' },

  { category: 'dsc', label: 'DSC requirement checked', stage: 'dsc_pending' },
  { category: 'dsc', label: 'DSC requested', stage: 'dsc_pending' },
  { category: 'dsc', label: 'DSC received', stage: 'dsc_pending' },
  { category: 'dsc', label: 'DSC verified by employee', stage: 'dsc_pending' },

  { category: 'name', label: 'Name options prepared', stage: 'name_preparation' },
  { category: 'name', label: 'Name reviewed', stage: 'name_preparation' },
  { category: 'name', label: 'Name submitted', stage: 'name_submitted' },
  { category: 'name', label: 'Name status updated', stage: 'name_submitted' },

  { category: 'filing', label: 'Forms and documents prepared', stage: 'filing_preparation' },
  { category: 'filing', label: 'Professional review completed', stage: 'filing_preparation' },
  { category: 'filing', label: 'Filing submitted', stage: 'filing_submitted' },
  { category: 'filing', label: 'Reference recorded', stage: 'filing_submitted' },

  { category: 'government', label: 'Processing monitored', stage: 'government_processing' },
  { category: 'government', label: 'Query recorded', stage: 'government_query' },
  { category: 'government', label: 'Response prepared', stage: 'government_query' },
  { category: 'government', label: 'Response submitted', stage: 'resubmission' },
  { category: 'government', label: 'Resubmission recorded', stage: 'resubmission' },

  { category: 'completion', label: 'Approval recorded', stage: 'approved' },
  { category: 'completion', label: 'Certificate received', stage: 'certificate_received' },
  { category: 'completion', label: 'Final documents uploaded', stage: 'certificate_received', documentCategory: 'certificate' },
  { category: 'completion', label: 'Client notified', stage: 'post_incorporation_handover' },
  { category: 'completion', label: 'Handover completed', stage: 'post_incorporation_handover' },
]

/**
 * POST-INCORPORATION HANDOVER (§7.1). Every line is phrased "where
 * applicable" / "identified if needed" — this module never asserts that a
 * registration is legally required. That is a professional judgement an
 * employee makes, and the checklist records the judgement, not a rule.
 */
export const HANDOVER_CHECKLIST: readonly string[] = [
  'Approval recorded',
  'Certificate received',
  'PAN / TAN received, where applicable',
  'Final documents uploaded',
  'Client notified',
  'Accounting / Books setup identified if needed',
  'GST service identified if needed',
  'TDS service identified if needed',
  'Other services identified if needed',
  'Follow-up created',
  'Handover completed',
  'Case closed',
]

/**
 * One-click task templates (§7). Each creates a row in the EXISTING Task
 * model, linked to the case — there is no second task engine here.
 */
export const TASK_TEMPLATES: { key: string; title: string; dueInDays: number }[] = [
  { key: 'request_documents', title: 'Request documents from client', dueInDays: 3 },
  { key: 'verify_documents', title: 'Verify documents received', dueInDays: 5 },
  { key: 'prepare_filing', title: 'Prepare filing', dueInDays: 7 },
  { key: 'review_application', title: 'Review application before submission', dueInDays: 7 },
  { key: 'contact_client', title: 'Contact client', dueInDays: 2 },
  { key: 'track_dsc', title: 'Track DSC', dueInDays: 5 },
  { key: 'respond_to_query', title: 'Respond to government query', dueInDays: 5 },
  { key: 'upload_certificate', title: 'Upload certificate', dueInDays: 3 },
  { key: 'prepare_handover', title: 'Prepare handover', dueInDays: 5 },
]

/** The existing Task vocabulary — open | in_progress | blocked | done. */
export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done'] as const
