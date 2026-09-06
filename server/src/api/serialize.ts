/**
 * THE API BOUNDARY.
 *
 * Prisma columns are camelCase; the HTTP API is snake_case with `_paise`
 * money and `YYYY-MM-DD` dates (Part 1 §9/§10). Every conversion between the
 * two lives in this file — no route handler builds a response object by hand,
 * and no React component knows a database column name.
 *
 * Rule of thumb when adding a field: add it here first, then use the
 * serializer. If you find yourself spreading a Prisma row straight into a
 * response, that is the bug.
 */
import type {
  ArticledTraining, Attendance, AttendanceCorrection, AuditLog, Chat, ChatMessage,
  Department, Designation, Employee, EmployeeDocument, Expense, ExpenseApproval,
  ExpenseCategory, Holiday, LeaveBalance, LeaveRequest, LeaveType, LedgerTransaction,
  Notification, Organisation, Payment, PayrollItem, PayrollRun, Payslip, Permission,
  Role, SalaryStructure, StatutoryRate, User, WorkLocation, WorkSchedule,
} from '@prisma/client'

// ── Shared helpers ────────────────────────────────────────────────────────
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

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Display triple used wherever a row is joined to its employee. */
export function employeeRef(e: Pick<Employee, 'id' | 'fullName' | 'employeeCode'> | null | undefined) {
  return e ? { id: e.id, full_name: e.fullName, employee_code: e.employeeCode } : null
}

export function employeeRefWithDept(
  e: Pick<Employee, 'id' | 'fullName' | 'employeeCode' | 'departmentId'> | null | undefined,
) {
  return e
    ? { id: e.id, full_name: e.fullName, employee_code: e.employeeCode, department_id: e.departmentId }
    : null
}

// ── Platform ──────────────────────────────────────────────────────────────
export function organisationToApi(o: Organisation) {
  return {
    id: o.id,
    name: o.name,
    timezone: o.timezone,
    currency: o.currency,
    fiscal_year_start_month: o.fiscalYearStartMonth,
    ...auditable(o),
  }
}

export function roleToApi(r: Role) {
  return { id: r.id, code: r.code, name: r.name, ...auditable(r) }
}

export function permissionToApi(p: Permission) {
  return {
    id: p.id,
    code: p.code,
    description: p.description,
    created_at: isoReq(p.createdAt),
    updated_at: isoReq(p.updatedAt),
    created_by: null,
    updated_by: null,
    deleted_at: iso(p.deletedAt),
  }
}

/** Never serialise passwordHash. This function is the reason that is safe. */
export function userToApi(u: User) {
  return {
    id: u.id,
    organisation_id: u.organisationId,
    email: u.email,
    role_id: u.roleId,
    employee_id: u.employeeId,
    is_active: u.isActive,
    last_login_at: iso(u.lastLoginAt),
    ...auditable(u),
  }
}

// ── Config ────────────────────────────────────────────────────────────────
export function departmentToApi(d: Department) {
  return { id: d.id, organisation_id: d.organisationId, name: d.name, code: d.code, ...auditable(d) }
}

export function designationToApi(d: Designation) {
  return { id: d.id, organisation_id: d.organisationId, name: d.name, ...auditable(d) }
}

export function workLocationToApi(w: WorkLocation) {
  return {
    id: w.id,
    organisation_id: w.organisationId,
    name: w.name,
    address: w.address,
    latitude: w.latitude,
    longitude: w.longitude,
    radius_m: w.radiusM,
    is_active: w.isActive,
    ...auditable(w),
  }
}

export function workScheduleToApi(s: WorkSchedule) {
  return {
    id: s.id,
    organisation_id: s.organisationId,
    name: s.name,
    standard_start: s.standardStart,
    standard_end: s.standardEnd,
    full_day_hours: s.fullDayHours,
    half_day_hours: s.halfDayHours,
    break_minutes: s.breakMinutes,
    working_days: parseJson<number[]>(s.workingDaysJson, []),
    alternate_saturday_off: s.alternateSaturdayOff,
    ...auditable(s),
  }
}

