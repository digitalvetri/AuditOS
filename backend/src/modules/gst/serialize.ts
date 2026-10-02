/**
 * API shapes for the GST compliance service. snake_case out, matching the
 * rest of the Workstation API. Paise are sent as plain numbers — every GST
 * figure is far inside 2^53, and the client formats them as rupees.
 */
import type { EmployeeLookup } from '../../api/workstation.serialize.js'
import {
  daysRemaining, dueLabel, dueDateFor, deriveOverall, nextDueOf, type StageView,
} from './service.js'

/** Employee display name, or null when the id is unknown. */
const name = (m: EmployeeLookup, id: string | null | undefined) =>
  (id ? m.get(id)?.full_name : null) ?? null

const paise = (v: bigint | number | null | undefined) =>
  v === null || v === undefined ? null : Number(v)

export interface PeriodRow {
  id: string
  financialYear: string
  period: string
  periodType: string
  assignedEmployeeId: string | null
  reviewerEmployeeId: string | null
  gstProfile: {
    id: string
    gstin: string
    legalName: string | null
    registrationType: string
    filingFrequency: string
    client: { id: string; companyName: string } | null
  }
  filings: {
    returnType: string
    status: string
    dueDate: string | null
    arn: string | null
    filedAt: Date | null
    filedManually: boolean
    taxableValue: bigint | null
    taxAmount: bigint | null
    taxLiability: bigint | null
    eligibleItc: bigint | null
    netPayable: bigint | null
    paymentStatus: string
  }[]
  r2b: { status: string; totalItcIgst: bigint; totalItcCgst: bigint; totalItcSgst: bigint; availableDate: string | null } | null
  reconciliation: { status: string; matchedCount: number; mismatchCount: number; booksItc: bigint; twoBItc: bigint } | null
  _count?: { exceptions: number }
}

/** Stage statuses, with the two returns read out of GstFiling by type. */
export function stagesOf(p: PeriodRow): StageView {
  const byType = (t: string) => p.filings.find((f) => f.returnType === t)
  return {
    gstr1: byType('GSTR-1')?.status ?? 'pending',
    gstr2b: p.r2b?.status ?? 'pending',
    reconciliation: p.reconciliation?.status ?? 'pending',
    gstr3b: byType('GSTR-3B')?.status ?? 'pending',
  }
}

export function periodToApi(p: PeriodRow, employees: EmployeeLookup, openExceptions = 0) {
  const stages = stagesOf(p)
  const nextDue = nextDueOf(p.period, p.periodType, stages)
  const days = daysRemaining(nextDue)
  const filing = (t: string) => {
    const f = p.filings.find((x) => x.returnType === t)
    if (!f) return null
    return {
      status: f.status,
      due_date: f.dueDate ?? dueDateFor(p.period, t, p.periodType),
      arn: f.arn,
      filed_at: f.filedAt?.toISOString() ?? null,
      /// §31 — recorded by an employee, never transmitted by Audit OS.
      filed_manually: f.filedManually,
      taxable_value: paise(f.taxableValue),
      tax_amount: paise(f.taxAmount),
      tax_liability: paise(f.taxLiability),
      eligible_itc: paise(f.eligibleItc),
      net_payable: paise(f.netPayable),
      payment_status: f.paymentStatus,
    }
  }

  return {
    id: p.id,
    financial_year: p.financialYear,
    period: p.period,
    period_type: p.periodType,

    client_id: p.gstProfile.client?.id ?? null,
    client_name: p.gstProfile.client?.companyName ?? p.gstProfile.legalName ?? null,
    gstin: p.gstProfile.gstin,
    registration_type: p.gstProfile.registrationType,
    filing_frequency: p.gstProfile.filingFrequency,

    assigned_employee_id: p.assignedEmployeeId,
    assigned_employee_name: name(employees, p.assignedEmployeeId),
    reviewer_employee_id: p.reviewerEmployeeId,
    reviewer_employee_name: name(employees, p.reviewerEmployeeId),

    // The four stages, in cycle order.
    gstr1: filing('GSTR-1'),
    gstr2b: p.r2b
      ? {
          status: p.r2b.status,
          available_date: p.r2b.availableDate,
          total_itc: paise(p.r2b.totalItcIgst + p.r2b.totalItcCgst + p.r2b.totalItcSgst),
        }
      : { status: 'pending', available_date: null, total_itc: null },
    reconciliation: p.reconciliation
      ? {
          status: p.reconciliation.status,
          matched_count: p.reconciliation.matchedCount,
          mismatch_count: p.reconciliation.mismatchCount,
          books_itc: paise(p.reconciliation.booksItc),
          two_b_itc: paise(p.reconciliation.twoBItc),
          itc_difference: paise(p.reconciliation.booksItc - p.reconciliation.twoBItc),
        }
      : { status: 'pending', matched_count: 0, mismatch_count: 0, books_itc: null, two_b_itc: null, itc_difference: null },
    gstr3b: filing('GSTR-3B'),

    stage_status: stages,
    open_exceptions: openExceptions,
    overall_status: deriveOverall(stages, nextDue, openExceptions),
    next_due_date: nextDue,
    days_remaining: days,
    due_label: dueLabel(days),
  }
}

export function profileToApi(p: {
  id: string; gstin: string; legalName: string | null; pan: string | null; state: string | null
  registrationType: string; registrationStatus: string; filingFrequency: string
  registrationDate: string | null; assignedEmployeeId: string; reviewerEmployeeId: string | null
  contactPerson: string | null; contactEmail: string | null; contactPhone: string | null
  address: string | null; active: boolean; nextDueDate: string | null
  client: { id: string; companyName: string } | null
  _count?: { periods: number }
}, employees: EmployeeLookup) {
  return {
    id: p.id,
    client_id: p.client?.id ?? null,
    client_name: p.client?.companyName ?? null,
    legal_name: p.legalName,
    gstin: p.gstin,
    pan: p.pan,
    state: p.state,
    registration_type: p.registrationType,
    registration_status: p.registrationStatus,
    registration_date: p.registrationDate,
    filing_frequency: p.filingFrequency,
    assigned_employee_id: p.assignedEmployeeId,
    assigned_employee_name: name(employees, p.assignedEmployeeId),
    reviewer_employee_id: p.reviewerEmployeeId,
    reviewer_employee_name: name(employees, p.reviewerEmployeeId),
    contact_person: p.contactPerson,
    contact_email: p.contactEmail,
    contact_phone: p.contactPhone,
    address: p.address,
    active: p.active,
    next_due_date: p.nextDueDate,
    period_count: p._count?.periods ?? 0,
  }
}
