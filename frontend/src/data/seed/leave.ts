/**
 * Leave module seed: types, holidays, balances, sample requests.
 *
 * Per §3 rules — types + accrual, TN holidays, mid-year plausible balances,
 * a handful of pending requests to exercise the approver-routing UI on load.
 */

import type {
  Holiday,
  LeaveBalance,
  LeaveRequest,
  LeaveType,
} from '@/data/models';
import { organisation, employees } from './index';

const now = new Date().toISOString();
const auditable = () => ({
  created_at: now,
  updated_at: now,
  created_by: null,
  updated_by: null,
  deleted_at: null,
});

// ── Leave types (§3) ─────────────────────────────────────────────────────
export const leaveTypes: LeaveType[] = [
  {
    id: 'lt-casual',
    organisation_id: organisation.id,
    code: 'casual',
    name: 'Casual',
    annual_entitlement: 12,
    accrual: 'monthly',
    carry_forward_max: 0,
    half_day_allowed: true,
    min_notice_days: 1,
    accrue_during_probation: true,
    ...auditable(),
  },
  {
    id: 'lt-sick',
    organisation_id: organisation.id,
    code: 'sick',
    name: 'Sick',
    annual_entitlement: 12,
    accrual: 'monthly',
    carry_forward_max: 0,
    half_day_allowed: false,
    min_notice_days: 0, // retroactive allowed
    accrue_during_probation: true,
    ...auditable(),
  },
  {
    id: 'lt-earned',
    organisation_id: organisation.id,
    code: 'earned',
    name: 'Earned',
    annual_entitlement: 15,
    accrual: 'monthly',
    carry_forward_max: 30,
    half_day_allowed: true,
    min_notice_days: 7,
    accrue_during_probation: false,
    ...auditable(),
  },
  {
    id: 'lt-lop',
    organisation_id: organisation.id,
    code: 'lop',
    name: 'Loss of Pay',
    annual_entitlement: null, // unlimited
    accrual: 'monthly',
    carry_forward_max: 0,
    half_day_allowed: false,
    min_notice_days: 0,
    accrue_during_probation: true,
    ...auditable(),
  },
  {
    id: 'lt-compoff',
    organisation_id: organisation.id,
    code: 'comp_off',
    name: 'Comp Off',
    annual_entitlement: 0, // earned by working on off days
    accrual: 'earned',
    carry_forward_max: 0,
    half_day_allowed: false,
    min_notice_days: 1,
    accrue_during_probation: true,
    ...auditable(),
  },
];

// ── Tamil Nadu 2026 holidays (representative — verify against actual list) ─
export const holidays: Holiday[] = [
  { id: 'h-nyd', organisation_id: organisation.id, date: '2026-01-01', name: "New Year's Day", is_optional: false, ...auditable() },
  { id: 'h-pongal-1', organisation_id: organisation.id, date: '2026-01-14', name: 'Pongal', is_optional: false, ...auditable() },
  { id: 'h-pongal-2', organisation_id: organisation.id, date: '2026-01-15', name: 'Thiruvalluvar Day', is_optional: false, ...auditable() },
  { id: 'h-rday', organisation_id: organisation.id, date: '2026-01-26', name: 'Republic Day', is_optional: false, ...auditable() },
  { id: 'h-mahashivratri', organisation_id: organisation.id, date: '2026-02-15', name: 'Maha Shivratri', is_optional: true, ...auditable() },
  { id: 'h-holi', organisation_id: organisation.id, date: '2026-03-04', name: 'Holi', is_optional: true, ...auditable() },
  { id: 'h-tamilny', organisation_id: organisation.id, date: '2026-04-14', name: 'Tamil New Year', is_optional: false, ...auditable() },
  { id: 'h-goodfri', organisation_id: organisation.id, date: '2026-04-03', name: 'Good Friday', is_optional: false, ...auditable() },
  { id: 'h-mayday', organisation_id: organisation.id, date: '2026-05-01', name: 'May Day', is_optional: false, ...auditable() },
  { id: 'h-independence', organisation_id: organisation.id, date: '2026-08-15', name: 'Independence Day', is_optional: false, ...auditable() },
  { id: 'h-vinayakachaturthi', organisation_id: organisation.id, date: '2026-09-14', name: 'Vinayaka Chaturthi', is_optional: false, ...auditable() },
  { id: 'h-gandhi', organisation_id: organisation.id, date: '2026-10-02', name: 'Gandhi Jayanti', is_optional: false, ...auditable() },
  { id: 'h-ayudha', organisation_id: organisation.id, date: '2026-10-19', name: 'Ayudha Pooja', is_optional: false, ...auditable() },
  { id: 'h-vijayadasami', organisation_id: organisation.id, date: '2026-10-20', name: 'Vijayadasami', is_optional: false, ...auditable() },
  { id: 'h-diwali', organisation_id: organisation.id, date: '2026-11-08', name: 'Deepavali', is_optional: false, ...auditable() },
  { id: 'h-christmas', organisation_id: organisation.id, date: '2026-12-25', name: 'Christmas', is_optional: false, ...auditable() },
];

