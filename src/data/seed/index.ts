/**
 * Minimum-viable seed for the scaffold session.
 *
 * Per the advisor: don't seed 90-day attendance, holidays, or statutory rates
 * until the modules that read them land. What's here is only what the shell +
 * auth session needs to log in as each of the 5 roles and see the sidebar and
 * dashboard render.
 *
 * IDs are deterministic strings (not UUIDs) so seed data reads cleanly in the
 * console during debugging. Swap to uuid when a real backend replaces MSW.
 */

import type {
  Department,
  Designation,
  Employee,
  Organisation,
  Permission,
  Role,
  RolePermission,
  User,
  WorkLocation,
  WorkSchedule,
} from '@/data/models';
import { MATRIX, type PermissionCode } from '@/platform/rbac/matrix';

const now = '2026-01-01T00:00:00.000Z';

const auditable = (createdBy: string | null = null) => ({
  created_at: now,
  updated_at: now,
  created_by: createdBy,
  updated_by: createdBy,
  deleted_at: null,
});

// ── Organisation ─────────────────────────────────────────────────────────
export const organisation: Organisation = {
  id: 'org-audit-os',
  name: 'Audit OS',
  timezone: 'Asia/Kolkata',
  currency: 'INR',
  fiscal_year_start_month: 4,
  ...auditable(),
};

// ── Departments (minimum: HR + Ops; full 8 land with Employees module) ──
export const departments: Department[] = [
  { id: 'dep-hr', organisation_id: organisation.id, name: 'HR', code: 'HR', ...auditable() },
  { id: 'dep-ops', organisation_id: organisation.id, name: 'Operations', code: 'OPS', ...auditable() },
  { id: 'dep-fin', organisation_id: organisation.id, name: 'Finance', code: 'FIN', ...auditable() },
  { id: 'dep-mgmt', organisation_id: organisation.id, name: 'Management', code: 'MGMT', ...auditable() },
];

// ── Designations ─────────────────────────────────────────────────────────
export const designations: Designation[] = [
  { id: 'des-md', organisation_id: organisation.id, name: 'Managing Partner', ...auditable() },
  { id: 'des-hr', organisation_id: organisation.id, name: 'HR Manager', ...auditable() },
  { id: 'des-fin', organisation_id: organisation.id, name: 'Finance Manager', ...auditable() },
  { id: 'des-mgr', organisation_id: organisation.id, name: 'Audit Manager', ...auditable() },
  { id: 'des-exec', organisation_id: organisation.id, name: 'Audit Executive', ...auditable() },
];

// ── Work locations ───────────────────────────────────────────────────────
// [DECIDE] placeholder — Chennai city coordinates. Change here for real HQ.
export const workLocations: WorkLocation[] = [
  {
    id: 'wl-hq',
    organisation_id: organisation.id,
    name: 'Head Office · Chennai',
    address: 'Chennai, Tamil Nadu',
    latitude: 13.0827,
    longitude: 80.2707,
    radius_m: 150,
    is_active: true,
    ...auditable(),
  },
  {
    id: 'wl-branch',
    organisation_id: organisation.id,
    name: 'Branch · T. Nagar',
    address: 'T. Nagar, Chennai',
    latitude: 13.0418,
    longitude: 80.2341,
    radius_m: 150,
    is_active: true,
    ...auditable(),
  },
];

// ── Work schedule ────────────────────────────────────────────────────────
export const workSchedules: WorkSchedule[] = [
  {
    id: 'ws-standard',
    organisation_id: organisation.id,
    name: 'Standard (Mon–Sat, 2nd/4th Sat off)',
    standard_start: '09:30',
    standard_end: '18:30',
    full_day_hours: 8,
    half_day_hours: 4,
    break_minutes: 60,
    working_days: [1, 2, 3, 4, 5, 6], // Mon..Sat; alternate Sat handled by flag
    alternate_saturday_off: true,
    ...auditable(),
  },
];

