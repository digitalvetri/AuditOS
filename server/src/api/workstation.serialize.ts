/**
 * THE WORKSTATION API BOUNDARY.
 *
 * A sibling of serialize.ts, same job, same rules: Prisma columns are
 * camelCase, the HTTP API is snake_case with `_paise` money and 'YYYY-MM-DD'
 * calendar dates. No route handler builds a response object by hand and no
 * React component ever sees a database column name.
 *
 * It is a separate FILE (not separate rules) so the 1000-line core serializer
 * stays a core-HR file — the same reason the Workstation seed is its own
 * module.
 *
 * EMPLOYEE JOINS: Workstation stores assignments as scalar ids with no Prisma
 * relation, so employees cannot be `include`d. `employeeMap()` batch-fetches
 * them in ONE query and the serializers attach the same `{ id, full_name,
 * employee_code }` triple that employeeRef() produces in serialize.ts. That
 * keeps one employee record and avoids an N+1.
 */
import type {
  Activity, Client, ClientContact, ClientDocument, ClientDocumentVersion,
  ClientService, EwayBill, FollowUp, GstFiling, GstProfile, Lead, Service, Task,
} from '@prisma/client'
import { prisma } from '../lib/prisma.js'

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null)
const isoReq = (d: Date): string => d.toISOString()

function auditable(row: {
  createdAt: Date; updatedAt: Date; createdBy: string | null; updatedBy: string | null; deletedAt: Date | null
}) {
  return {
    created_at: isoReq(row.createdAt),
    updated_at: isoReq(row.updatedAt),
    created_by: row.createdBy,
    updated_by: row.updatedBy,
    deleted_at: iso(row.deletedAt),
  }
}

// ── Employee joins ────────────────────────────────────────────────────────
export interface EmployeeRef {
  id: string
  full_name: string
  employee_code: string
}
export type EmployeeLookup = Map<string, EmployeeRef>

/** One query for every employee id referenced by a page of results. */
export async function employeeMap(ids: (string | null | undefined)[]): Promise<EmployeeLookup> {
  const unique = Array.from(new Set(ids.filter((v): v is string => !!v && v !== 'portal')))
  if (unique.length === 0) return new Map()
  const rows = await prisma.employee.findMany({
    where: { id: { in: unique } },
    select: { id: true, fullName: true, employeeCode: true },
  })
  return new Map(rows.map((e) => [e.id, { id: e.id, full_name: e.fullName, employee_code: e.employeeCode }]))
}

const ref = (m: EmployeeLookup, id: string | null | undefined): EmployeeRef | null =>
  id ? m.get(id) ?? null : null

// ── Catalog ───────────────────────────────────────────────────────────────
export function serviceToApi(s: Service) {
  return {
    id: s.id,
    organisation_id: s.organisationId,
    code: s.code,
    name: s.name,
    is_active: s.isActive,
    sort_order: s.sortOrder,
    ...auditable(s),
  }
}

export function documentCategoryToApi(c: {
  id: string; organisationId: string; code: string; name: string; description: string | null
  sortOrder: number; createdAt: Date; updatedAt: Date; createdBy: string | null
  updatedBy: string | null; deletedAt: Date | null
}) {
  return {
    id: c.id,
    organisation_id: c.organisationId,
    code: c.code,
    name: c.name,
    description: c.description,
    sort_order: c.sortOrder,
    ...auditable(c),
  }
}

// ── Leads ─────────────────────────────────────────────────────────────────
export function leadToApi(l: Lead & { service?: Service | null }, m: EmployeeLookup) {
  return {
    id: l.id,
    organisation_id: l.organisationId,
    lead_id: l.leadCode,
    name: l.name,
    contact_number: l.contactNumber,
    email: l.email,
    service_id: l.serviceId,
    service_name: l.service?.name ?? null,
    /* Quoted, NOT received. Finance owns payment (§55) — this figure never
       reaches the ledger and the UI labels it accordingly. */
    price_quoted_paise: l.priceQuotedPaise,
    assigned_employee_id: l.assignedEmployeeId,
    assigned_employee: ref(m, l.assignedEmployeeId),
    status: l.status,
    notes: l.notes,
    lost_reason: l.lostReason,
    converted_client_id: l.convertedClientId,
    converted_at: iso(l.convertedAt),
    /* System-generated (§5.2); split so the UI can show date and time apart. */
    created_date: isoReq(l.createdAt).slice(0, 10),
    ...auditable(l),
  }
}