export function holidayToApi(h: Holiday) {
  return {
    id: h.id,
    organisation_id: h.organisationId,
    date: h.date,
    name: h.name,
    is_optional: h.isOptional,
    ...auditable(h),
  }
}

export function leaveTypeToApi(t: LeaveType) {
  return {
    id: t.id,
    organisation_id: t.organisationId,
    code: t.code,
    name: t.name,
    annual_entitlement: t.annualEntitlement,
    accrual: t.accrual,
    carry_forward_max: t.carryForwardMax,
    half_day_allowed: t.halfDayAllowed,
    min_notice_days: t.minNoticeDays,
    accrue_during_probation: t.accrueDuringProbation,
    ...auditable(t),
  }
}

export function expenseCategoryToApi(c: ExpenseCategory) {
  return {
    id: c.id,
    organisation_id: c.organisationId,
    name: c.name,
    code: c.code,
    is_active: c.isActive,
    requires_receipt: c.requiresReceipt,
    gl_account: c.glAccount,
    ...auditable(c),
  }
}

export function statutoryRateToApi(r: StatutoryRate) {
  return {
    id: r.id,
    organisation_id: r.organisationId,
    code: r.code,
    value: r.value,
    effective_from: r.effectiveFrom,
    effective_to: r.effectiveTo,
    notes: r.notes,
    ...auditable(r),
  }
}

// ── Core HR ───────────────────────────────────────────────────────────────
export function employeeToApi(e: Employee) {
  return {
    id: e.id,
    organisation_id: e.organisationId,
    employee_code: e.employeeCode,
    first_name: e.firstName,
    last_name: e.lastName,
    full_name: e.fullName,
    type: e.type,
    status: e.status,
    designation_id: e.designationId,
    department_id: e.departmentId,
    manager_id: e.managerId,
    work_location_id: e.workLocationId,
    work_schedule_id: e.workScheduleId,
    email: e.email,
    phone: e.phone,
    joining_date: e.joiningDate,
    exit_date: e.exitDate,
    exit_reason: e.exitReason,
    notice_period_days: e.noticePeriodDays,
    weekly_capacity_hours: e.weeklyCapacityHours,
    photo_url: e.photoUrl,
    address: e.address,
    emergency_contact_name: e.emergencyContactName,
    emergency_contact_phone: e.emergencyContactPhone,
    bank_account_masked: e.bankAccountMasked,
    ...auditable(e),
  }
}

/**
 * §5‡ — the EXACT six fields (plus id) Finance receives. Anything else in this
 * object is a spec violation, so the projection is built explicitly rather
 * than by deleting keys from the full row.
 */
export function employeeFinanceProjection(e: Employee) {
  return {
    id: e.id,
    employee_code: e.employeeCode,
    full_name: e.fullName,
    department_id: e.departmentId,
    designation_id: e.designationId,
    bank_account_masked: e.bankAccountMasked,
    status: e.status,
  }
}

/** Department-scope peers: no bank details, no home address, no next of kin. */
export function employeeDeptProjection(e: Employee) {
  const full = employeeToApi(e)
  const { bank_account_masked: _b, address: _a, emergency_contact_name: _n, emergency_contact_phone: _p, ...rest } = full
  return rest
}

export function articledTrainingToApi(t: ArticledTraining) {
  return {
    id: t.id,
    employee_id: t.employeeId,
    icai_registration_no: t.icaiRegistrationNo,
    principal_employee_id: t.principalEmployeeId,
    training_start: t.trainingStart,
    training_end: t.trainingEnd,
    current_year: t.currentYear,
    stipend_slab: t.stipendSlab,
    status: t.status,
    ...auditable(t),
  }
}