// ── Roles ────────────────────────────────────────────────────────────────
export const roles: Role[] = [
  { id: 'role-employee', code: 'employee', name: 'Employee', ...auditable() },
  { id: 'role-dept-manager', code: 'dept_manager', name: 'Department Manager', ...auditable() },
  { id: 'role-hr-admin', code: 'hr_admin', name: 'HR Admin', ...auditable() },
  { id: 'role-finance-admin', code: 'finance_admin', name: 'Finance Admin', ...auditable() },
  { id: 'role-md', code: 'md', name: 'MD / Super Admin', ...auditable() },
];

// ── Permissions — derived from the matrix, unique codes ─────────────────
const uniquePermissionCodes = Array.from(
  new Set(
    Object.values(MATRIX).flatMap((grants) => grants.map((g) => g.permission)),
  ),
) as PermissionCode[];

export const permissions: Permission[] = uniquePermissionCodes.map((code) => ({
  id: `perm-${code}`,
  code,
  description: code,
  ...auditable(),
}));

export const rolePermissions: RolePermission[] = roles.flatMap((role) =>
  MATRIX[role.code].map((grant) => ({
    role_id: role.id,
    permission_id: `perm-${grant.permission}`,
    scope: grant.scope,
  })),
);

// ── Employees + Users (one per role for demo logins) ────────────────────
// Password stored as 'plain:<pw>' — mock only. Real backend hashes.
export const employees: Employee[] = [
  {
    id: 'emp-md',
    organisation_id: organisation.id,
    employee_code: 'AO-0001',
    first_name: 'Ravi',
    last_name: 'Krishnan',
    full_name: 'Ravi Krishnan',
    type: 'partner',
    status: 'active',
    designation_id: 'des-md',
    department_id: 'dep-mgmt',
    manager_id: null,
    work_location_id: 'wl-hq',
    work_schedule_id: 'ws-standard',
    email: 'ravi@auditos.local',
    phone: '+91 98400 00001',
    joining_date: '2018-04-01',
    exit_date: null,
    exit_reason: null,
    notice_period_days: 90,
    weekly_capacity_hours: null,
    photo_url: null,
    address: null,
    emergency_contact_name: null,
    emergency_contact_phone: null,
    bank_account_masked: '••••4321',
    ...auditable(),
  },
  {
    id: 'emp-hr',
    organisation_id: organisation.id,
    employee_code: 'AO-0002',
    first_name: 'Priya',
    last_name: 'Nair',
    full_name: 'Priya Nair',
    type: 'manager',
    status: 'active',
    designation_id: 'des-hr',
    department_id: 'dep-hr',
    manager_id: 'emp-md',
    work_location_id: 'wl-hq',
    work_schedule_id: 'ws-standard',
    email: 'priya@auditos.local',
    phone: '+91 98400 00002',
    joining_date: '2020-06-15',
    exit_date: null,
    exit_reason: null,
    notice_period_days: 60,
    weekly_capacity_hours: null,
    photo_url: null,
    address: null,
    emergency_contact_name: null,
    emergency_contact_phone: null,
    bank_account_masked: '••••8765',
    ...auditable(),
  },
  {
    id: 'emp-fin',
    organisation_id: organisation.id,
    employee_code: 'AO-0003',
    first_name: 'Anitha',
    last_name: 'Rao',
    full_name: 'Anitha Rao',
    type: 'manager',
    status: 'active',
    designation_id: 'des-fin',
    department_id: 'dep-fin',
    manager_id: 'emp-md',
    work_location_id: 'wl-hq',
    work_schedule_id: 'ws-standard',
    email: 'anitha@auditos.local',
    phone: '+91 98400 00003',
    joining_date: '2021-01-10',
    exit_date: null,
    exit_reason: null,
    notice_period_days: 60,
    weekly_capacity_hours: null,
    photo_url: null,
    address: null,
    emergency_contact_name: null,
    emergency_contact_phone: null,
    bank_account_masked: '••••1122',
    ...auditable(),
  },
  {
    id: 'emp-mgr',
    organisation_id: organisation.id,
    employee_code: 'AO-0004',
    first_name: 'Vikram',
    last_name: 'Shetty',
    full_name: 'Vikram Shetty',
    type: 'manager',
    status: 'active',
    designation_id: 'des-mgr',
    department_id: 'dep-ops',
    manager_id: 'emp-md',
    work_location_id: 'wl-hq',
    work_schedule_id: 'ws-standard',
    email: 'vikram@auditos.local',
    phone: '+91 98400 00004',
    joining_date: '2019-08-01',
    exit_date: null,
    exit_reason: null,
    notice_period_days: 60,
    weekly_capacity_hours: null,
    photo_url: null,
    address: null,
    emergency_contact_name: null,
    emergency_contact_phone: null,
    bank_account_masked: '••••3344',
    ...auditable(),
  },
  {
    id: 'emp-exec',
    organisation_id: organisation.id,
    employee_code: 'AO-0005',
    first_name: 'Meera',
    last_name: 'Iyer',
    full_name: 'Meera Iyer',
    type: 'executive',
    status: 'active',
    designation_id: 'des-exec',
    department_id: 'dep-ops',
    manager_id: 'emp-mgr',
    work_location_id: 'wl-hq',
    work_schedule_id: 'ws-standard',
    email: 'meera@auditos.local',
    phone: '+91 98400 00005',
    joining_date: '2023-04-01',
    exit_date: null,
    exit_reason: null,
    notice_period_days: 30,
    weekly_capacity_hours: 40,
    photo_url: null,
    address: null,
    emergency_contact_name: null,
    emergency_contact_phone: null,
    bank_account_masked: '••••5566',
    ...auditable(),
  },
];

