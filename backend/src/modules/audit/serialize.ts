import type {
  AuditEngagement, AuditObservation, AuditReviewNote, AuditRisk, AuditTeamMember,
  AuditUdin, AuditWorkingPaper, AuditWorkingPaperFile,
} from '@prisma/client'
import { toNum } from '../../lib/money.js'
import type { Blocker, EmployeeRef, Progress } from './service.js'

/**
 * API shapes for audit files — snake_case, field names matching the request
 * bodies in docs/audit-files/README.md. Money as paise numbers (toNum).
 */

type Names = Map<string, EmployeeRef>
const nm = (names: Names, id: string | null | undefined) => (id ? names.get(id)?.full_name ?? null : null)
/** The employee triple `{ id, full_name, employee_code }`, or null. */
const ref = (names: Names, id: string | null | undefined) => (id ? names.get(id) ?? null : null)

/** `{ items, count }` — the list envelope the frontend reads. */
export const list = <T>(items: T[]) => ({ items, count: items.length })

export interface ClientRef { id: string; clientCode: string; companyName: string; pan?: string | null }

export function materiality(e: AuditEngagement) {
  const overall = toNum(e.overallMaterialityPaise)
  const perf = toNum(e.performanceMaterialityPaise)
  const trivial = toNum(e.clearlyTrivialPaise)
  // The schema stores the amounts, not the two derived percentages; they are
  // read back from the amounts.
  const pctOf = (x: number | null) => (overall && x != null ? Number(((x / overall) * 100).toFixed(2)) : null)
  return {
    benchmark: e.materialityBenchmark,
    base_paise: toNum(e.materialityBasePaise),
    percent: e.materialityPercent,
    overall_paise: overall,
    performance_percent: pctOf(perf),
    performance_paise: perf,
    trivial_percent: pctOf(trivial),
    clearly_trivial_paise: trivial,
    rationale: e.materialityRationale,
    is_set: overall != null,
  }
}

export function engagement(e: AuditEngagement, ctx: { client?: ClientRef | null; names: Names; progress?: Progress }) {
  return {
    id: e.id,
    audit_code: e.auditCode,
    client_id: e.clientId,
    client: ctx.client ? { id: ctx.client.id, client_code: ctx.client.clientCode, company_name: ctx.client.companyName, pan: ctx.client.pan ?? null } : null,
    client_name: ctx.client?.companyName ?? null,
    financial_year: e.financialYear,
    audit_type: e.auditType,
    title: e.title,
    engagement_letter_id: e.engagementLetterId,
    signing_partner_id: e.signingPartnerId,
    signing_partner: ref(ctx.names, e.signingPartnerId),
    signing_partner_name: nm(ctx.names, e.signingPartnerId),
    partner_membership_no: e.partnerMembershipNo,
    manager_id: e.managerId,
    manager: ref(ctx.names, e.managerId),
    manager_name: nm(ctx.names, e.managerId),
    status: e.status,
    planned_start_date: e.plannedStartDate,
    planned_report_date: e.plannedReportDate,
    report_date: e.reportDate,
    opinion_type: e.opinionType,
    report_place: e.reportPlace,
    acceptance_approved_by: e.acceptanceApprovedBy,
    acceptance_approver: ref(ctx.names, e.acceptanceApprovedBy),
    acceptance_approved_by_name: nm(ctx.names, e.acceptanceApprovedBy),
    acceptance_approved_at: e.acceptanceApprovedAt,
    assembly_due_date: e.assemblyDueDate,
    locked: !!e.lockedAt,
    locked_at: e.lockedAt,
    locked_by: e.lockedBy,
    locked_by_name: nm(ctx.names, e.lockedBy),
    locker: ref(ctx.names, e.lockedBy),
    progress: ctx.progress ?? null,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
  }
}

export function engagementDetail(
  e: AuditEngagement,
  ctx: { client: ClientRef | null; names: Names; progress: Progress; team: AuditTeamMember[]; blockers: Blocker[] },
) {
  return {
    ...engagement(e, ctx),
    team: ctx.team.map((t) => teamMember(t, ctx.names, e)),
    materiality: materiality(e),
    /** Human-readable reasons the file cannot be signed yet. */
    blockers: ctx.blockers.map((b) => b.message),
    /** The same, structured: `{ code, message, count, items }`. */
    blocker_details: ctx.blockers,
    can_sign: ctx.blockers.length === 0,
  }
}

export function teamMember(t: AuditTeamMember, names: Names, e?: AuditEngagement) {
  return {
    id: t.id,
    engagement_id: t.engagementId,
    employee_id: t.employeeId,
    employee: ref(names, t.employeeId),
    employee_name: nm(names, t.employeeId),
    role: t.role,
    is_signing_partner: !!e && e.signingPartnerId === t.employeeId,
    is_manager: !!e && e.managerId === t.employeeId,
    independence_declared: !!t.independenceDeclaredAt,
    independence_declared_at: t.independenceDeclaredAt,
    independence_note: t.independenceNote,
    created_at: t.createdAt,
  }
}

