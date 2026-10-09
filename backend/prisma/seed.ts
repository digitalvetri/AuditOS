/**
 * REFERENCE SEED — what a fresh firm needs before anyone signs in: the
 * organisation, roles and permissions, work schedule, leave types, holidays,
 * statutory rates, expense categories, the service catalog and the GST /
 * registration / tools templates. No people, clients or transactions: the
 * owner logins come from `npm run setup:owners`, everyone else from
 * Settings → Users.
 *
 * Idempotent — safe to re-run (Docker runs it on every start).
 */
// Load .env before Prisma initialises. env.ts autoloads server/.env into
// process.env on first import; the side-effect is the whole point here.
import '../src/lib/env.js'
import { PrismaClient } from '@prisma/client'
import { istToday } from '../src/lib/dates.js'
import { ALL_PERMISSION_CODES, MATRIX, PERMISSION_DESCRIPTIONS, type RoleCode } from '../src/platform/rbac/matrix.js'
import { seedWorkstation } from './seed-workstation.js'
// GST compliance periods are DERIVED from the filings seeded above rather
// than seeded as their own fixture — one source of truth, and the same code
// path an existing database uses.
import { backfillPeriods } from '../src/modules/gst/service.js'
import { seedTools } from './seed-tools.js'
import { setupRoles } from './setup-roles.js'
import { seedAuditAutomation } from './seed-audit-automation.js'
import { seedRegistration } from './seed-registration.js'
import { seedPartnership } from './seed-partnership.js'
import { migrateGstReturnCases } from './seed-gst-return-cases.js'
import { seedGst } from './seed-gst.js'
import { seedCompliance } from './seed-compliance.js'
import { seedAudit } from './seed-audit.js'

const prisma = new PrismaClient()

