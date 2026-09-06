/**
 * §10 data model — Part 1 tables (platform primitives, core-HR, config).
 *
 * Rules from §4 that this file enforces at the type level:
 *   - User ↔ Employee is nullable 1:1 both ways.
 *   - Employee.manager_id is self-referential and nullable.
 *   - Reserved Workstation columns exist as nullable from day one.
 *   - Every row carries created_at/updated_at/created_by/updated_by + deleted_at.
 *   - AuditLog is append-only; no update shape is exported.
 *
 * Currency in minor units (paise) to avoid float. Format at the edge.
 */

// ── Common ────────────────────────────────────────────────────────────────
export type ID = string; // uuid
export type ISODateTime = string; // stored UTC, displayed IST
export type ISODate = string; // 'YYYY-MM-DD'

export interface Auditable {
  created_at: ISODateTime;
  updated_at: ISODateTime;
  created_by: ID | null;
  updated_by: ID | null;
  deleted_at: ISODateTime | null;
}

// ── Platform primitives ──────────────────────────────────────────────────
export interface Organisation extends Auditable {
  id: ID;
  name: string;
  timezone: 'Asia/Kolkata';
  currency: 'INR';
  fiscal_year_start_month: 4; // April
}

export type RoleCode =
  | 'employee'
  | 'dept_manager'
  | 'hr_admin'
  | 'finance_admin'
  | 'md';

export interface Role extends Auditable {
  id: ID;
  code: RoleCode;
  name: string;
}

/**
 * Permission codes follow `<module>.<action>[.<qualifier>]` and pair with a
 * scope (`self` | `department` | `organisation`) at the call site. The full
 * matrix lives in src/platform/rbac/matrix.ts — this shape is what the API
 * stores.
 */
export interface Permission extends Auditable {
  id: ID;
  code: string;
  description: string;
}

export interface RolePermission {
  role_id: ID;
  permission_id: ID;
  scope: 'self' | 'department' | 'organisation';
}

export interface User extends Auditable {
  id: ID;
  organisation_id: ID;
  email: string;
  password_hash: string; // mock: 'plain:<pw>' — replaced by real hash server-side
  role_id: ID;
  /** Nullable both ways per §4.2. Automation users may have no employee. */
  employee_id: ID | null;
  is_active: boolean;
  last_login_at: ISODateTime | null;
}

// ── Core HR ───────────────────────────────────────────────────────────────
export type EmployeeType =
  | 'partner'
  | 'manager'
  | 'executive'
  | 'articled'
  | 'support';

export type EmployeeStatus =
  | 'active'
  | 'on_leave'
  | 'probation'
  | 'notice_period'
  | 'inactive';

export interface Department extends Auditable {
  id: ID;
  organisation_id: ID;
  name: string;
  code: string;
}

export interface Designation extends Auditable {
  id: ID;
  organisation_id: ID;
  name: string;
}

export interface WorkLocation extends Auditable {
  id: ID;
  organisation_id: ID;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  radius_m: number;
  is_active: boolean;
}

export interface WorkSchedule extends Auditable {
  id: ID;
  organisation_id: ID;
  name: string;
  standard_start: string; // 'HH:mm' — 09:30
  standard_end: string; // 'HH:mm' — 18:30
  full_day_hours: number; // 8.0
  half_day_hours: number; // 4.0
  break_minutes: number; // 60
  /** Bitmask Mon..Sun or list; we use list of ISO weekday numbers 1..7. */
  working_days: number[];
  /** 2nd/4th Saturday off encoded as a rule ID; scaffold uses a flag. */
  alternate_saturday_off: boolean;
}

export interface Holiday extends Auditable {
  id: ID;
  organisation_id: ID;
  date: ISODate;
  name: string;
  is_optional: boolean;
}

