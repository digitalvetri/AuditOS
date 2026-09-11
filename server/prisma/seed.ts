/**
 * DEVELOPMENT SEED.
 *
 * Mirrors the Part 1 mock dataset so switching VITE_MOCK_MODE off lands on the
 * same organisation, the same six demo logins and comparable figures. Nothing
 * here is production data: passwords are the short demo strings documented in
 * the README, hashed with bcrypt before they touch the database.
 *
 * Idempotent — safe to re-run. `npm run db:reset` drops the file first.
 */
// Load .env before Prisma initialises. env.ts autoloads server/.env into
// process.env on first import; the side-effect is the whole point here.
import '../src/lib/env.js'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { addDays, istToday } from '../src/lib/dates.js'
import { computeCheckOutStatus } from '../src/domain/attendanceStatus.js'
import { calculatePayrollItem } from '../src/domain/payroll/calc.js'
import { snapshotAt } from '../src/domain/payroll/statutory.js'
import { ALL_PERMISSION_CODES, MATRIX, PERMISSION_DESCRIPTIONS, type RoleCode } from '../src/platform/rbac/matrix.js'
import { seedWorkstation } from './seed-workstation.js'
import { seedTools } from './seed-tools.js'
import { seedAuditAutomation } from './seed-audit-automation.js'
import { seedBooks } from './seed-books.js'
import { seedBookkeeping } from './seed-bookkeeping.js'
import { seedIncorporation } from './seed-incorporation.js'
import { seedRegistration } from './seed-registration.js'

const prisma = new PrismaClient()

const TODAY = istToday()
const FY_START = `${Number(TODAY.slice(0, 4))}-04-01`
const hash = (plain: string) => bcrypt.hashSync(plain, 10)

/** Deterministic PRNG so a reseed produces the same attendance every time. */
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(20260906)

/** IST HH:mm on an IST calendar date → the UTC instant to store. */
function istInstant(dateISO: string, hh: number, mm: number): Date {
  const [y, m, d] = dateISO.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - 330 * 60_000)
}

