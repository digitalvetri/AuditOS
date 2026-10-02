/**
 * snake_case on the wire, camelCase in Prisma — the split every module here
 * uses, so the frontend needs no adapter.
 *
 * PROVENANCE. A registration holds government facts (GSTIN, CIN, ARN) that
 * no portal confirmed — an employee typed them. Every such row serialises
 * `source` / `recorded_by` / `recorded_at` beside the value so the UI can
 * print "Recorded by <employee> · <date>" and never present a typed-in
 * number as though a department returned it.
 */
import type {
  Client, ClientRegistration, RegistrationEvent, RegistrationType,
} from '@prisma/client'
import type { EmployeeLookup } from '../../api/workstation.serialize.js'
import { allowedNext, type RegistrationStatus } from './validate.js'

const ref = (m: EmployeeLookup, id: string | null | undefined) => (id ? m.get(id) ?? null : null)
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

export const registrationTypeToApi = (t: RegistrationType) => ({
  id: t.id,
  code: t.code,
  name: t.name,
  short_name: t.shortName,
  kind: t.kind,
  authority: t.authority,
  form: t.form,
  portal_scope: t.portalScope,
  portal_url: t.portalUrl,
  portal_label: t.portalLabel,
  output_document: t.outputDocument,
  renewal_months: t.renewalMonths,
  is_active: t.isActive,
  sort_order: t.sortOrder,
})

export function registrationToApi(
  r: ClientRegistration & {
    client?: Client | null
    type?: RegistrationType | null
    events?: RegistrationEvent[]
  },
  m: EmployeeLookup,
  today: string,
) {
  return {
    id: r.id,
    registration_code: r.registrationCode,
    client_id: r.clientId,
    client_code: r.client?.clientCode ?? null,
    client_name: r.client?.companyName ?? null,
    type_id: r.typeId,
    type_code: r.type?.code ?? null,
    type_name: r.type?.name ?? null,
    type_short_name: r.type?.shortName ?? null,
    kind: r.type?.kind ?? null,
    portal_url: r.type?.portalUrl ?? null,
    portal_label: r.type?.portalLabel ?? null,
    output_document: r.type?.outputDocument ?? null,
    client_service_id: r.clientServiceId,

    status: r.status,
    /* The UI disables the moves the server would reject anyway, so a user is
       never offered a transition that 422s. */
    allowed_next: allowedNext(r.status as RegistrationStatus),

    application_ref: r.applicationRef,
    registration_number: r.registrationNumber,
    applied_on: r.appliedOn,
    registered_on: r.registeredOn,
    valid_till: r.validTill,
    next_renewal_on: r.nextRenewalOn,
    /* Computed, never stored — a stored flag goes stale the next morning. */
    renewal_due: !!r.nextRenewalOn && r.nextRenewalOn <= today && r.status === 'registered',

    assigned_employee_id: r.assignedEmployeeId,
    assigned_employee: ref(m, r.assignedEmployeeId),
    certificate_document_id: r.certificateDocumentId,
    notes: r.notes,

    source: r.source,
    recorded_by: ref(m, r.recordedByEmployeeId),
    recorded_at: iso(r.recordedAt),

    events: (r.events ?? []).map((e) => eventToApi(e, m)),

    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  }
}

export const eventToApi = (e: RegistrationEvent, m: EmployeeLookup) => ({
  id: e.id,
  registration_id: e.registrationId,
  action: e.action,
  detail: e.detail,
  actor: ref(m, e.actorEmployeeId),
  created_at: iso(e.createdAt),
})