export const users: User[] = [
  {
    id: 'usr-md',
    organisation_id: organisation.id,
    email: 'ravi@auditos.local',
    password_hash: 'plain:md',
    role_id: 'role-md',
    employee_id: 'emp-md',
    is_active: true,
    last_login_at: null,
    ...auditable(),
  },
  {
    id: 'usr-hr',
    organisation_id: organisation.id,
    email: 'priya@auditos.local',
    password_hash: 'plain:hr',
    role_id: 'role-hr-admin',
    employee_id: 'emp-hr',
    is_active: true,
    last_login_at: null,
    ...auditable(),
  },
  {
    id: 'usr-fin',
    organisation_id: organisation.id,
    email: 'anitha@auditos.local',
    password_hash: 'plain:fin',
    role_id: 'role-finance-admin',
    employee_id: 'emp-fin',
    is_active: true,
    last_login_at: null,
    ...auditable(),
  },
  {
    id: 'usr-mgr',
    organisation_id: organisation.id,
    email: 'vikram@auditos.local',
    password_hash: 'plain:mgr',
    role_id: 'role-dept-manager',
    employee_id: 'emp-mgr',
    is_active: true,
    last_login_at: null,
    ...auditable(),
  },
  {
    id: 'usr-emp',
    organisation_id: organisation.id,
    email: 'meera@auditos.local',
    password_hash: 'plain:emp',
    role_id: 'role-employee',
    employee_id: 'emp-exec',
    is_active: true,
    last_login_at: null,
    ...auditable(),
  },
];

/** Shown on the login screen when VITE_MOCK_MODE=true. */
export const demoCredentials = [
  { role: 'MD / Super Admin', email: 'ravi@auditos.local', password: 'md' },
  { role: 'HR Admin', email: 'priya@auditos.local', password: 'hr' },
  { role: 'Finance Admin', email: 'anitha@auditos.local', password: 'fin' },
  { role: 'Dept Manager', email: 'vikram@auditos.local', password: 'mgr' },
  { role: 'Employee', email: 'meera@auditos.local', password: 'emp' },
] as const;