export interface Employee extends Auditable {
  id: ID;
  organisation_id: ID;
  employee_code: string; // 'AO-0001'
  first_name: string;
  last_name: string;
  full_name: string; // computed at write; still stored for search
  type: EmployeeType;
  status: EmployeeStatus;
  designation_id: ID;
  department_id: ID;
  manager_id: ID | null; // self-referential
  work_location_id: ID;
  work_schedule_id: ID;
  email: string;
  phone: string;
  joining_date: ISODate;
  exit_date: ISODate | null;
  exit_reason: string | null;
  notice_period_days: number;
  /** Reserved for Workstation — nullable from day one. */
  weekly_capacity_hours: number | null;
  photo_url: string | null;
  // Contact fields (employee-editable subset)
  address: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  bank_account_masked: string | null; // '••••1234'
}

export interface ArticledTraining extends Auditable {
  id: ID;
  employee_id: ID;
  icai_registration_no: string;
  principal_employee_id: ID; // the CA under whom registered
  training_start: ISODate;
  training_end: ISODate;
  current_year: 1 | 2 | 3;
  stipend_slab: string; // slab code — table in Settings
  status: 'active' | 'transferred' | 'completed' | 'terminated';
}

// ── Attendance ────────────────────────────────────────────────────────────
export type AttendanceStatus =
  | 'present'
  | 'late'
  | 'absent'
  | 'half_day'
  | 'wfh'
  | 'on_leave'
  | 'missing_check_in'
  | 'missing_check_out';

export type LocationType = 'office' | 'client_site' | 'remote' | 'field';

export interface Attendance extends Auditable {
  id: ID;
  employee_id: ID;
  date: ISODate; // (employee_id, date) unique
  check_in_at: ISODateTime | null;
  check_out_at: ISODateTime | null;
  check_in_lat: number | null;
  check_in_long: number | null;
  check_in_accuracy_m: number | null;
  check_out_lat: number | null;
  check_out_long: number | null;
  check_out_accuracy_m: number | null;
  check_in_location_id: ID | null;
  check_out_location_id: ID | null;
  location_type: LocationType | null;
  off_site_reason: string | null;
  worked_minutes: number | null;
  break_minutes: number | null;
  status: AttendanceStatus;
  source: 'web_geo' | 'biometric' | 'manual';
  correction_status: 'none' | 'requested' | 'approved' | 'rejected';
  device: string | null;
  ip: string | null;
  /** Reserved for Workstation. No FK — Client table doesn't exist yet. */
  client_id: ID | null;
}

export interface AttendanceCorrection extends Auditable {
  id: ID;
  attendance_id: ID | null; // null when creating a new day
  employee_id: ID;
  date: ISODate;
  requested_check_in_at: ISODateTime | null;
  requested_check_out_at: ISODateTime | null;
  reason: string;
  attachment_url: string | null;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_by: ID | null;
  reviewed_at: ISODateTime | null;
  review_notes: string | null;
}

// ── Leave ─────────────────────────────────────────────────────────────────
export type LeaveTypeCode = 'casual' | 'sick' | 'earned' | 'lop' | 'comp_off';

export interface LeaveType extends Auditable {
  id: ID;
  organisation_id: ID;
  code: LeaveTypeCode;
  name: string;
  annual_entitlement: number | null; // null = unlimited (LOP)
  accrual: 'monthly' | 'earned';
  carry_forward_max: number; // 0 for none
  half_day_allowed: boolean;
  min_notice_days: number;
  accrue_during_probation: boolean;
}

export interface LeaveBalance {
  id: ID;
  employee_id: ID;
  leave_type_id: ID;
  fiscal_year_start: ISODate; // '2026-04-01'
  entitled: number;
  availed: number;
  carried_forward: number;
  updated_at: ISODateTime;
}

export interface LeaveRequest extends Auditable {
  id: ID;
  employee_id: ID;
  leave_type_id: ID;
  start_date: ISODate;
  end_date: ISODate;
  half_day: boolean;
  computed_working_days: number; // sandwich rule applied at write
  reason: string;
  attachment_url: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  approver_id: ID | null;
  hr_approver_id: ID | null; // set when > 5 days
  approved_at: ISODateTime | null;
  rejection_reason: string | null;
}

