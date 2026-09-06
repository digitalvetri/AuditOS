/**
 * In-memory mock DB. Persisted to localStorage so a refresh preserves state
 * (§14 "Refreshing the page preserves state").
 *
 * This is intentionally a plain object graph — no ORM, no query builder.
 * MSW handlers read/write it directly and enforce authorization at the
 * handler layer (see middleware.ts). When we swap to a real backend, this
 * file goes away entirely.
 */

import * as seed from '@/data/seed';
import { buildAttendanceSeed } from '@/data/seed/attendance';
import { leaveTypes, holidays, leaveBalances, leaveRequests } from '@/data/seed/leave';
import { extraEmployees, extraUsers, articledTraining } from '@/data/seed/extraEmployees';
import { employeeDocuments } from '@/data/seed/documents';
import { expenseCategories, statutoryRates } from '@/data/seed/config';
import {
  ledgerTransactions,
  payments,
  payrollItems,
  payrollRuns,
  payslips,
  salaryStructures,
} from '@/data/seed/payroll';
import { expenseLedgerSeed, expensePaymentSeed, expenseSeed } from '@/data/seed/expenses';
import type {
  ArticledTraining,
  Attendance,
  AttendanceCorrection,
  AuditLog,
  Department,
  Designation,
  Employee,
  EmployeeDocument,
  Expense,
  ExpenseApproval,
  ExpenseCategory,
  Holiday,
  LeaveBalance,
  LeaveRequest,
  LeaveType,
  LedgerTransaction,
  Notification,
  Organisation,
  Payment,
  PayrollItem,
  PayrollRun,
  Payslip,
  Permission,
  Role,
  RolePermission,
  SalaryStructure,
  StatutoryRate,
  User,
  WorkLocation,
  WorkSchedule,
} from '@/data/models';

// v8: adds Expense + ExpenseApproval tables and seeded expenses/payments/ledger.
const STORAGE_KEY = 'audit-os:mock-db:v8';

export interface MockDB {
  organisation: Organisation;
  roles: Role[];
  permissions: Permission[];
  rolePermissions: RolePermission[];
  users: User[];
  employees: Employee[];
  articledTraining: ArticledTraining[];
  departments: Department[];
  designations: Designation[];
  workLocations: WorkLocation[];
  workSchedules: WorkSchedule[];
  attendance: Attendance[];
  corrections: AttendanceCorrection[];
  leaveTypes: LeaveType[];
  holidays: Holiday[];
  leaveBalances: LeaveBalance[];
  leaveRequests: LeaveRequest[];
  documents: EmployeeDocument[];
  expenseCategories: ExpenseCategory[];
  statutoryRates: StatutoryRate[];
  salaryStructures: SalaryStructure[];
  payrollRuns: PayrollRun[];
  payrollItems: PayrollItem[];
  payslips: Payslip[];
  payments: Payment[];
  ledger: LedgerTransaction[];
  expenses: Expense[];
  expenseApprovals: ExpenseApproval[];
  notifications: Notification[];
  auditLog: AuditLog[];
}

function freshDb(): MockDB {
  return {
    organisation: seed.organisation,
    roles: seed.roles,
    permissions: seed.permissions,
    rolePermissions: seed.rolePermissions,
    users: [...seed.users, ...extraUsers],
    employees: [...seed.employees, ...extraEmployees],
    articledTraining,
    departments: seed.departments,
    designations: seed.designations,
    workLocations: seed.workLocations,
    workSchedules: seed.workSchedules,
    attendance: buildAttendanceSeed(),
    corrections: [],
    leaveTypes,
    holidays,
    leaveBalances,
    leaveRequests,
    documents: employeeDocuments,
    expenseCategories,
    statutoryRates,
    salaryStructures,
    payrollRuns,
    payrollItems,
    payslips,
    payments: [...payments, ...expensePaymentSeed],
    ledger: [...ledgerTransactions, ...expenseLedgerSeed],
    expenses: expenseSeed,
    expenseApprovals: [],
    notifications: [],
    auditLog: [],
  };
}

function load(): MockDB {
  if (typeof localStorage === 'undefined') return freshDb();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshDb();
    return JSON.parse(raw) as MockDB;
  } catch {
    return freshDb();
  }
}

function persist(db: MockDB): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    // storage full or blocked — mock mode only, non-fatal
  }
}

let _db: MockDB = load();

export const db = {
  read: (): MockDB => _db,
  write: (mut: (draft: MockDB) => void): void => {
    mut(_db);
    persist(_db);
  },
  reset: (): void => {
    _db = freshDb();
    persist(_db);
  },
};

/** Utility — used by handlers to look up the caller's employee. */
export function employeeOf(user: User): Employee | null {
  if (!user.employee_id) return null;
  return _db.employees.find((e) => e.id === user.employee_id) ?? null;
}