function isWorkingDay(dateISO: string): boolean {
  const [y, m, d] = dateISO.split('-').map(Number)
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  if (day === 0) return false
  if (day === 6) {
    const nth = Math.ceil(d / 7)
    return !(nth === 2 || nth === 4)
  }
  return true
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

async function main() {
  console.log('Seeding Audit OS HRMS…')

  // ── Organisation ────────────────────────────────────────────────────────
  const org = await prisma.organisation.upsert({
    where: { id: 'org-audit-os' },
    update: {},
    create: {
      id: 'org-audit-os',
      name: 'Audit OS',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      fiscalYearStartMonth: 4,
    },
  })

  // ── Permissions + roles, derived from the matrix (never hand-listed) ────
  for (const code of ALL_PERMISSION_CODES) {
    await prisma.permission.upsert({
      where: { code },
      update: { description: PERMISSION_DESCRIPTIONS[code] ?? code },
      create: { id: `perm-${code}`, code, description: PERMISSION_DESCRIPTIONS[code] ?? code },
    })
  }

  const ROLES: { id: string; code: RoleCode; name: string; description: string }[] = [
    { id: 'role-employee', code: 'employee', name: 'Employee', description: 'Own records only' },
    { id: 'role-dept-manager', code: 'dept_manager', name: 'Department Manager', description: 'Owns one department' },
    { id: 'role-hr-admin', code: 'hr_admin', name: 'HR Admin', description: 'Full HR visibility and configuration' },
    { id: 'role-finance-admin', code: 'finance_admin', name: 'Finance Admin', description: 'Payroll approval, ledger and payments' },
    { id: 'role-md', code: 'md', name: 'MD / Super Admin', description: 'Full visibility across the firm' },
  ]
  for (const r of ROLES) {
    await prisma.role.upsert({
      where: { code: r.code },
      update: { name: r.name, description: r.description },
      create: { id: r.id, code: r.code, name: r.name, description: r.description },
    })
    // Rewrite the grants from the matrix so the DB can never drift from it.
    await prisma.rolePermission.deleteMany({ where: { roleId: r.id } })
    for (const grant of MATRIX[r.code]) {
      await prisma.rolePermission.create({
        data: { roleId: r.id, permissionId: `perm-${grant.permission}`, scope: grant.scope },
      })
    }
  }

  // ── Departments, designations, locations, schedule ──────────────────────
  const departments = [
    { id: 'dep-hr', name: 'HR', code: 'HR' },
    { id: 'dep-ops', name: 'Operations', code: 'OPS' },
    { id: 'dep-fin', name: 'Finance', code: 'FIN' },
    { id: 'dep-mgmt', name: 'Management', code: 'MGMT' },
  ]
  for (const d of departments) {
    await prisma.department.upsert({
      where: { code: d.code },
      update: { name: d.name },
      create: { ...d, organisationId: org.id },
    })
  }

  const designations = [
    { id: 'des-md', name: 'Managing Partner' },
    { id: 'des-hr', name: 'HR Manager' },
    { id: 'des-fin', name: 'Finance Manager' },
    { id: 'des-mgr', name: 'Audit Manager' },
    { id: 'des-exec', name: 'Audit Executive' },
  ]
  for (const d of designations) {
    await prisma.designation.upsert({
      where: { id: d.id }, update: { name: d.name },
      create: { ...d, organisationId: org.id },
    })
  }

  const locations = [
    { id: 'wl-hq', name: 'Head Office · Chennai', address: 'Chennai, Tamil Nadu', latitude: 13.0827, longitude: 80.2707 },
    { id: 'wl-branch', name: 'Branch · T. Nagar', address: 'T. Nagar, Chennai', latitude: 13.0418, longitude: 80.2341 },
  ]
  for (const l of locations) {
    await prisma.workLocation.upsert({
      where: { id: l.id }, update: {},
      create: { ...l, organisationId: org.id, radiusM: 150, isActive: true },
    })
  }

  await prisma.workSchedule.upsert({
    where: { id: 'ws-standard' },
    update: {},
    create: {
      id: 'ws-standard',
      organisationId: org.id,
      name: 'Standard (Mon–Sat, 2nd/4th Sat off)',
      standardStart: '09:30',
      standardEnd: '18:30',
      fullDayHours: 8,
      halfDayHours: 4,
      breakMinutes: 60,
      workingDaysJson: JSON.stringify([1, 2, 3, 4, 5, 6]),
      alternateSaturdayOff: true,
    },
  })

  // ── Employees + logins ──────────────────────────────────────────────────
  const employees = [
    {
      id: 'emp-md', code: 'AO-0001', first: 'Ravi', last: 'Krishnan', type: 'partner', status: 'active',
      designationId: 'des-md', departmentId: 'dep-mgmt', managerId: null,
      email: 'ravi@auditos.local', phone: '+91 98400 00001', joining: '2018-04-01',
      notice: 90, bank: '••••4321',
    },
    {
      id: 'emp-hr', code: 'AO-0002', first: 'Priya', last: 'Nair', type: 'manager', status: 'active',
      designationId: 'des-hr', departmentId: 'dep-hr', managerId: 'emp-md',
      email: 'priya@auditos.local', phone: '+91 98400 00002', joining: '2020-06-15',
      notice: 60, bank: '••••8765',
    },
    {
      id: 'emp-fin', code: 'AO-0003', first: 'Anitha', last: 'Rao', type: 'manager', status: 'active',
      designationId: 'des-fin', departmentId: 'dep-fin', managerId: 'emp-md',
      email: 'anitha@auditos.local', phone: '+91 98400 00003', joining: '2021-01-10',
      notice: 60, bank: '••••1122',
    },
    {
      id: 'emp-mgr', code: 'AO-0004', first: 'Vikram', last: 'Shetty', type: 'manager', status: 'active',
      designationId: 'des-mgr', departmentId: 'dep-ops', managerId: 'emp-md',
      email: 'vikram@auditos.local', phone: '+91 98400 00004', joining: '2019-08-01',
      notice: 60, bank: '••••3344',
    },
    {
      id: 'emp-exec', code: 'AO-0005', first: 'Meera', last: 'Iyer', type: 'executive', status: 'active',
      designationId: 'des-exec', departmentId: 'dep-ops', managerId: 'emp-mgr',
      email: 'meera@auditos.local', phone: '+91 98400 00005', joining: '2023-04-01',
      notice: 30, bank: '••••5566',
    },
    {
      id: 'emp-articled', code: 'AO-0006', first: 'Karthik', last: 'Subramanian', type: 'articled', status: 'active',
      designationId: 'des-exec', departmentId: 'dep-ops', managerId: 'emp-mgr',
      email: 'karthik@auditos.local', phone: '+91 98400 00006', joining: '2025-07-01',
      notice: 30, bank: '••••7788',
    },
    {
      id: 'emp-probation', code: 'AO-0007', first: 'Divya', last: 'Menon', type: 'executive', status: 'probation',
      designationId: 'des-exec', departmentId: 'dep-ops', managerId: 'emp-mgr',
      email: 'divya@auditos.local', phone: '+91 98400 00007', joining: addDays(TODAY, -60),
      notice: 30, bank: '••••9911',
    },
    // An exited employee with no login — the "employee without a user" case (§4.2).
    {
      id: 'emp-inactive', code: 'AO-0008', first: 'Prakash', last: 'Iyer', type: 'executive', status: 'inactive',
      designationId: 'des-exec', departmentId: 'dep-ops', managerId: 'emp-mgr',
      email: 'prakash@auditos.local', phone: '+91 98400 00008', joining: '2023-01-15',
      notice: 30, bank: '••••4455', exit: addDays(TODAY, -68), exitReason: 'Personal',
      deleted: true,
    },
  ]

  for (const e of employees) {
    await prisma.employee.upsert({
      where: { id: e.id },
      update: {},
      create: {
        id: e.id,
        organisationId: org.id,
        employeeCode: e.code,
        firstName: e.first,
        lastName: e.last,
        fullName: `${e.first} ${e.last}`,
        type: e.type,
        status: e.status,
        designationId: e.designationId,
        departmentId: e.departmentId,
        managerId: null, // linked in a second pass so self-references resolve
        workLocationId: 'wl-hq',
        workScheduleId: 'ws-standard',
        email: e.email,
        phone: e.phone,
        joiningDate: e.joining,
        exitDate: e.exit ?? null,
        exitReason: e.exitReason ?? null,
        noticePeriodDays: e.notice,
        weeklyCapacityHours: e.type === 'partner' || e.type === 'manager' ? null : 40,
        bankAccountMasked: e.bank,
        deletedAt: e.deleted ? new Date(`${e.exit}T00:00:00.000Z`) : null,
      },
    })
  }
  for (const e of employees) {
    if (e.managerId) {
      await prisma.employee.update({ where: { id: e.id }, data: { managerId: e.managerId } })
    }
  }

  // Demo logins. Passwords are documented in the README and are development
  // credentials only — production seeds must not use them.
  const users = [
    { id: 'usr-md', employeeId: 'emp-md', email: 'ravi@auditos.local', password: 'md', roleId: 'role-md' },
    { id: 'usr-hr', employeeId: 'emp-hr', email: 'priya@auditos.local', password: 'hr', roleId: 'role-hr-admin' },
    { id: 'usr-fin', employeeId: 'emp-fin', email: 'anitha@auditos.local', password: 'fin', roleId: 'role-finance-admin' },
    { id: 'usr-mgr', employeeId: 'emp-mgr', email: 'vikram@auditos.local', password: 'mgr', roleId: 'role-dept-manager' },
    { id: 'usr-emp', employeeId: 'emp-exec', email: 'meera@auditos.local', password: 'emp', roleId: 'role-employee' },
    { id: 'usr-articled', employeeId: 'emp-articled', email: 'karthik@auditos.local', password: 'art', roleId: 'role-employee' },
    { id: 'usr-probation', employeeId: 'emp-probation', email: 'divya@auditos.local', password: 'prb', roleId: 'role-employee' },
  ]
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash: hash(u.password), roleId: u.roleId },
      create: {
        id: u.id,
        organisationId: org.id,
        email: u.email,
        passwordHash: hash(u.password),
        roleId: u.roleId,
        employeeId: u.employeeId,
        isActive: true,
      },
    })
  }

  await prisma.articledTraining.upsert({
    where: { employeeId: 'emp-articled' },
    update: {},
    create: {
      id: 'at-karthik',
      employeeId: 'emp-articled',
      icaiRegistrationNo: 'SRO-0451234',
      principalEmployeeId: 'emp-md',
      trainingStart: '2025-07-01',
      trainingEnd: '2028-06-30',
      currentYear: 1,
      stipendSlab: 'YEAR_1_METRO',
      status: 'active',
    },
  })

  // ── Leave types, holidays, balances ─────────────────────────────────────
  const leaveTypes = [
    { id: 'lt-casual', code: 'casual', name: 'Casual', entitlement: 12, carry: 0, half: true, notice: 1, probation: true },
    { id: 'lt-sick', code: 'sick', name: 'Sick', entitlement: 12, carry: 0, half: false, notice: 0, probation: true },
    { id: 'lt-earned', code: 'earned', name: 'Earned', entitlement: 15, carry: 30, half: true, notice: 7, probation: false },
    { id: 'lt-lop', code: 'lop', name: 'Loss of Pay', entitlement: null, carry: 0, half: false, notice: 0, probation: true },
    { id: 'lt-compoff', code: 'comp_off', name: 'Comp Off', entitlement: 0, carry: 0, half: false, notice: 1, probation: true },
  ]
  for (const t of leaveTypes) {
    await prisma.leaveType.upsert({
      where: { organisationId_code: { organisationId: org.id, code: t.code } },
      update: {},
      create: {
        id: t.id,
        organisationId: org.id,
        code: t.code,
        name: t.name,
        annualEntitlement: t.entitlement,
        accrual: t.code === 'comp_off' ? 'earned' : 'monthly',
        carryForwardMax: t.carry,
        halfDayAllowed: t.half,
        minNoticeDays: t.notice,
        accrueDuringProbation: t.probation,
      },
    })
  }

  const year = Number(TODAY.slice(0, 4))
  const holidays = [
    [`${year}-01-01`, "New Year's Day", false],
    [`${year}-01-14`, 'Pongal', false],
    [`${year}-01-15`, 'Thiruvalluvar Day', false],
    [`${year}-01-26`, 'Republic Day', false],
    [`${year}-04-14`, 'Tamil New Year', false],
    [`${year}-05-01`, 'May Day', false],
    [`${year}-08-15`, 'Independence Day', false],
    [`${year}-10-02`, 'Gandhi Jayanti', false],
    [`${year}-10-19`, 'Ayudha Pooja', false],
    [`${year}-10-20`, 'Vijayadasami', false],
    [`${year}-11-08`, 'Deepavali', false],
    [`${year}-12-25`, 'Christmas', false],
  ] as [string, string, boolean][]
  for (const [date, name, optional] of holidays) {
    const existing = await prisma.holiday.findFirst({ where: { date, deletedAt: null } })
    if (!existing) {
      await prisma.holiday.create({
        data: { organisationId: org.id, date, name, isOptional: optional },
      })
    }
  }

  const activeEmployees = employees.filter((e) => e.status !== 'inactive')
  for (const e of activeEmployees) {
    for (const t of leaveTypes) {
      // Earned leave does not accrue during probation.
      if (t.code === 'earned' && e.status === 'probation') continue
      const entitled =
        t.code === 'casual' ? 6
        : t.code === 'sick' ? 6
        : t.code === 'earned' ? 7.5
        : t.code === 'comp_off' ? (e.id === 'emp-mgr' ? 1 : 0)
        : 0
      const availed =
        t.code === 'casual' ? (e.id === 'emp-exec' ? 3 : e.id === 'emp-mgr' ? 1 : 0)
        : t.code === 'sick' ? (e.id === 'emp-exec' ? 1.5 : 0)
        : t.code === 'earned' ? (e.id === 'emp-md' ? 2 : 0)
        : 0
      await prisma.leaveBalance.upsert({
        where: {
          employeeId_leaveTypeId_fiscalYearStart: {
            employeeId: e.id, leaveTypeId: t.id, fiscalYearStart: FY_START,
          },
        },
        update: {},
        create: {
          employeeId: e.id, leaveTypeId: t.id, fiscalYearStart: FY_START,
          entitled, availed, carriedForward: 0,
        },
      })
    }
  }

  // Two pending requests so the approval queue is not empty on first load.
  if ((await prisma.leaveRequest.count()) === 0) {
    await prisma.leaveRequest.create({
      data: {
        id: 'lr-emp-casual', employeeId: 'emp-exec', leaveTypeId: 'lt-casual',
        startDate: addDays(TODAY, 8), endDate: addDays(TODAY, 9), halfDay: false,
        computedWorkingDays: 2, reason: 'Family function', status: 'pending',
      },
    })
    await prisma.leaveRequest.create({
      data: {
        id: 'lr-emp-earned', employeeId: 'emp-exec', leaveTypeId: 'lt-earned',
        startDate: addDays(TODAY, 30), endDate: addDays(TODAY, 39), halfDay: false,
        // > 5 days, so this one escalates to HR after the manager approves.
        computedWorkingDays: 8, reason: 'Vacation with family', status: 'pending',
      },
    })
  }

  // ── Statutory rates ─────────────────────────────────────────────────────
  const rates = [
    ['pf.employee_rate', '0.12', '[VERIFY] EPF employee contribution rate'],
    ['pf.employer_rate', '0.12', '[VERIFY] EPF employer contribution rate'],
    ['pf.wage_ceiling', '15000', '[VERIFY] EPF monthly wage ceiling in rupees'],
    ['esi.gross_threshold', '21000', '[VERIFY] ESI applies when monthly gross ≤ this amount'],
    ['esi.employee_rate', '0.0075', '[VERIFY] ESI employee rate'],
    ['esi.employer_rate', '0.0325', '[VERIFY] ESI employer rate'],
    ['pt.tn.slab', JSON.stringify([
      { half_yearly_income_up_to: 21000, tax_amount: 0 },
      { half_yearly_income_up_to: 30000, tax_amount: 135 },
      { half_yearly_income_up_to: 45000, tax_amount: 315 },
      { half_yearly_income_up_to: 60000, tax_amount: 690 },
      { half_yearly_income_up_to: 75000, tax_amount: 1025 },
      { half_yearly_income_up_to: Number.MAX_SAFE_INTEGER, tax_amount: 1250 },
    ]), '[VERIFY] Tamil Nadu half-yearly Professional Tax slab'],
    ['gratuity.eligible_after_years', '5', '[VERIFY] Continuous service years for gratuity eligibility'],
  ] as const
  for (const [code, value, notes] of rates) {
    const existing = await prisma.statutoryRate.findFirst({ where: { code, deletedAt: null } })
    if (!existing) {
      await prisma.statutoryRate.create({
        data: {
          organisationId: org.id, code, value,
          effectiveFrom: '2020-04-01', effectiveTo: null, notes,
        },
      })
    }
  }

  // ── Expense categories ──────────────────────────────────────────────────
  const categories = [
    { id: 'ec-travel', name: 'Travel', code: 'TRAVEL', gl: '6100-Travel' },
    { id: 'ec-meals', name: 'Meals & Entertainment', code: 'MEALS', gl: '6110-Meals' },
    { id: 'ec-phone', name: 'Phone & Internet', code: 'PHONE', gl: '6200-Comms', receipt: false },
    { id: 'ec-sub', name: 'Subscriptions', code: 'SUB', gl: '6300-Subs' },
    { id: 'ec-office', name: 'Office Supplies', code: 'OFFICE', gl: '6400-Office' },
    { id: 'ec-other', name: 'Other', code: 'OTHER', gl: '6900-Other' },
  ]
  for (const c of categories) {
    await prisma.expenseCategory.upsert({
      where: { code: c.code },
      update: {},
      create: {
        id: c.id, organisationId: org.id, name: c.name, code: c.code,
        isActive: true, requiresReceipt: c.receipt ?? true, glAccount: c.gl,
      },
    })
  }

  // ── Documents ───────────────────────────────────────────────────────────
  const documents = [
    { id: 'doc-md-offer', employeeId: 'emp-md', name: 'Offer letter — Managing Partner', type: 'employment', expiry: null, status: 'valid' },
    { id: 'doc-hr-idcard', employeeId: 'emp-hr', name: 'ID card — Priya Nair', type: 'company_issued', expiry: addDays(TODAY, 400), status: 'valid' },
    { id: 'doc-exec-cert', employeeId: 'emp-exec', name: 'CA Intermediate certificate', type: 'certificate', expiry: null, status: 'valid' },
    { id: 'doc-exec-pan', employeeId: 'emp-exec', name: 'PAN card', type: 'tax', expiry: null, status: 'valid' },
    { id: 'doc-articled-icai', employeeId: 'emp-articled', name: 'ICAI registration letter', type: 'icai', expiry: null, status: 'valid' },
    // Expiring soon — surfaces in the dashboard Pending Actions queue.
    { id: 'doc-mgr-passport', employeeId: 'emp-mgr', name: 'Passport', type: 'hr', expiry: addDays(TODAY, 20), status: 'valid' },
    { id: 'doc-fin-tds', employeeId: 'emp-fin', name: 'TDS declaration', type: 'tax', expiry: addDays(TODAY, -10), status: 'valid' },
    { id: 'doc-probation-bank', employeeId: 'emp-probation', name: 'Bank details', type: 'bank', expiry: null, status: 'pending_verification', uploader: 'usr-probation' },
  ]
  for (const d of documents) {
    await prisma.employeeDocument.upsert({
      where: { id: d.id },
      update: {},
      create: {
        id: d.id, employeeId: d.employeeId, name: d.name, type: d.type,
        fileKey: `seed/${d.id}.pdf`, uploadedBy: d.uploader ?? 'usr-hr',
        expiryDate: d.expiry, status: d.status,
      },
    })
  }

  // ── Attendance: 45 back-dated working days with realistic variance ───────
  if ((await prisma.attendance.count()) === 0) {
    const attendanceEmployees = activeEmployees.map((e) => e.id)
    const holidaySet = new Set(holidays.map(([d]) => d))
    for (let back = 45; back >= 1; back--) {
      const date = addDays(TODAY, -back)
      if (!isWorkingDay(date) || holidaySet.has(date)) continue
      for (const employeeId of attendanceEmployees) {
        const roll = rand()
        if (roll > 0.94) {
          await prisma.attendance.create({
            data: { employeeId, date, status: 'absent', source: 'web_geo' },
          })
          continue
        }
        const inH = 9
        const inM = 15 + Math.floor(rand() * 40) // 09:15–09:55
        const outH = 18
        const outM = Math.floor(rand() * 60)
        const checkIn = istInstant(date, inH, inM)
        const checkOut = istInstant(date, outH, outM)
        const computed = computeCheckOutStatus(checkIn, checkOut)
        const offsite = rand() > 0.85
        await prisma.attendance.create({
          data: {
            employeeId,
            date,
            checkInAt: checkIn,
            checkOutAt: checkOut,
            checkInLat: 13.0827,
            checkInLong: 80.2707,
            checkInAccuracyM: 12,
            checkOutLat: 13.0827,
            checkOutLong: 80.2707,
            checkOutAccuracyM: 14,
            checkInLocationId: offsite ? null : 'wl-hq',
            checkOutLocationId: offsite ? null : 'wl-hq',
            locationType: offsite ? 'client_site' : 'office',
            offSiteReason: offsite ? 'Field audit at client premises' : null,
            workedMinutes: computed.workedMinutes,
            breakMinutes: computed.breakMinutes,
            status: computed.status,
            source: 'web_geo',
          },
        })
      }
    }
  }

  // ── Salary structures ───────────────────────────────────────────────────
  const CTC_BY_TYPE: Record<string, number> = {
    partner: 3_600_000, manager: 1_500_000, executive: 720_000, articled: 480_000, support: 360_000,
  }
  for (const e of activeEmployees) {
    const existing = await prisma.salaryStructure.findFirst({ where: { employeeId: e.id } })
    if (existing) continue
    const monthly = (CTC_BY_TYPE[e.type] ?? 480_000) / 12
    const basic = monthly * 0.5
    const hra = basic * 0.4
    const conveyance = Math.min(1_600, monthly * 0.03)
    const special = monthly - basic - hra - conveyance
    const toPaise = (r: number) => Math.round(r) * 100
    await prisma.salaryStructure.create({
      data: {
        id: `ss-${e.id}`,
        employeeId: e.id,
        effectiveFrom: e.joining,
        effectiveTo: null,
        monthlyCtcPaise: toPaise(monthly),
        basicPaise: toPaise(basic),
        hraPaise: toPaise(hra),
        conveyancePaise: toPaise(conveyance),
        specialAllowancePaise: toPaise(special),
        customComponentsJson: '[]',
      },
    })
  }

  // ── Payroll: two processed months + one draft for the current month ─────
  if ((await prisma.payrollRun.count()) === 0) {
    const rateRows = await prisma.statutoryRate.findMany({
      where: { deletedAt: null },
      select: { code: true, value: true, effectiveFrom: true, effectiveTo: true },
    })
    const structures = await prisma.salaryStructure.findMany({ where: { deletedAt: null } })
    const currentYear = Number(TODAY.slice(0, 4))
    const currentMonth = Number(TODAY.slice(5, 7))

    let sequence = 0
    let running = 0
    let payslipNo = 0
    let paymentNo = 0

    for (let offset = 2; offset >= 1; offset--) {
      let m = currentMonth - offset
      let y = currentYear
      if (m <= 0) { m += 12; y -= 1 }
      const periodStart = `${y}-${String(m).padStart(2, '0')}-01`
      const periodEnd = `${y}-${String(m).padStart(2, '0')}-${lastDayOfMonth(y, m)}`
      const snap = snapshotAt(periodStart, rateRows)
      const payableDays = lastDayOfMonth(y, m)
      const processedAt = new Date(`${y}-${String(m).padStart(2, '0')}-25T10:00:00.000Z`)

      const payable = activeEmployees.filter((e) => e.joining <= periodEnd)
      let gross = 0, deductions = 0, net = 0
      const rows: { employeeId: string; structureId: string; calc: ReturnType<typeof calculatePayrollItem> }[] = []
      for (const e of payable) {
        const structure = structures.find((s) => s.employeeId === e.id)
        if (!structure) continue
        const calc = calculatePayrollItem({
          structure: {
            basic_paise: structure.basicPaise,
            hra_paise: structure.hraPaise,
            conveyance_paise: structure.conveyancePaise,
            special_allowance_paise: structure.specialAllowancePaise,
            custom_components: [],
          },
          // Historical runs assume full attendance — no LOP to explain away.
          attendance: { payable_days: payableDays, present_days: payableDays, on_leave_days: 0, absent_days: 0, lop_days: 0 },
          snap,
          periodStartMonth: m,
        })
        rows.push({ employeeId: e.id, structureId: structure.id, calc })
        gross += calc.gross_paise
        deductions += calc.total_deductions_paise
        net += calc.net_paise
      }

      const run = await prisma.payrollRun.create({
        data: {
          organisationId: org.id,
          periodStart, periodEnd, stage: 'processed',
          statutorySnapshotJson: JSON.stringify(snap),
          headcount: rows.length,
          grossTotalPaise: gross, deductionsTotalPaise: deductions, netTotalPaise: net,
          reviewedBy: 'usr-hr', approvedBy: 'usr-fin', processedBy: 'usr-fin',
          processedAt,
        },
      })

      for (const r of rows) {
        const item = await prisma.payrollItem.create({
          data: {
            payrollRunId: run.id,
            employeeId: r.employeeId,
            salaryStructureId: r.structureId,
            payableDays, presentDays: payableDays, onLeaveDays: 0, absentDays: 0, lopDays: 0,
            earningsJson: JSON.stringify(r.calc.earnings),
            deductionsJson: JSON.stringify(r.calc.deductions),
            grossPaise: r.calc.gross_paise,
            totalDeductionsPaise: r.calc.total_deductions_paise,
            netPaise: r.calc.net_paise,
            gratuityAccrualPaise: r.calc.gratuity_accrual_paise,
          },
        })
        paymentNo += 1
        const pmtNo = `PMT-${String(paymentNo).padStart(5, '0')}`
        const payment = await prisma.payment.create({
          data: {
            paymentNo: pmtNo,
            employeeId: r.employeeId,
            payrollRunId: run.id,
            amountPaise: r.calc.net_paise,
            method: 'mock',
            reference: `${pmtNo}/${periodStart.slice(0, 7)}`,
            status: 'completed',
            paidAt: processedAt,
          },
        })
        payslipNo += 1
        await prisma.payslip.create({
          data: {
            payrollRunId: run.id,
            payrollItemId: item.id,
            employeeId: r.employeeId,
            payslipNo: `PS-${periodStart.slice(0, 7).replace('-', '')}-${String(payslipNo).padStart(4, '0')}`,
            publishedAt: processedAt,
            fileKey: `payslips/${run.id}/${r.employeeId}.pdf`,
            status: 'published',
          },
        })
        sequence += 1
        running += r.calc.net_paise
        await prisma.ledgerTransaction.create({
          data: {
            transactionRef: `LT-PAY-${String(sequence).padStart(6, '0')}`,
            sequence,
            date: periodEnd,
            type: 'Payroll',
            description: `Salary — ${r.employeeId} (${periodStart} to ${periodEnd})`,
            employeeId: r.employeeId,
            category: 'Payroll',
            debitPaise: r.calc.net_paise,
            creditPaise: 0,
            runningBalancePaise: running,
            referenceId: item.id,
            referenceType: 'PayrollItem',
            paymentId: payment.id,
            status: 'posted',
          },
        })
      }
    }

    // The current month sits in Draft, awaiting Calculate.
    await prisma.payrollRun.create({
      data: {
        organisationId: org.id,
        periodStart: `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`,
        periodEnd: `${currentYear}-${String(currentMonth).padStart(2, '0')}-${lastDayOfMonth(currentYear, currentMonth)}`,
        stage: 'draft',
        notes: 'Awaiting Calculate.',
      },
    })
  }

  // ── Expenses across every stage ─────────────────────────────────────────
  if ((await prisma.expense.count()) === 0) {
    const seedExpenses = [
      { employeeId: 'emp-exec', categoryId: 'ec-travel', rupees: 1850, days: -35, title: 'Cab to client — Coimbatore', desc: 'Return cabs to Sundar & Co audit', stage: 'paid' },
      { employeeId: 'emp-exec', categoryId: 'ec-meals', rupees: 620, days: -33, title: 'Client dinner — Q1 review', desc: 'Dinner with client CFO', stage: 'paid' },
      { employeeId: 'emp-exec', categoryId: 'ec-office', rupees: 340, days: -20, title: 'Stationery', desc: 'Ring binders, tabs for filing', stage: 'approved' },
      { employeeId: 'emp-exec', categoryId: 'ec-travel', rupees: 2400, days: -12, title: 'Auto — field visit', desc: 'Half-day auto for statutory office visit', stage: 'pending_finance' },
      { employeeId: 'emp-exec', categoryId: 'ec-phone', rupees: 599, days: -5, title: 'Mobile top-up', desc: 'Client-call recharge', stage: 'pending_manager' },
      { employeeId: 'emp-exec', categoryId: 'ec-meals', rupees: 220, days: -2, title: 'Tea break', desc: 'Meeting with junior over tea', stage: 'draft' },
      { employeeId: 'emp-mgr', categoryId: 'ec-travel', rupees: 4800, days: -18, title: 'Chennai → Trichy flight', desc: 'Client visit', stage: 'paid' },
      { employeeId: 'emp-mgr', categoryId: 'ec-meals', rupees: 950, days: -10, title: 'Team dinner', desc: 'Team-lead dinner post-close', stage: 'pending_finance' },
      { employeeId: 'emp-md', categoryId: 'ec-sub', rupees: 12000, days: -8, title: 'ICAI subscription', desc: 'Annual renewal', stage: 'approved' },
      { employeeId: 'emp-exec', categoryId: 'ec-other', rupees: 350, days: -14, title: 'Umbrella', desc: 'Bought during monsoon field visit', stage: 'rejected' },
      { employeeId: 'emp-articled', categoryId: 'ec-travel', rupees: 180, days: -3, title: 'Bus fare', desc: 'To ITO office', stage: 'pending_manager' },
      { employeeId: 'emp-hr', categoryId: 'ec-office', rupees: 2200, days: -45, title: 'Office plants', desc: 'Reception refresh', stage: 'paid' },
    ]

    let sequence = (await prisma.ledgerTransaction.count())
    let running = (await prisma.ledgerTransaction.findFirst({
      orderBy: { sequence: 'desc' }, select: { runningBalancePaise: true },
    }))?.runningBalancePaise ?? 0
    let paymentNo = await prisma.payment.count()
    let expenseNo = 0

    for (const e of seedExpenses) {
      expenseNo += 1
      const submitted = e.stage !== 'draft'
      const managerApproved = ['pending_finance', 'approved', 'paid'].includes(e.stage)
      const financeApproved = ['approved', 'paid'].includes(e.stage)
      const paid = e.stage === 'paid'
      const when = new Date(`${addDays(TODAY, e.days)}T06:00:00.000Z`)

      const expense = await prisma.expense.create({
        data: {
          expenseNo: `EXP-${String(expenseNo).padStart(5, '0')}`,
          employeeId: e.employeeId,
          categoryId: e.categoryId,
          title: e.title,
          amountPaise: e.rupees * 100,
          expenseDate: addDays(TODAY, e.days),
          description: e.desc,
          paymentMethod: 'card',
          stage: e.stage,
          submittedAt: submitted ? when : null,
          managerApprovedBy: managerApproved ? 'usr-mgr' : null,
          managerApprovedAt: managerApproved ? when : null,
          financeApprovedBy: financeApproved ? 'usr-fin' : null,
          financeApprovedAt: financeApproved ? when : null,
          paidAt: paid ? when : null,
          rejectionReason: e.stage === 'rejected' ? 'Duplicate of a claim from last week' : null,
          rejectedBy: e.stage === 'rejected' ? 'usr-mgr' : null,
          rejectedAt: e.stage === 'rejected' ? when : null,
        },
      })

      if (paid) {
        paymentNo += 1
        const pmtNo = `PMT-${String(paymentNo).padStart(5, '0')}`
        const payment = await prisma.payment.create({
          data: {
            paymentNo: pmtNo,
            employeeId: e.employeeId,
            expenseId: expense.id,
            amountPaise: expense.amountPaise,
            method: 'mock',
            reference: `${pmtNo}/${expense.expenseNo}`,
            status: 'completed',
            paidAt: when,
          },
        })
        sequence += 1
        running += expense.amountPaise
        await prisma.ledgerTransaction.create({
          data: {
            transactionRef: `LT-EXP-${String(sequence).padStart(6, '0')}`,
            sequence,
            date: expense.expenseDate,
            type: 'Expense Reimbursement',
            description: `Reimbursement — ${expense.title}`,
            employeeId: e.employeeId,
            category: 'Expense',
            debitPaise: expense.amountPaise,
            creditPaise: 0,
            runningBalancePaise: running,
            referenceId: expense.id,
            referenceType: 'Expense',
            paymentId: payment.id,
            status: 'posted',
          },
        })
        await prisma.expense.update({ where: { id: expense.id }, data: { paymentId: payment.id } })
      }
    }
  }

  // ── Messages: group chats derived from department + role, plus two DMs ──
  //
  // Membership is derived AT SEED TIME, not on every request. Re-deriving
  // would silently add someone to a chat when their department changes, and
  // the history there predates them.
  if ((await prisma.chat.count()) === 0) {
    const active = activeEmployees.map((e) => e.id)
    const byDept = (dept: string) => activeEmployees.filter((e) => e.departmentId === dept).map((e) => e.id)
    const byType = (...types: string[]) => activeEmployees.filter((e) => types.includes(e.type)).map((e) => e.id)

    const groups: { id: string; name: string; description: string; members: string[]; admin: string }[] = [
      { id: 'chat-general', name: 'Audit OS General', description: 'Firm-wide announcements and general chatter.', members: active, admin: 'emp-md' },
      { id: 'chat-mgmt', name: 'Management', description: 'Partners + managers.', members: byType('partner', 'manager'), admin: 'emp-md' },
      { id: 'chat-hr', name: 'HR Team', description: 'HR department + MD.', members: [...new Set([...byDept('dep-hr'), 'emp-md'])], admin: 'emp-hr' },
      { id: 'chat-finance', name: 'Finance Team', description: 'Finance department + MD.', members: [...new Set([...byDept('dep-fin'), 'emp-md'])], admin: 'emp-fin' },
      // No GST department exists in the seed yet; Operations + MD stands in.
      { id: 'chat-gst', name: 'GST Team', description: 'GST filings work.', members: [...new Set([...byDept('dep-ops'), 'emp-md'])], admin: 'emp-md' },
      { id: 'chat-ops', name: 'Operations', description: 'Audit + field operations.', members: byDept('dep-ops'), admin: 'emp-mgr' },
    ]
    for (const g of groups) {
      await prisma.chat.create({
        data: {
          id: g.id,
          organisationId: org.id,
          type: 'group',
          name: g.name,
          description: g.description,
          members: {
            create: g.members.map((employeeId) => ({
              employeeId,
              role: employeeId === g.admin ? 'admin' : 'member',
            })),
          },
        },
      })
    }

    const dms: { id: string; between: [string, string] }[] = [
      { id: 'chat-dm-meera-vikram', between: ['emp-exec', 'emp-mgr'] },
      { id: 'chat-dm-priya-md', between: ['emp-hr', 'emp-md'] },
    ]
    for (const d of dms) {
      await prisma.chat.create({
        data: {
          id: d.id,
          organisationId: org.id,
          type: 'dm',
          members: { create: d.between.map((employeeId) => ({ employeeId, role: 'member' })) },
        },
      })
    }

    const conversations: [string, [string, string][]][] = [
      ['chat-general', [
        ['emp-md', 'Welcome to Audit OS. New quarter starts Monday.'],
        ['emp-hr', 'Reminder: holiday calendar for the year is now live in Settings.'],
        ['emp-mgr', 'Sundar & Co audit closing this Friday — great work team.'],
      ]],
      ['chat-mgmt', [
        ['emp-md', 'Board update at 4pm today.'],
        ['emp-mgr', 'Will circulate the client roll-forward before then.'],
      ]],
      ['chat-hr', [
        ['emp-hr', 'Diwali holiday list published — check the Leave module.'],
        ['emp-md', 'Thanks Priya.'],
      ]],
      ['chat-finance', [
        ['emp-fin', 'September payroll goes to review by 25th.'],
        ['emp-md', 'Noted.'],
      ]],
      ['chat-ops', [
        ['emp-mgr', 'Field visit roster for next week going out tomorrow.'],
        ['emp-exec', 'I can take the Trichy visit.'],
        ['emp-articled', 'Happy to shadow on the Chennai audits.'],
      ]],
      ['chat-dm-meera-vikram', [
        ['emp-mgr', 'Meera — can you own the GST reconciliation for Sundar this month?'],
        ['emp-exec', 'On it. Draft by Thursday.'],
        ['emp-mgr', 'Great.'],
      ]],
      ['chat-dm-priya-md', [
        ['emp-hr', "Ravi — Divya's probation ends in early January."],
        ['emp-md', "Let's discuss in the next 1:1."],
      ]],
    ]

    // Timestamps are spaced so ordering is deterministic across reseeds.
    let seq = 0
    for (const [chatId, conversation] of conversations) {
      for (const [authorEmployeeId, body] of conversation) {
        seq += 1
        const at = new Date(Date.now() - (200 - seq) * 60_000)
        const message = await prisma.chatMessage.create({
          data: {
            chatId,
            authorEmployeeId,
            body,
            createdAt: at,
            updatedAt: at,
            // The author has read their own message by definition.
            reads: { create: { chatId, employeeId: authorEmployeeId, readAt: at } },
          },
        })
        await prisma.chat.update({ where: { id: chatId }, data: { lastMessageAt: at } })
        void message
      }
    }

    // Everyone else has read all but the LAST message in each chat, so every
    // demo login lands with exactly one unread per conversation.
    for (const chat of await prisma.chat.findMany({ include: { members: true } })) {
      const messages = await prisma.chatMessage.findMany({
        where: { chatId: chat.id }, orderBy: { createdAt: 'asc' },
      })
      if (messages.length === 0) continue
      for (const message of messages.slice(0, -1)) {
        for (const member of chat.members) {
          if (member.employeeId === message.authorEmployeeId) continue
          await prisma.messageRead.create({
            data: {
              chatId: chat.id,
              messageId: message.id,
              employeeId: member.employeeId,
              readAt: message.createdAt,
            },
          })
        }
      }
    }
  }

  // ── Workstation (AUDIT_OS_WORKSTATION.md §10) ───────────────────────────
  // Lives in its own module so this file stays a core-HR seed. It references
  // the employees seeded above by id; it creates no new person.
  const workstation = await seedWorkstation(prisma, org.id)
  await seedTools(prisma)
  await seedAuditAutomation(prisma)
  await seedBooks(prisma, org.id)
  const bookkeeping = await seedBookkeeping(prisma, org.id)
  const incorporation = await seedIncorporation(prisma, org.id)
  const registration = await seedRegistration(prisma, org.id)

  const counts = {
    employees: await prisma.employee.count(),
    users: await prisma.user.count(),
    attendance: await prisma.attendance.count(),
    payrollRuns: await prisma.payrollRun.count(),
    payslips: await prisma.payslip.count(),
    expenses: await prisma.expense.count(),
    ledger: await prisma.ledgerTransaction.count(),
    chats: await prisma.chat.count(),
  }
  console.log('Seed complete:', counts)
  console.log('Workstation:', workstation)
  console.log('Bookkeeping:', bookkeeping)
  console.log('Incorporation:', incorporation)
  console.log('Registration:', registration)
  console.log('Demo logins: ravi@auditos.local/md · priya@auditos.local/hr · anitha@auditos.local/fin · vikram@auditos.local/mgr · meera@auditos.local/emp · karthik@auditos.local/art')
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