// ── Documents ─────────────────────────────────────────────────────────────
export type DocumentType =
  | 'employment'
  | 'joining'
  | 'certificate'
  | 'hr'
  | 'tax'
  | 'bank'
  | 'company_issued'
  | 'icai';

export interface EmployeeDocument extends Auditable {
  id: ID;
  employee_id: ID;
  name: string;
  type: DocumentType;
  file_key: string; // storage key — download via signed URL
  uploaded_by: ID;
  uploaded_at: ISODateTime;
  expiry_date: ISODate | null;
  status: 'valid' | 'expiring_soon' | 'expired' | 'pending_verification';
}

// ── Config: Expense Categories + Statutory Rates (owned by Part 1) ────────
export interface ExpenseCategory extends Auditable {
  id: ID;
  organisation_id: ID;
  name: string;
  code: string;
  is_active: boolean;
  requires_receipt: boolean;
  gl_account: string | null;
}

export interface StatutoryRate extends Auditable {
  id: ID;
  organisation_id: ID;
  code: string; // 'pf.employee_rate', 'esi.gross_threshold', 'pt.tn.slab', …
  value: string; // stored as string; parsed by callers (rate, ceiling, slab-json)
  effective_from: ISODate;
  effective_to: ISODate | null;
  notes: string | null;
}

// ── Notifications, AuditLog, DashboardWidget ─────────────────────────────
export interface Notification {
  id: ID;
  user_id: ID;
  type: string; // 'attendance.checked_in', 'leave.approved', …
  module: 'attendance' | 'leave' | 'payroll' | 'expense' | 'message' | 'document' | 'system';
  entity_type: string | null;
  entity_id: ID | null;
  title: string;
  body: string;
  action_url: string | null;
  is_read: boolean;
  created_at: ISODateTime;
}

/** Append-only. There is no update shape and no delete. */
export interface AuditLog {
  id: ID;
  actor_user_id: ID | null;
  action: string;
  entity_type: string;
  entity_id: ID;
  before_json: unknown | null;
  after_json: unknown | null;
  ip: string | null;
  user_agent: string | null;
  created_at: ISODateTime;
}

export interface DashboardWidget {
  id: string; // 'hrms.attendance-today'
  slot: 'hero' | 'primary' | 'secondary' | 'queue' | 'feed';
  roles: RoleCode[];
  scope: 'self' | 'department' | 'organisation';
  // component reference lives in the client registry, not the DB row
}

// ── Part 2: Payroll ───────────────────────────────────────────────────────
// All money in paise (integer) — display formatting at the edge.

export interface CustomSalaryComponent {
  code: string;
  label: string;
  amount_paise: number;
  kind: 'earning' | 'deduction';
}

export interface SalaryStructure extends Auditable {
  id: ID;
  employee_id: ID;
  effective_from: ISODate;
  effective_to: ISODate | null;
  monthly_ctc_paise: number;
  basic_paise: number;
  hra_paise: number;
  conveyance_paise: number;
  special_allowance_paise: number;
  custom_components: CustomSalaryComponent[];
  notes: string | null;
}

export type PayrollStage =
  | 'draft'
  | 'hr_review'
  | 'finance_review'
  | 'approved'
  | 'processed';

/**
 * Snapshot of the StatutoryRate table at calculation time.
 * A rate change AFTER calculate must NOT alter a processed run's numbers.
 * Value shape mirrors StatutoryRate.value (string; caller parses).
 */
export type StatutorySnapshot = Record<string, string>;