// ── Clients ───────────────────────────────────────────────────────────────
export function clientToApi(c: Client, m: EmployeeLookup) {
  return {
    id: c.id,
    organisation_id: c.organisationId,
    client_id: c.clientCode,
    company_name: c.companyName,
    legal_name: c.legalName,
    business_type: c.businessType,
    contact_person: c.contactPerson,
    contact_number: c.contactNumber,
    email: c.email,
    address: c.address,
    gstin: c.gstin,
    pan: c.pan,
    tan: c.tan,
    account_manager_id: c.accountManagerId,
    account_manager: ref(m, c.accountManagerId),
    assigned_team: c.assignedTeam,
    status: c.status,
    onboarding_date: c.onboardingDate,
    notes: c.notes,
    source_lead_id: c.sourceLeadId,
    /* Reserved for the Client Portal (§56). Modelled, never surfaced to a client. */
    portal_enabled: c.portalEnabled,
    portal_invite_email: c.portalInviteEmail,
    ...auditable(c),
  }
}

export function clientContactToApi(c: ClientContact) {
  return {
    id: c.id,
    client_id: c.clientId,
    name: c.name,
    designation: c.designation,
    phone: c.phone,
    email: c.email,
    is_primary: c.isPrimary,
    ...auditable(c),
  }
}

// ── Services on a client ──────────────────────────────────────────────────
export function clientServiceToApi(
  s: ClientService & { service?: Service | null; client?: Client | null },
  m: EmployeeLookup,
) {
  return {
    id: s.id,
    client_id: s.clientId,
    client_code: s.client?.clientCode ?? null,
    client_name: s.client?.companyName ?? null,
    service_id: s.serviceId,
    service_name: s.service?.name ?? null,
    assigned_employee_id: s.assignedEmployeeId,
    assigned_employee: ref(m, s.assignedEmployeeId),
    manager_id: s.managerId,
    manager: ref(m, s.managerId),
    due_date: s.dueDate,
    status: s.status,
    started_at: iso(s.startedAt),
    completed_at: iso(s.completedAt),
    notes: s.notes,
    ...auditable(s),
  }
}

export function taskToApi(t: Task, m: EmployeeLookup) {
  return {
    id: t.id,
    client_id: t.clientId,
    client_service_id: t.clientServiceId,
    title: t.title,
    description: t.description,
    assigned_employee_id: t.assignedEmployeeId,
    assigned_employee: ref(m, t.assignedEmployeeId),
    due_date: t.dueDate,
    status: t.status,
    ...auditable(t),
  }
}

// ── Follow-ups ────────────────────────────────────────────────────────────
export function followUpToApi(
  f: FollowUp & { lead?: (Lead & { service?: Service | null }) | null; client?: Client | null },
  m: EmployeeLookup,
) {
  /* One entity, two possible subjects (§3). The API flattens the subject so a
     single list can render leads and clients in the same table. */
  const isLead = !!f.leadId
  return {
    id: f.id,
    organisation_id: f.organisationId,
    lead_id: f.leadId,
    client_id: f.clientId,
    client_service_id: f.clientServiceId,
    subject_type: isLead ? 'lead' : 'client',
    subject_id: f.leadId ?? f.clientId,
    subject_name: isLead ? f.lead?.name ?? null : f.client?.companyName ?? null,
    subject_code: isLead ? f.lead?.leadCode ?? null : f.client?.clientCode ?? null,
    contact_number: isLead ? f.lead?.contactNumber ?? null : f.client?.contactNumber ?? null,
    service_name: isLead ? f.lead?.service?.name ?? null : null,
    title: f.title,
    type: f.type,
    scheduled_at: isoReq(f.scheduledAt),
    assigned_employee_id: f.assignedEmployeeId,
    assigned_employee: ref(m, f.assignedEmployeeId),
    status: f.status,
    notes: f.notes,
    reminder_minutes_before: f.reminderMinutesBefore,
    completed_by_employee_id: f.completedByEmployeeId,
    completed_by: ref(m, f.completedByEmployeeId),
    completed_at: iso(f.completedAt),
    completion_notes: f.completionNotes,
    ...auditable(f),
  }
}

