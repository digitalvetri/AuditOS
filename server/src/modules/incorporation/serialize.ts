import type {
  Client, ClientContact, IncorporationActivity, IncorporationCase,
  IncorporationChecklistItem, IncorporationChecklistTemplate, IncorporationDeliverable,
  IncorporationDocumentRequest, IncorporationDsc, IncorporationEntityType, IncorporationFee,
  IncorporationFiling, IncorporationName, IncorporationParty, IncorporationQuery, Task,
} from '@prisma/client'
import type { EmployeeLookup } from '../../api/workstation.serialize.js'
import { allowedNext, isQueryOverdue, rolesOf, STAGE_LABELS, type Stage } from './validate.js'
import { today } from './service.js'

/**
 * snake_case on the wire, camelCase in Prisma — the same split every other
 * module in this server uses, so the frontend needs no adapter.
 *
 * PROVENANCE. Every row that carries an externally-sourced fact serialises
 * `recorded_by` / `recorded_at` / `source` alongside the value, because the
 * UI is required to print "Recorded by <employee> · <date>" beside it. A
 * serializer that dropped these would let a screen show a government
 * reference number with nothing saying who typed it in.
 */
const ref = (m: EmployeeLookup, id: string | null | undefined) => (id ? m.get(id) ?? null : null)
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

const provenance = (
  r: { source: string; recordedByEmployeeId: string | null; recordedAt: Date },
  m: EmployeeLookup,
) => ({
  source: r.source,
  recorded_by: ref(m, r.recordedByEmployeeId),
  recorded_at: iso(r.recordedAt),
})

export const entityTypeToApi = (e: IncorporationEntityType, m: EmployeeLookup) => ({
  id: e.id,
  code: e.code,
  name: e.name,
  description: e.description,
  party_roles: rolesOf(e),
  min_parties: e.minParties,
  max_parties: e.maxParties,
  default_target_days: e.defaultTargetDays,
  default_assigned_employee: ref(m, e.defaultAssignedEmployeeId),
  default_assigned_employee_id: e.defaultAssignedEmployeeId,
  is_active: e.isActive,
  sort_order: e.sortOrder,
})

export const checklistTemplateToApi = (t: IncorporationChecklistTemplate) => ({
  id: t.id,
  entity_type_id: t.entityTypeId,
  category: t.category,
  label: t.label,
  sort_order: t.sortOrder,
  stage: t.stage,
  document_category: t.documentCategory,
  is_active: t.isActive,
})

export function caseToApi(
  c: IncorporationCase & {
    client?: Client | null
    entityType?: IncorporationEntityType | null
  },
  m: EmployeeLookup,
  extra?: {
    progress?: { total: number; completed: number; pending: number; blocked: number; percent: number }
    openQueries?: number
    pendingDocuments?: number
  },
) {
  return {
    id: c.id,
    case_code: c.caseCode,
    client_id: c.clientId,
    client_name: c.client?.companyName ?? null,
    client_code: c.client?.clientCode ?? null,
    entity_type_id: c.entityTypeId,
    entity_type_code: c.entityType?.code ?? null,
    entity_type_name: c.entityType?.name ?? null,
    client_service_id: c.clientServiceId,
    proposed_name: c.proposedName,
    alternate_name: c.alternateName,
    business_activity: c.businessActivity,
    business_category: c.businessCategory,
    state: c.state,
    city: c.city,
    registered_office_info: c.registeredOfficeInfo,
    incorporation_objective: c.incorporationObjective,
    stage: c.stage,
    stage_label: STAGE_LABELS[c.stage as Stage] ?? c.stage,
    held_from_stage: c.heldFromStage,
    /// Exactly what the server will accept next. The UI renders this list and
    /// nothing else, so a control can never offer a move that would be refused.
    allowed_next: allowedNext(c.stage, c.heldFromStage).map((s) => ({ stage: s, label: STAGE_LABELS[s] })),
    status: c.status,
    priority: c.priority,
    assigned_employee_id: c.assignedEmployeeId,
    assigned_employee: ref(m, c.assignedEmployeeId),
    target_date: c.targetDate,
    internal_notes: c.internalNotes,
    completed_at: iso(c.completedAt),
    cancelled_reason: c.cancelledReason,
    is_demo: c.isDemo,
    progress: extra?.progress ?? null,
    open_queries: extra?.openQueries ?? null,
    pending_documents: extra?.pendingDocuments ?? null,
    created_at: iso(c.createdAt),
    updated_at: iso(c.updatedAt),
  }
}