export interface PayrollRun extends Auditable {
  id: ID;
  organisation_id: ID;
  period_start: ISODate;
  period_end: ISODate;
  stage: PayrollStage;
  is_calculating: boolean;
  statutory_snapshot: StatutorySnapshot | null;
  headcount: number;
  gross_total_paise: number;
  deductions_total_paise: number;
  net_total_paise: number;
  reviewed_by: ID | null;
  approved_by: ID | null;
  processed_by: ID | null;
  processed_at: ISODateTime | null;
  notes: string | null;
}

export interface PayrollEarnings {
  basic_paise: number;
  hra_paise: number;
  conveyance_paise: number;
  special_paise: number;
  incentive_paise: number;
  other: CustomSalaryComponent[];
}

export interface PayrollDeductions {
  pf_employee_paise: number;
  pf_employer_paise: number;
  esi_employee_paise: number;
  esi_employer_paise: number;
  pt_paise: number;
  tds_paise: number;
  lop_paise: number;
  advance_paise: number;
  other: CustomSalaryComponent[];
}

export interface PayrollItem extends Auditable {
  id: ID;
  payroll_run_id: ID;
  employee_id: ID;
  salary_structure_id: ID;
  payable_days: number;      // calendar days in period
  present_days: number;
  on_leave_days: number;
  absent_days: number;
  lop_days: number;          // absent minus approved-leave-that-doesn't-deduct
  earnings: PayrollEarnings;
  deductions: PayrollDeductions;
  gross_paise: number;
  total_deductions_paise: number;
  net_paise: number;
  notes: string | null;
}

export interface Payslip extends Auditable {
  id: ID;
  payroll_run_id: ID;
  payroll_item_id: ID;
  employee_id: ID;
  published_at: ISODateTime;
  file_key: string;
  status: 'published' | 'revoked';
}

export interface Payment extends Auditable {
  id: ID;
  employee_id: ID;
  payroll_run_id: ID | null;   // null when Payment came from an Expense
  expense_id: ID | null;
  amount_paise: number;
  method: 'bank_transfer' | 'cash' | 'cheque' | 'mock';
  reference: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  paid_at: ISODateTime | null;
}

// ── Expenses ──────────────────────────────────────────────────────────────

export type ExpenseStage =
  | 'draft'
  | 'pending_manager'
  | 'pending_finance'
  | 'approved'
  | 'paid'
  | 'rejected';

export type ExpensePaymentMethod = 'cash' | 'card' | 'upi' | 'bank_transfer' | 'other';

export interface Expense extends Auditable {
  id: ID;
  employee_id: ID;
  category_id: ID;
  title: string;
  amount_paise: number;
  expense_date: ISODate;
  description: string;
  payment_method: ExpensePaymentMethod;
  receipt_file_key: string | null;
  notes: string | null;
  stage: ExpenseStage;
  submitted_at: ISODateTime | null;
  manager_approved_by: ID | null;
  manager_approved_at: ISODateTime | null;
  finance_approved_by: ID | null;
  finance_approved_at: ISODateTime | null;
  paid_at: ISODateTime | null;
  payment_id: ID | null;
  rejection_reason: string | null;
  rejected_by: ID | null;
  rejected_at: ISODateTime | null;
  /** Reserved for Workstation — nullable from day one. */
  client_id: ID | null;
}

/** Append-only stage-transition trail (§8.5). AuditLog also captures it. */
export interface ExpenseApproval {
  id: ID;
  expense_id: ID;
  actor_user_id: ID;
  from_stage: ExpenseStage;
  to_stage: ExpenseStage;
  notes: string | null;
  created_at: ISODateTime;
}

export interface LedgerTransaction {
  id: ID;
  date: ISODate;
  type: 'Payroll' | 'Expense Reimbursement' | 'Office Expense' | 'Employee Advance' | 'Advance Recovery' | 'Payment';
  description: string;
  employee_id: ID | null;
  category: string | null;
  debit_paise: number;
  credit_paise: number;
  running_balance_paise: number;
  reference_id: string;
  reference_type: string;
  status: 'posted' | 'reversed';
  created_at: ISODateTime;
  created_by: ID | null;
}