// ── Documents ─────────────────────────────────────────────────────────────
export function clientDocumentToApi(
  d: ClientDocument & {
    category?: { id: string; code: string; name: string } | null
    client?: Client | null
    versions?: ClientDocumentVersion[]
  },
  m: EmployeeLookup,
) {
  return {
    id: d.id,
    client_id: d.clientId,
    client_code: d.client?.clientCode ?? null,
    client_name: d.client?.companyName ?? null,
    category_id: d.categoryId,
    category_code: d.category?.code ?? null,
    category_name: d.category?.name ?? null,
    client_service_id: d.clientServiceId,
    name: d.name,
    financial_year: d.financialYear,
    status: d.status,
    version: d.currentVersion,
    requested_by_employee_id: d.requestedByEmployeeId,
    requested_by: ref(m, d.requestedByEmployeeId),
    requested_at: iso(d.requestedAt),
    verified_by_employee_id: d.verifiedByEmployeeId,
    verified_by: ref(m, d.verifiedByEmployeeId),
    verified_at: iso(d.verifiedAt),
    rejection_reason: d.rejectionReason,
    expiry_date: d.expiryDate,
    versions: (d.versions ?? []).map((v) => documentVersionToApi(v, m)),
    ...auditable(d),
  }
}

export function documentVersionToApi(v: ClientDocumentVersion, m: EmployeeLookup) {
  return {
    id: v.id,
    document_id: v.documentId,
    version: v.version,
    file_key: v.fileKey,
    /* 'portal' is a sentinel, not an employee — the future Client Portal
       delivered this version (§10.5). It resolves to null here and the UI
       renders "Client Portal". */
    uploaded_by: v.uploadedBy,
    uploaded_by_employee: ref(m, v.uploadedBy),
    uploaded_via_portal: v.uploadedBy === 'portal',
    uploaded_at: isoReq(v.uploadedAt),
    size_bytes: v.sizeBytes,
    notes: v.notes,
    previous_version_id: v.previousVersionId,
    created_at: isoReq(v.createdAt),
  }
}

// ── GST ───────────────────────────────────────────────────────────────────
export function gstProfileToApi(g: GstProfile & { filings?: GstFiling[] }, m: EmployeeLookup) {
  return {
    id: g.id,
    client_id: g.clientId,
    gstin: g.gstin,
    registration_status: g.registrationStatus,
    filing_frequency: g.filingFrequency,
    registration_date: g.registrationDate,
    assigned_employee_id: g.assignedEmployeeId,
    assigned_employee: ref(m, g.assignedEmployeeId),
    service_status: g.serviceStatus,
    last_filed_at: iso(g.lastFiledAt),
    next_due_date: g.nextDueDate,
    filings: (g.filings ?? []).map((f) => gstFilingToApi(f, m)),
    ...auditable(g),
  }
}

export function gstFilingToApi(f: GstFiling, m: EmployeeLookup) {
  return {
    id: f.id,
    gst_profile_id: f.gstProfileId,
    period: f.period,
    return_type: f.returnType,
    status: f.status,
    filed_at: iso(f.filedAt),
    due_date: f.dueDate,
    assigned_employee_id: f.assignedEmployeeId,
    assigned_employee: ref(m, f.assignedEmployeeId),
    arn: f.arn,
    remarks: f.remarks,
    ...auditable(f),
  }
}

// ── E-way bills ───────────────────────────────────────────────────────────
export function ewayBillToApi(e: EwayBill, m: EmployeeLookup) {
  return {
    id: e.id,
    client_id: e.clientId,
    ewb_no: e.ewbNo,
    document_no: e.documentNo,
    document_date: e.documentDate,
    from_gstin: e.fromGstin,
    to_gstin: e.toGstin,
    to_party_name: e.toPartyName,
    value_paise: e.valuePaise,
    status: e.status,
    generated_at: isoReq(e.generatedAt),
    valid_until: e.validUntil,
    cancelled_at: iso(e.cancelledAt),
    cancel_reason: e.cancelReason,
    generated_by_employee_id: e.generatedByEmployeeId,
    generated_by: ref(m, e.generatedByEmployeeId),
    /* ALWAYS true in this build. Audit OS has no government e-way bill
       connectivity; the client renders a simulated notice off this flag. */
    is_simulated: e.isSimulated,
    ...auditable(e),
  }
}

// ── Activity ──────────────────────────────────────────────────────────────
export function activityToApi(a: Activity, m: EmployeeLookup) {
  return {
    id: a.id,
    subject_type: a.subjectType,
    subject_id: a.subjectId,
    action: a.action,
    description: a.description,
    actor_user_id: a.actorUserId,
    actor_employee_id: a.actorEmployeeId,
    actor: ref(m, a.actorEmployeeId),
    entity_type: a.entityType,
    entity_id: a.entityId,
    created_at: isoReq(a.createdAt),
  }
}
