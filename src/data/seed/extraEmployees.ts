/**
 * Extension employees + articled training + one inactive record.
 *
 * Keeps the base 5-role seed intact (login credentials remain stable) and
 * adds three more people so the Employees list has range:
 *   - one Articled Assistant (with ArticledTraining sub-record)
 *   - one Probation employee
 *   - one Inactive (soft-deleted, no login)
 */

import type { ArticledTraining, Employee, User } from '@/data/models';
import { organisation } from './index';

const now = new Date().toISOString();
const audit = () => ({
  created_at: now,
  updated_at: now,
  created_by: null,
  updated_by: null,
  deleted_at: null as string | null,
});

export const extraEmployees: Employee[] = [
  {
    id: 'emp-articled',
    organisation_id: organisation.id,
    employee_code: 'AO-0006',
    first_name: 'Karthik',
    last_name: 'Subramanian',
    full_name: 'Karthik Subramanian',
    type: 'articled',
    status: 'active',
    designation_id: 'des-exec',
    department_id: 'dep-ops',
    manager_id: 'emp-mgr',
    work_location_id: 'wl-hq',
    work_schedule_id: 'ws-standard',
    email: 'karthik@auditos.local',
    phone: '+91 98400 00006',
    joining_date: '2025-07-01',
    exit_date: null,
    exit_reason: null,
    notice_period_days: 30,
    weekly_capacity_hours: 40,
    photo_url: null,
    address: null,
    emergency_contact_name: 'Subramanian K',
    emergency_contact_phone: '+91 98400 99006',
    bank_account_masked: '••••7788',
    ...audit(),
  },
  {
    id: 'emp-probation',
    organisation_id: organisation.id,
    employee_code: 'AO-0007',
    first_name: 'Divya',
    last_name: 'Menon',
    full_name: 'Divya Menon',
    type: 'executive',
    status: 'probation',
    designation_id: 'des-exec',
    department_id: 'dep-ops',
    manager_id: 'emp-mgr',
    work_location_id: 'wl-hq',
    work_schedule_id: 'ws-standard',
    email: 'divya@auditos.local',
    phone: '+91 98400 00007',
    joining_date: '2026-07-01', // 2 months into probation
    exit_date: null,
    exit_reason: null,
    notice_period_days: 30,
    weekly_capacity_hours: 40,
    photo_url: null,
    address: null,
    emergency_contact_name: null,
    emergency_contact_phone: null,
    bank_account_masked: '••••9911',
    ...audit(),
  },
  {
    id: 'emp-inactive',
    organisation_id: organisation.id,
    employee_code: 'AO-0008',
    first_name: 'Prakash',
    last_name: 'Iyer',
    full_name: 'Prakash Iyer',
    type: 'executive',
    status: 'inactive',
    designation_id: 'des-exec',
    department_id: 'dep-ops',
    manager_id: 'emp-mgr',
    work_location_id: 'wl-hq',
    work_schedule_id: 'ws-standard',
    email: 'prakash@auditos.local',
    phone: '+91 98400 00008',
    joining_date: '2023-01-15',
    exit_date: '2026-06-30',
    exit_reason: 'Personal',
    notice_period_days: 30,
    weekly_capacity_hours: null,
    photo_url: null,
    address: null,
    emergency_contact_name: null,
    emergency_contact_phone: null,
    bank_account_masked: '••••4455',
    ...audit(),
    deleted_at: '2026-07-01T00:00:00.000Z',
  },
];

/**
 * A login for the Articled — useful for verifying that the Articled tab
 * appears on their own profile. No login for the Inactive employee — that's
 * exactly the "employee without a user" case per §4.2.
 */
export const extraUsers: User[] = [
  {
    id: 'usr-articled',
    organisation_id: organisation.id,
    email: 'karthik@auditos.local',
    password_hash: 'plain:art',
    role_id: 'role-employee',
    employee_id: 'emp-articled',
    is_active: true,
    last_login_at: null,
    ...audit(),
  },
];

export const articledTraining: ArticledTraining[] = [
  {
    id: 'at-karthik',
    employee_id: 'emp-articled',
    icai_registration_no: 'SRO-0451234',
    principal_employee_id: 'emp-md', // registered under the MD (Partner)
    training_start: '2025-07-01',
    training_end: '2028-06-30',
    current_year: 1,
    stipend_slab: 'YEAR_1_METRO',
    status: 'active',
    ...audit(),
  },
];