// ── Balances (mid-year plausible) ────────────────────────────────────────
// Fiscal year 01-Apr-2026 → 31-Mar-2027. September is month 6 → 6/12 accrued.
const FY_START = '2026-04-01';

export const leaveBalances: LeaveBalance[] = [];
for (const emp of employees) {
  for (const type of leaveTypes) {
    // Skip Earned for probation employees — none in the seed at present, but
    // the rule is honoured.
    if (type.code === 'earned' && emp.status === 'probation') continue;

    let entitled = 0;
    let availed = 0;
    if (type.code === 'casual') {
      entitled = 6; // half-year accrual
      availed = emp.id === 'emp-exec' ? 3 : emp.id === 'emp-mgr' ? 1 : 0;
    } else if (type.code === 'sick') {
      entitled = 6;
      availed = emp.id === 'emp-exec' ? 1.5 : 0;
    } else if (type.code === 'earned') {
      entitled = 7.5;
      availed = emp.id === 'emp-md' ? 2 : 0;
    } else if (type.code === 'lop') {
      entitled = 0; // unlimited handled at request time
      availed = 0;
    } else if (type.code === 'comp_off') {
      entitled = emp.id === 'emp-mgr' ? 1 : 0;
      availed = 0;
    }
    leaveBalances.push({
      id: `lb-${emp.id}-${type.code}`,
      employee_id: emp.id,
      leave_type_id: type.id,
      fiscal_year_start: FY_START,
      entitled,
      availed,
      carried_forward: 0,
      updated_at: now,
    });
  }
}

// ── Pending sample requests ──────────────────────────────────────────────
// One pending 2-day Casual by employee (dept manager approves)
// One pending 8-day Earned by employee (>5 days → escalates to HR after mgr)
// One approved past Sick by manager
export const leaveRequests: LeaveRequest[] = [
  {
    id: 'lr-emp-casual',
    employee_id: 'emp-exec',
    leave_type_id: 'lt-casual',
    start_date: '2026-09-14',
    end_date: '2026-09-15',
    half_day: false,
    computed_working_days: 1, // 14th is a holiday; 15th is working → 1
    reason: 'Family function',
    attachment_url: null,
    status: 'pending',
    approver_id: null,
    hr_approver_id: null,
    approved_at: null,
    rejection_reason: null,
    ...auditable(),
  },
  {
    id: 'lr-emp-earned',
    employee_id: 'emp-exec',
    leave_type_id: 'lt-earned',
    start_date: '2026-10-05',
    end_date: '2026-10-14',
    half_day: false,
    computed_working_days: 8, // spans Oct 19/20 holidays & weekend
    reason: 'Vacation with family',
    attachment_url: null,
    status: 'pending',
    approver_id: null,
    hr_approver_id: null,
    approved_at: null,
    rejection_reason: null,
    ...auditable(),
  },
  {
    id: 'lr-mgr-sick',
    employee_id: 'emp-mgr',
    leave_type_id: 'lt-sick',
    start_date: '2026-08-24',
    end_date: '2026-08-24',
    half_day: false,
    computed_working_days: 1,
    reason: 'Fever',
    attachment_url: null,
    status: 'approved',
    approver_id: 'usr-md',
    hr_approver_id: null,
    approved_at: '2026-08-25T04:00:00.000Z',
    rejection_reason: null,
    ...auditable(),
  },
];