export const partyToApi = (
  p: IncorporationParty & { clientContact?: ClientContact | null },
) => ({
  id: p.id,
  case_id: p.caseId,
  role: p.role,
  name: p.name,
  contact_number: p.contactNumber,
  email: p.email,
  address: p.address,
  client_contact_id: p.clientContactId,
  client_contact: p.clientContact
    ? { id: p.clientContact.id, name: p.clientContact.name, designation: p.clientContact.designation }
    : null,
  dsc_required: p.dscRequired,
  sort_order: p.sortOrder,
  notes: p.notes,
})

export const checklistItemToApi = (c: IncorporationChecklistItem, m: EmployeeLookup) => ({
  id: c.id,
  case_id: c.caseId,
  category: c.category,
  label: c.label,
  status: c.status,
  sort_order: c.sortOrder,
  stage: c.stage,
  stage_label: c.stage ? STAGE_LABELS[c.stage as Stage] ?? c.stage : null,
  assigned_employee_id: c.assignedEmployeeId,
  assigned_employee: ref(m, c.assignedEmployeeId),
  due_date: c.dueDate,
  remarks: c.remarks,
  completed_at: iso(c.completedAt),
  completed_by: ref(m, c.completedByEmployeeId),
})

export const documentRequestToApi = (
  d: IncorporationDocumentRequest & {
    case?: (IncorporationCase & { client?: Client | null }) | null
    clientDocument?: { id: string; name: string; status: string; currentVersion: number } | null
  },
  m: EmployeeLookup,
) => ({
  id: d.id,
  case_id: d.caseId,
  case_code: d.case?.caseCode ?? null,
  client_id: d.clientId,
  client_name: d.case?.client?.companyName ?? null,
  party_id: d.partyId,
  category: d.category,
  document_type: d.documentType,
  description: d.description,
  status: d.status,
  requested_by: ref(m, d.requestedByEmployeeId),
  requested_at: iso(d.requestedAt),
  due_date: d.dueDate,
  received_at: iso(d.receivedAt),
  reviewed_by: ref(m, d.reviewedByEmployeeId),
  rejection_reason: d.rejectionReason,
  client_document_id: d.clientDocumentId,
  client_document: d.clientDocument ?? null,
  created_at: iso(d.createdAt),
})

export const dscToApi = (
  d: IncorporationDsc & {
    party?: IncorporationParty | null
    case?: (IncorporationCase & { client?: Client | null }) | null
  },
  m: EmployeeLookup,
) => ({
  id: d.id,
  case_id: d.caseId,
  case_code: d.case?.caseCode ?? null,
  client_name: d.case?.client?.companyName ?? null,
  party_id: d.partyId,
  party_name: d.party?.name ?? null,
  party_role: d.party?.role ?? null,
  required: d.required,
  status: d.status,
  provider: d.provider,
  reference_no: d.referenceNo,
  request_date: d.requestDate,
  received_date: d.receivedDate,
  expiry_date: d.expiryDate,
  remarks: d.remarks,
  ...provenance(d, m),
  created_at: iso(d.createdAt),
})

export const nameToApi = (
  n: IncorporationName & { case?: (IncorporationCase & { client?: Client | null }) | null },
  m: EmployeeLookup,
) => ({
  id: n.id,
  case_id: n.caseId,
  case_code: n.case?.caseCode ?? null,
  client_name: n.case?.client?.companyName ?? null,
  proposed_name: n.proposedName,
  priority: n.priority,
  status: n.status,
  submission_date: n.submissionDate,
  application_ref: n.applicationRef,
  response_date: n.responseDate,
  remarks: n.remarks,
  ...provenance(n, m),
  created_at: iso(n.createdAt),
})