export function documentToApi(d: EmployeeDocument, derivedStatus?: string) {
  return {
    id: d.id,
    employee_id: d.employeeId,
    name: d.name,
    type: d.type,
    file_key: d.fileKey,
    uploaded_by: d.uploadedBy,
    uploaded_at: isoReq(d.uploadedAt),
    expiry_date: d.expiryDate,
    status: derivedStatus ?? d.status,
    ...auditable(d),
  }
}

// ── Attendance ────────────────────────────────────────────────────────────
export function attendanceToApi(a: Attendance) {
  return {
    id: a.id,
    employee_id: a.employeeId,
    date: a.date,
    check_in_at: iso(a.checkInAt),
    check_out_at: iso(a.checkOutAt),
    check_in_lat: a.checkInLat,
    check_in_long: a.checkInLong,
    check_in_accuracy_m: a.checkInAccuracyM,
    check_out_lat: a.checkOutLat,
    check_out_long: a.checkOutLong,
    check_out_accuracy_m: a.checkOutAccuracyM,
    check_in_location_id: a.checkInLocationId,
    check_out_location_id: a.checkOutLocationId,
    location_type: a.locationType,
    off_site_reason: a.offSiteReason,
    worked_minutes: a.workedMinutes,
    break_minutes: a.breakMinutes,
    status: a.status,
    source: a.source,
    correction_status: a.correctionStatus,
    device: a.device,
    ip: a.ip,
    client_id: a.clientId,
    ...auditable(a),
  }
}

/** Coordinates are personal data — peers at department scope never see them. */
export function stripCoords<T extends ReturnType<typeof attendanceToApi>>(row: T): T {
  return {
    ...row,
    check_in_lat: null,
    check_in_long: null,
    check_in_accuracy_m: null,
    check_out_lat: null,
    check_out_long: null,
    check_out_accuracy_m: null,
  }
}

export function correctionToApi(c: AttendanceCorrection) {
  return {
    id: c.id,
    attendance_id: c.attendanceId,
    employee_id: c.employeeId,
    date: c.date,
    requested_check_in_at: iso(c.requestedCheckInAt),
    requested_check_out_at: iso(c.requestedCheckOutAt),
    reason: c.reason,
    attachment_url: c.attachmentUrl,
    status: c.status,
    reviewed_by: c.reviewedBy,
    reviewed_at: iso(c.reviewedAt),
    review_notes: c.reviewNotes,
    ...auditable(c),
  }
}

// ── Leave ─────────────────────────────────────────────────────────────────
export function leaveBalanceToApi(b: LeaveBalance) {
  return {
    id: b.id,
    employee_id: b.employeeId,
    leave_type_id: b.leaveTypeId,
    fiscal_year_start: b.fiscalYearStart,
    entitled: b.entitled,
    availed: b.availed,
    carried_forward: b.carriedForward,
    updated_at: isoReq(b.updatedAt),
  }
}

export function leaveRequestToApi(r: LeaveRequest) {
  return {
    id: r.id,
    employee_id: r.employeeId,
    leave_type_id: r.leaveTypeId,
    start_date: r.startDate,
    end_date: r.endDate,
    half_day: r.halfDay,
    computed_working_days: r.computedWorkingDays,
    reason: r.reason,
    attachment_url: r.attachmentUrl,
    status: r.status,
    approver_id: r.approverId,
    hr_approver_id: r.hrApproverId,
    approved_at: iso(r.approvedAt),
    rejection_reason: r.rejectionReason,
    ...auditable(r),
  }
}

// ── Payroll ───────────────────────────────────────────────────────────────
export function salaryStructureToApi(s: SalaryStructure) {
  return {
    id: s.id,
    employee_id: s.employeeId,
    effective_from: s.effectiveFrom,
    effective_to: s.effectiveTo,
    monthly_ctc_paise: s.monthlyCtcPaise,
    basic_paise: s.basicPaise,
    hra_paise: s.hraPaise,
    conveyance_paise: s.conveyancePaise,
    special_allowance_paise: s.specialAllowancePaise,
    custom_components: parseJson<unknown[]>(s.customComponentsJson, []),
    notes: s.notes,
    ...auditable(s),
  }
}