const TODAY = istToday()

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

  // The five live roles (Super Admin … Intern) and their module access. On an
  // existing database the defaults are applied once; later runs keep the
  // access set in Settings → Roles & permissions.
  await setupRoles(prisma)
  // Finance Admin is a legacy role, kept so existing logins on it still work.
  // It is not offered in Settings or on an employee.
  const LEGACY_ROLES: { id: string; code: RoleCode; name: string; description: string }[] = [
    { id: 'role-finance-admin', code: 'finance_admin', name: 'Finance Admin', description: 'Payroll approval, ledger and payments' },
  ]
  for (const r of LEGACY_ROLES) {
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

  // ── Locations, schedule ─────────────────────────────────────────────────
  // Department + Designation are removed concepts. The Prisma models still
  // exist (as nullable FKs on Employee) for historical rows, but seed
  // creates no new rows and never attaches employees to one.

  // Work Locations removed as a concept; model stays as dead code so
  // historical attendance rows that pointed at a location still resolve.
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

  // ── Leave types, holidays, balances ─────────────────────────────────────
  const leaveTypes = [
    { id: 'lt-casual', code: 'casual', name: 'Casual', entitlement: 12, carry: 0, half: true, notice: 1, probation: true },
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
  // Sick leave was retired. Databases seeded before that still carry the
  // type; soft-delete it so the leave screens stop offering it. Idempotent.
  await prisma.leaveType.updateMany({
    where: { organisationId: org.id, code: 'sick', deletedAt: null },
    data: { deletedAt: new Date() },
  })

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

  // ── E-Invoice & E-Way Bill config rows (E-INVOICE-EWAYBILL.md) ──────────
  // Every threshold, day-count and hour-window used by the E-Invoice / E-Way
  // Bill engine lives here. Grep for numeric literals in the einvoice-ewb
  // module: there must not be any — the acceptance test is 'no literals'.
  const einvEwbRates: readonly [code: string, value: string, effectiveFrom: string, notes: string][] = [
    // E-invoice applicability — ₹5 Cr since 1 Aug 2023, PAN-level.
    ['einv.aato_threshold_paise',            '50000000000',  '2023-08-01', 'E-invoice applicability threshold (₹5 Cr AATO, PAN-level, from 2017-18)'],
    ['einv.aato.effective_from',             '2023-08-01',   '2023-08-01', 'Date the ₹5 Cr e-invoice threshold took effect'],
    ['einv.applicability_scan_from_fy',      '2017-18',      '2017-04-01', 'Earliest FY to scan AATO history for e-invoice applicability'],
    ['einv.30day.aato_threshold_paise',      '100000000000', '2025-04-01', '30-day reporting rule threshold (₹10 Cr AATO)'],
    ['einv.30day.effective_from',            '2025-04-01',   '2025-04-01', 'Date the 30-day reporting rule took effect'],
    ['einv.30day_window_days',               '30',           '2025-04-01', 'Reporting window from document date (days)'],
    ['einv.30day_alert_at_day',              '25',           '2025-04-01', 'Day at which the 30-day countdown begins alerting'],
    ['einv.direct_api.aato_threshold_paise', '1000000000000','2023-08-01', 'NIC IRP direct-API registration threshold (₹100 Cr AATO)'],
    ['einv.cancellation_window_hours',       '24',           '2023-08-01', 'Hours after IRN generation within which cancellation is possible'],
    // E-way bill — 2025 rules changed materially. See spec §2.3.
    ['ewb.doc_max_age_days',                 '180',          '2025-01-01', 'Base document max age (days) — Notification 1 Jan 2025'],
    ['ewb.extension_cap_days',               '360',          '2025-01-01', 'Cap on total extension window from original generation (days)'],
    ['ewb.rules.effective_from',             '2025-01-01',   '2025-01-01', 'Date the 180-day / 360-day EWB rules took effect'],
    ['ewb.extension_window_hours_pre',       '8',            '2020-01-01', 'Hours before expiry an extension is permitted'],
    ['ewb.extension_window_hours_post',      '8',            '2020-01-01', 'Hours after expiry an extension is permitted'],
    ['ewb.validity_km_per_day',              '200',          '2021-01-01', 'Validity distance per day (Notification 94/2020)'],
    ['ewb.high_value_alert_paise',           '100000000000', '2025-01-01', 'Portal SMS-alerts the generator above this invoice value (₹10 Cr)'],
    ['ewb.mfa.effective_from_all',           '2025-04-01',   '2025-04-01', 'MFA mandatory for ALL taxpayers on the e-way bill portal'],
    ['ewb.cap_alert_before_days',            '30',           '2025-01-01', 'Days before the 360-day cap to raise the alert'],
    ['ewb.expiry_alert_hours',               '24',           '2020-01-01', 'Hours until expiry to include an EWB in the 24-hour alert bucket'],
  ]
  for (const [code, value, effectiveFrom, notes] of einvEwbRates) {
    const existing = await prisma.statutoryRate.findFirst({ where: { code, deletedAt: null } })
    if (!existing) {
      await prisma.statutoryRate.create({
        data: {
          organisationId: org.id, code, value,
          effectiveFrom, effectiveTo: null, notes,
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

  // ── Workstation (AUDIT_OS_WORKSTATION.md §10) ───────────────────────────
  // Service catalog and document categories only.
  const workstation = await seedWorkstation(prisma, org.id)
  // Without this a fresh database (Docker included) comes up with GST
  // filings but no compliance periods, so every GST screen renders empty.
  const gstPeriods = await backfillPeriods()
  await seedTools(prisma)
  await seedAuditAutomation(prisma)
  const registration = await seedRegistration(prisma, org.id)
  await seedPartnership(prisma, org.id)
  // Batch-open case-per-period rows for the demo GstCompliancePeriod data so
  // §9-3's per-return client lists have something to render. Idempotent —
  // only opens what is still missing.
  const returnCases = await migrateGstReturnCases(prisma)
  const gst = await seedGst(prisma)
  console.log('Compliance catalogue:', await seedCompliance(prisma))
  const audit = await seedAudit(prisma)

  console.log('Seed complete (reference data only):', {
    roles: await prisma.role.count(),
    leaveTypes: await prisma.leaveType.count(),
    services: await prisma.service.count(),
  })
  console.log('Workstation:', workstation)
  console.log('GST periods:', gstPeriods)
  console.log('Registration:', registration)
  console.log('GST return cases:', returnCases)
  console.log('GST reference:', gst)
  console.log('Audit checklists:', audit)
  console.log('Next: npm run setup:owners')
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
