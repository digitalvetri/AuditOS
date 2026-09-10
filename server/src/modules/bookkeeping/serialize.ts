import type {
  BookkeepingActivity, BookkeepingChecklistItem, BookkeepingDeliverable,
  BookkeepingDocumentRequest, BookkeepingEngagement, BookkeepingPendingItem,
  BookkeepingPeriod, BookkeepingTask, Client,
} from '@prisma/client'
import type { EmployeeLookup } from '../../api/workstation.serialize.js'
import { periodLabel } from './validate.js'

/**
 * snake_case on the wire, camelCase in Prisma — the same split every other
 * module in this server uses, so the frontend needs no adapter.
 */
const ref = (m: EmployeeLookup, id: string | null | undefined) => (id ? m.get(id) ?? null : null)
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

export function engagementToApi(
  e: BookkeepingEngagement & { client?: Client | null },
  m: EmployeeLookup,
) {
  return {
    id: e.id,
    client_id: e.clientId,
    client_name: e.client?.companyName ?? null,
    client_code: e.client?.clientCode ?? null,
    status: e.status,
    service_start_date: e.serviceStartDate,
    assigned_employee_id: e.assignedEmployeeId,
    assigned_employee: ref(m, e.assignedEmployeeId),
    billing_frequency: e.billingFrequency,
    next_due_date: e.nextDueDate,
    notes: e.notes,
    created_at: iso(e.createdAt),
    updated_at: iso(e.updatedAt),
  }
}

export function periodToApi(
  p: BookkeepingPeriod & { engagement?: (BookkeepingEngagement & { client?: Client | null }) | null },
  m: EmployeeLookup,
  progress?: { total: number; completed: number; pending: number; overdue: number; percent: number },
) {
  return {
    id: p.id,
    engagement_id: p.engagementId,
    client_id: p.engagement?.clientId ?? null,
    client_name: p.engagement?.client?.companyName ?? null,
    year: p.year,
    month: p.month,
    label: periodLabel(p.year, p.month),
    status: p.status,
    due_date: p.dueDate,
    completed_date: iso(p.completedDate),
    assigned_employee_id: p.assignedEmployeeId,
    assigned_employee: ref(m, p.assignedEmployeeId),
    notes: p.notes,
    progress: progress ?? null,
    created_at: iso(p.createdAt),
  }
}

export const checklistItemToApi = (c: BookkeepingChecklistItem, m: EmployeeLookup) => ({
  id: c.id,
  period_id: c.periodId,
  label: c.label,
  status: c.status,
  sort_order: c.sortOrder,
  notes: c.notes,
  completed_at: iso(c.completedAt),
  completed_by: ref(m, c.completedByEmployeeId),
})

export const taskToApi = (
  t: BookkeepingTask & { client?: Client | null; period?: BookkeepingPeriod | null },
  m: EmployeeLookup,
) => ({
  id: t.id,
  period_id: t.periodId,
  period_label: t.period ? periodLabel(t.period.year, t.period.month) : null,
  client_id: t.clientId,
  client_name: t.client?.companyName ?? null,
  title: t.title,
  description: t.description,
  category: t.category,
  priority: t.priority,
  status: t.status,
  assigned_employee_id: t.assignedEmployeeId,
  assigned_employee: ref(m, t.assignedEmployeeId),
  due_date: t.dueDate,
  completed_at: iso(t.completedAt),
  notes: t.notes,
  created_at: iso(t.createdAt),
})

export const pendingItemToApi = (
  p: BookkeepingPendingItem & { client?: Client | null; period?: BookkeepingPeriod | null },
  m: EmployeeLookup,
) => ({
  id: p.id,
  period_id: p.periodId,
  period_label: p.period ? periodLabel(p.period.year, p.period.month) : null,
  client_id: p.clientId,
  client_name: p.client?.companyName ?? null,
  title: p.title,
  description: p.description,
  category: p.category,
  priority: p.priority,
  status: p.status,
  requested_date: p.requestedDate,
  due_date: p.dueDate,
  resolved_date: iso(p.resolvedDate),
  assigned_employee_id: p.assignedEmployeeId,
  assigned_employee: ref(m, p.assignedEmployeeId),
  notes: p.notes,
  created_at: iso(p.createdAt),
})

export const documentRequestToApi = (
  d: BookkeepingDocumentRequest & {
    client?: Client | null
    period?: BookkeepingPeriod | null
    clientDocument?: { id: string; name: string; status: string } | null
  },
  m: EmployeeLookup,
) => ({
  id: d.id,
  period_id: d.periodId,
  period_label: d.period ? periodLabel(d.period.year, d.period.month) : null,
  client_id: d.clientId,
  client_name: d.client?.companyName ?? null,
  document_type: d.documentType,
  description: d.description,
  status: d.status,
  requested_at: iso(d.requestedAt),
  due_date: d.dueDate,
  received_at: iso(d.receivedAt),
  client_document_id: d.clientDocumentId,
  client_document: d.clientDocument
    ? { id: d.clientDocument.id, name: d.clientDocument.name, status: d.clientDocument.status }
    : null,
  created_at: iso(d.createdAt),
})

export const deliverableToApi = (
  d: BookkeepingDeliverable & {
    client?: Client | null
    period?: BookkeepingPeriod | null
    clientDocument?: { id: string; name: string } | null
  },
  m: EmployeeLookup,
) => ({
  id: d.id,
  period_id: d.periodId,
  period_label: d.period ? periodLabel(d.period.year, d.period.month) : null,
  client_id: d.clientId,
  client_name: d.client?.companyName ?? null,
  type: d.type,
  status: d.status,
  prepared_by: ref(m, d.preparedByEmployeeId),
  reviewed_by: ref(m, d.reviewedByEmployeeId),
  client_document_id: d.clientDocumentId,
  client_document: d.clientDocument ?? null,
  approved_at: iso(d.approvedAt),
  delivered_at: iso(d.deliveredAt),
  notes: d.notes,
  created_at: iso(d.createdAt),
})

export const activityToApi = (a: BookkeepingActivity & { period?: BookkeepingPeriod | null }) => ({
  id: a.id,
  client_id: a.clientId,
  period_id: a.periodId,
  period_label: a.period ? periodLabel(a.period.year, a.period.month) : null,
  action: a.action,
  detail: a.detail,
  created_at: iso(a.createdAt),
})