export function payrollRunToApi(r: PayrollRun) {
  return {
    id: r.id,
    organisation_id: r.organisationId,
    period_start: r.periodStart,
    period_end: r.periodEnd,
    stage: r.stage,
    is_calculating: r.isCalculating,
    statutory_snapshot: parseJson<Record<string, string> | null>(r.statutorySnapshotJson, null),
    headcount: r.headcount,
    gross_total_paise: r.grossTotalPaise,
    deductions_total_paise: r.deductionsTotalPaise,
    net_total_paise: r.netTotalPaise,
    reviewed_by: r.reviewedBy,
    approved_by: r.approvedBy,
    processed_by: r.processedBy,
    processed_at: iso(r.processedAt),
    notes: r.notes,
    ...auditable(r),
  }
}

export function payrollItemToApi(i: PayrollItem) {
  return {
    id: i.id,
    payroll_run_id: i.payrollRunId,
    employee_id: i.employeeId,
    salary_structure_id: i.salaryStructureId,
    payable_days: i.payableDays,
    present_days: i.presentDays,
    on_leave_days: i.onLeaveDays,
    absent_days: i.absentDays,
    lop_days: i.lopDays,
    earnings: parseJson<Record<string, unknown>>(i.earningsJson, {}),
    deductions: parseJson<Record<string, unknown>>(i.deductionsJson, {}),
    gross_paise: i.grossPaise,
    total_deductions_paise: i.totalDeductionsPaise,
    net_paise: i.netPaise,
    gratuity_accrual_paise: i.gratuityAccrualPaise,
    notes: i.notes,
    ...auditable(i),
  }
}

export function payslipToApi(p: Payslip) {
  return {
    id: p.id,
    payroll_run_id: p.payrollRunId,
    payroll_item_id: p.payrollItemId,
    employee_id: p.employeeId,
    payslip_no: p.payslipNo,
    published_at: isoReq(p.publishedAt),
    file_key: p.fileKey,
    status: p.status,
    ...auditable(p),
  }
}

export function paymentToApi(p: Payment) {
  return {
    id: p.id,
    payment_no: p.paymentNo,
    employee_id: p.employeeId,
    payroll_run_id: p.payrollRunId,
    expense_id: p.expenseId,
    amount_paise: p.amountPaise,
    method: p.method,
    reference: p.reference,
    status: p.status,
    paid_at: iso(p.paidAt),
    ...auditable(p),
  }
}

// ── Expenses ──────────────────────────────────────────────────────────────
export function expenseToApi(e: Expense) {
  return {
    id: e.id,
    expense_no: e.expenseNo,
    employee_id: e.employeeId,
    category_id: e.categoryId,
    title: e.title,
    amount_paise: e.amountPaise,
    expense_date: e.expenseDate,
    description: e.description,
    payment_method: e.paymentMethod,
    receipt_file_key: e.receiptFileKey,
    notes: e.notes,
    stage: e.stage,
    submitted_at: iso(e.submittedAt),
    manager_approved_by: e.managerApprovedBy,
    manager_approved_at: iso(e.managerApprovedAt),
    finance_approved_by: e.financeApprovedBy,
    finance_approved_at: iso(e.financeApprovedAt),
    paid_at: iso(e.paidAt),
    payment_id: e.paymentId,
    rejection_reason: e.rejectionReason,
    rejected_by: e.rejectedBy,
    rejected_at: iso(e.rejectedAt),
    client_id: e.clientId,
    ...auditable(e),
  }
}