export function wpFile(f: AuditWorkingPaperFile, names: Names) {
  return {
    id: f.id,
    working_paper_id: f.workingPaperId,
    original_name: f.originalName,
    mime_type: f.mimeType,
    size_bytes: f.sizeBytes,
    sha256: f.sha256,
    uploaded_by: f.uploadedBy,
    uploader: ref(names, f.uploadedBy),
    uploaded_by_name: nm(names, f.uploadedBy),
    uploaded_at: f.uploadedAt,
    is_addendum: f.isAddendum,
  }
}

export function workingPaper(
  w: AuditWorkingPaper & { files?: AuditWorkingPaperFile[] },
  names: Names,
  openNotes = 0,
) {
  return {
    id: w.id,
    engagement_id: w.engagementId,
    ref: w.ref,
    section: w.section,
    area: w.area,
    title: w.title,
    objective: w.objective,
    procedure: w.procedure,
    conclusion: w.conclusion,
    status: w.status,
    assigned_to: w.assignedTo,
    assignee: ref(names, w.assignedTo),
    assigned_to_name: nm(names, w.assignedTo),
    prepared_by: w.preparedBy,
    preparer: ref(names, w.preparedBy),
    prepared_by_name: nm(names, w.preparedBy),
    prepared_at: w.preparedAt,
    reviewed_by: w.reviewedBy,
    reviewer: ref(names, w.reviewedBy),
    reviewed_by_name: nm(names, w.reviewedBy),
    reviewed_at: w.reviewedAt,
    is_addendum: w.isAddendum,
    addendum_reason: w.addendumReason,
    open_notes: openNotes,
    files: (w.files ?? []).filter((f) => !f.deletedAt).map((f) => wpFile(f, names)),
    file_count: (w.files ?? []).filter((f) => !f.deletedAt).length,
    created_at: w.createdAt,
    updated_at: w.updatedAt,
  }
}

export function reviewNote(n: AuditReviewNote & { workingPaper?: { ref: string; title: string } | null }, names: Names) {
  return {
    id: n.id,
    engagement_id: n.engagementId,
    working_paper_id: n.workingPaperId,
    working_paper_ref: n.workingPaper?.ref ?? null,
    working_paper_title: n.workingPaper?.title ?? null,
    note: n.note,
    raised_by: n.raisedBy,
    raiser: ref(names, n.raisedBy),
    raised_by_name: nm(names, n.raisedBy),
    raised_at: n.raisedAt,
    response: n.response,
    responded_by: n.respondedBy,
    responder: ref(names, n.respondedBy),
    responded_by_name: nm(names, n.respondedBy),
    responded_at: n.respondedAt,
    status: n.status,
    cleared_by: n.clearedBy,
    clearer: ref(names, n.clearedBy),
    cleared_by_name: nm(names, n.clearedBy),
    cleared_at: n.clearedAt,
  }
}

export function risk(r: AuditRisk) {
  return {
    id: r.id,
    engagement_id: r.engagementId,
    area: r.area,
    assertion: r.assertion,
    description: r.description,
    level: r.level,
    fraud_risk: r.fraudRisk,
    response: r.response,
    working_paper_refs: r.workingPaperRefs,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }
}

export function observation(o: AuditObservation, names: Names) {
  return {
    id: o.id,
    engagement_id: o.engagementId,
    ref: o.ref,
    title: o.title,
    description: o.description,
    area: o.area,
    severity: o.severity,
    kind: o.kind,
    amount_paise: toNum(o.amountPaise),
    adjusted: o.adjusted,
    management_response: o.managementResponse,
    report_impact: o.reportImpact,
    status: o.status,
    owner_id: o.ownerId,
    owner: ref(names, o.ownerId),
    owner_name: nm(names, o.ownerId),
    due_date: o.dueDate,
    resolved_by: o.resolvedBy,
    resolved_by_name: nm(names, o.resolvedBy),
    resolved_at: o.resolvedAt,
    created_at: o.createdAt,
    updated_at: o.updatedAt,
  }
}

export function udin(
  u: AuditUdin & { engagement?: { auditCode: string } | null },
  ctx: { names: Names; clients: Map<string, ClientRef> },
) {
  const c = ctx.clients.get(u.clientId)
  return {
    id: u.id,
    udin: u.udin,
    client_id: u.clientId,
    client: c ? { id: c.id, client_code: c.clientCode, company_name: c.companyName } : null,
    client_name: c?.companyName ?? null,
    engagement_id: u.engagementId,
    audit_code: u.engagement?.auditCode ?? null,
    document_type: u.documentType,
    document_description: u.documentDescription,
    document_date: u.documentDate,
    partner_id: u.partnerId,
    partner: ref(ctx.names, u.partnerId),
    partner_name: nm(ctx.names, u.partnerId),
    membership_no: u.membershipNo,
    generated_on: u.generatedOn,
    revoked: !!u.revokedAt,
    revoked_at: u.revokedAt,
    revoked_reason: u.revokedReason,
    created_at: u.createdAt,
  }
}