export const filingToApi = (
  f: IncorporationFiling & {
    case?: (IncorporationCase & { client?: Client | null }) | null
    clientDocument?: { id: string; name: string } | null
  },
  m: EmployeeLookup,
) => ({
  id: f.id,
  case_id: f.caseId,
  case_code: f.case?.caseCode ?? null,
  client_name: f.case?.client?.companyName ?? null,
  filing_type: f.filingType,
  portal: f.portal,
  application_ref: f.applicationRef,
  acknowledgement_ref: f.acknowledgementRef,
  prepared_date: f.preparedDate,
  submitted_date: f.submittedDate,
  status: f.status,
  assigned_employee_id: f.assignedEmployeeId,
  assigned_employee: ref(m, f.assignedEmployeeId),
  remarks: f.remarks,
  client_document_id: f.clientDocumentId,
  client_document: f.clientDocument ?? null,
  ...provenance(f, m),
  created_at: iso(f.createdAt),
})

export const queryToApi = (
  q: IncorporationQuery & {
    case?: (IncorporationCase & { client?: Client | null }) | null
    filing?: IncorporationFiling | null
    clientDocument?: { id: string; name: string } | null
  },
  m: EmployeeLookup,
  asOf = today(),
) => ({
  id: q.id,
  case_id: q.caseId,
  case_code: q.case?.caseCode ?? null,
  client_name: q.case?.client?.companyName ?? null,
  filing_id: q.filingId,
  filing_type: q.filing?.filingType ?? null,
  query_date: q.queryDate,
  authority: q.authority,
  description: q.description,
  client_document_id: q.clientDocumentId,
  client_document: q.clientDocument ?? null,
  assigned_employee_id: q.assignedEmployeeId,
  assigned_employee: ref(m, q.assignedEmployeeId),
  response_due_date: q.responseDueDate,
  response: q.response,
  response_submitted_date: q.responseSubmittedDate,
  resubmission_ref: q.resubmissionRef,
  resolution: q.resolution,
  remarks: q.remarks,
  status: q.status,
  /// Computed at read time, never stored — a row cannot sit in the database
  /// claiming to be on time a week after it stopped being on time.
  is_overdue: isQueryOverdue(q, asOf),
  ...provenance(q, m),
  created_at: iso(q.createdAt),
})

export const deliverableToApi = (
  d: IncorporationDeliverable & {
    case?: (IncorporationCase & { client?: Client | null }) | null
    clientDocument?: { id: string; name: string; currentVersion: number } | null
  },
  m: EmployeeLookup,
) => ({
  id: d.id,
  case_id: d.caseId,
  case_code: d.case?.caseCode ?? null,
  client_id: d.clientId,
  client_name: d.case?.client?.companyName ?? null,
  name: d.name,
  type: d.type,
  status: d.status,
  client_document_id: d.clientDocumentId,
  client_document: d.clientDocument ?? null,
  prepared_date: d.preparedDate,
  delivered_date: d.deliveredDate,
  delivered_by: ref(m, d.deliveredByEmployeeId),
  reference_no: d.referenceNo,
  notes: d.notes,
  ...provenance(d, m),
  created_at: iso(d.createdAt),
})

export const feeToApi = (
  f: IncorporationFee & { case?: IncorporationCase | null },
  m: EmployeeLookup,
) => ({
  id: f.id,
  case_id: f.caseId,
  case_code: f.case?.caseCode ?? null,
  client_id: f.clientId,
  category: f.category,
  description: f.description,
  /// Integer paise on the wire, exactly as the rest of this schema does money.
  amount_paise: f.amountPaise,
  status: f.status,
  client_service_id: f.clientServiceId,
  invoice_ref: f.invoiceRef,
  due_date: f.dueDate,
  paid_date: f.paidDate,
  paid_amount_paise: f.paidAmountPaise,
  notes: f.notes,
  recorded_by: ref(m, f.recordedByEmployeeId),
  created_at: iso(f.createdAt),
})

export const activityToApi = (a: IncorporationActivity & { actorName?: string | null }) => ({
  id: a.id,
  case_id: a.caseId,
  action: a.action,
  detail: a.detail,
  actor_user_id: a.actorUserId,
  actor_name: a.actorName ?? null,
  created_at: iso(a.createdAt),
})

/** A case task — a row in the EXISTING Task table, not a second engine. */
export const caseTaskToApi = (t: Task, m: EmployeeLookup) => ({
  id: t.id,
  client_id: t.clientId,
  incorporation_case_id: t.incorporationCaseId,
  title: t.title,
  description: t.description,
  status: t.status,
  assigned_employee_id: t.assignedEmployeeId,
  assigned_employee: ref(m, t.assignedEmployeeId),
  due_date: t.dueDate,
  created_at: iso(t.createdAt),
})