export function expenseApprovalToApi(a: ExpenseApproval) {
  return {
    id: a.id,
    expense_id: a.expenseId,
    actor_user_id: a.actorUserId,
    from_stage: a.fromStage,
    to_stage: a.toStage,
    notes: a.notes,
    created_at: isoReq(a.createdAt),
  }
}

// ── Accounts ──────────────────────────────────────────────────────────────
export function ledgerToApi(l: LedgerTransaction) {
  return {
    id: l.id,
    transaction_ref: l.transactionRef,
    sequence: l.sequence,
    date: l.date,
    type: l.type,
    description: l.description,
    employee_id: l.employeeId,
    category: l.category,
    debit_paise: l.debitPaise,
    credit_paise: l.creditPaise,
    running_balance_paise: l.runningBalancePaise,
    reference_id: l.referenceId,
    reference_type: l.referenceType,
    status: l.status,
    reverses_id: l.reversesId,
    payment_id: l.paymentId,
    created_at: isoReq(l.createdAt),
    created_by: l.createdBy,
  }
}

// ── Notifications + audit ─────────────────────────────────────────────────
export function notificationToApi(n: Notification) {
  return {
    id: n.id,
    user_id: n.userId,
    type: n.type,
    module: n.module,
    entity_type: n.entityType,
    entity_id: n.entityId,
    title: n.title,
    body: n.body,
    action_url: n.actionUrl,
    is_read: n.isRead,
    created_at: isoReq(n.createdAt),
  }
}

export function auditLogToApi(a: AuditLog) {
  return {
    id: a.id,
    actor_user_id: a.actorUserId,
    action: a.action,
    entity_type: a.entityType,
    entity_id: a.entityId,
    before_json: parseJson<unknown>(a.beforeJson, null),
    after_json: parseJson<unknown>(a.afterJson, null),
    ip: a.ip,
    user_agent: a.userAgent,
    created_at: isoReq(a.createdAt),
  }
}

// ── Messages ──────────────────────────────────────────────────────────────
export function chatToApi(c: Chat) {
  return {
    id: c.id,
    organisation_id: c.organisationId,
    type: c.type,
    name: c.name,
    description: c.description,
    subject_type: c.subjectType,
    subject_id: c.subjectId,
    last_message_at: iso(c.lastMessageAt),
    ...auditable(c),
  }
}

export interface ChatListItem extends ReturnType<typeof chatToApi> {
  display_name: string
  last_message: { id: string; body: string; created_at: string; author_id: string } | null
  unread: number
  member_count: number
}

export type ChatMessageWithAuthor = ReturnType<typeof chatMessageToApi>

/** Reply previews are inlined and truncated so the thread renders in one pass. */
export function chatMessageToApi(m: ChatMessage & {
  author: Pick<Employee, 'id' | 'fullName' | 'employeeCode'> | null
  parent?: (Pick<ChatMessage, 'id' | 'body' | 'deletedAt'> & { author: Pick<Employee, 'fullName'> | null }) | null
  reads?: { id: string }[]
}) {
  return {
    id: m.id,
    chat_id: m.chatId,
    author_employee_id: m.authorEmployeeId,
    body: m.body,
    parent_id: m.parentId,
    mentions: parseJson<string[]>(m.mentionsJson, []),
    created_at: isoReq(m.createdAt),
    updated_at: isoReq(m.updatedAt),
    deleted_at: iso(m.deletedAt),
    author: m.author
      ? { id: m.author.id, full_name: m.author.fullName, employee_code: m.author.employeeCode }
      : null,
    parent_preview: m.parent
      ? {
          id: m.parent.id,
          body: m.parent.deletedAt
            ? '(deleted message)'
            : m.parent.body.length > 80 ? `${m.parent.body.slice(0, 80)}…` : m.parent.body,
          author_full_name: m.parent.author?.fullName ?? null,
        }
      : null,
    read_by_me: (m.reads?.length ?? 0) > 0,
  }
}
