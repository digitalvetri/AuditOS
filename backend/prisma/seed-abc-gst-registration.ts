/**
 * SAMPLE GST REGISTRATION CASE for client ABC (cli-1001).
 *
 * One-shot — creates a GST Registration case for the seeded ABC Private
 * Limited client with filled-in details, one signatory, 65% checklist
 * progress and saved portal credentials. Idempotent: if ABC already has
 * a GST registration case this script skips.
 *
 * Run:
 *   docker exec auditos-api npx tsx prisma/seed-abc-gst-registration.ts
 *
 * Development data only. The PAN, Aadhaar and portal password below are
 * fictitious and MUST NOT be used in production.
 */
import { PrismaClient } from '@prisma/client'
import { pathToFileURL } from 'node:url'
import {
  openCase,
  addPartnerRequirements,
  recompute,
  logActivity,
  serviceStatusFor,
  isPartnerTemplateRow,
} from '../src/modules/partnership/service.js'
import { encryptPortalSecret } from '../src/platform/portalCrypto.js'
import type { Session } from '../src/platform/auth.js'

const CLIENT_ID = 'cli-1001'

const DETAILS = {
  // Business
  legal_name: 'ABC Private Limited',
  trade_name: 'ABC',
  constitution: 'Private Limited Company',
  pan_of_business: 'ABCPL1234K',
  // Place of business
  address_line1: 'No. 42, 2nd Floor, Residency Tower',
  address_line2: 'Nungambakkam High Road',
  city: 'Chennai',
  state: 'Tamil Nadu',
  pincode: '600034',
  // Nature of business
  nature_of_business: 'Trading of consumer electronics (wholesale + retail)',
  commencement_date: '2024-11-15',
  // Bank
  bank_name: 'HDFC Bank',
  account_number: '50100****3421',
  ifsc: 'HDFC0001234',
  // Turnover
  estimated_annual_turnover: '12500000',
}

const SIGNATORY = {
  name: 'Arjun Nair',
  father: 'Satish Nair',
  address: 'Flat 3B, Lotus Apartments, Alwarpet, Chennai 600018',
  mobile: '9840112233',
  email: 'arjun@abcpl.in',
  pan: 'AKRPN2201C',
  aadhaar: '540154015401',
  role: 'DIRECTOR' as const,
}

const CREDENTIALS = {
  typeCode: 'gst',
  mode: 'new' as const,
  fields: { username: 'ABCPL_AUTH', trn: 'TRN0012345678' },
  password: 'Sample@2001',
}

const PROGRESS_PERCENT = 65
const DUE_IN_DAYS = 14

function isoDay(offset: number): string {
  const t = new Date(Date.now() + 5.5 * 3600_000 + offset * 86_400_000)
  return t.toISOString().slice(0, 10)
}

export async function seedAbcGstRegistration(prisma: PrismaClient) {
  const client = await prisma.client.findUnique({
    where: { id: CLIENT_ID },
    select: { id: true, companyName: true, organisationId: true },
  })
  if (!client) throw new Error(`Client ${CLIENT_ID} not found — run the main seed first.`)

  const existing = await prisma.partnershipCase.findFirst({
    where: { clientId: CLIENT_ID, kind: 'GST', deletedAt: null },
  })
  if (existing) {
    return { status: 'skipped', caseId: existing.id, caseCode: existing.caseCode }
  }

  const user = await prisma.user.findUnique({ where: { id: 'usr-md' }, include: { role: true } })
  if (!user) throw new Error('usr-md is missing — run the main seed first.')
  const session = {
    userId: user.id,
    email: user.email,
    roleId: user.roleId,
    roleCode: user.role.code,
    roleName: user.role.name,
    grants: [],
    employeeId: user.employeeId,
    departmentId: null,
    employeeFullName: null,
  } as unknown as Session

  const c = await openCase(session, 'GST', {
    clientId: CLIENT_ID,
    assignedEmployeeId: 'emp-mgr',
    reviewerEmployeeId: 'emp-mgr',
    approverEmployeeId: 'emp-md',
    dueDate: isoDay(DUE_IN_DAYS),
    entityType: 'PVT_LTD',
  })
  await logActivity(c.id, session, 'case.created', `GST registration case ${c.caseCode} opened (sample data)`)

  const partner = await prisma.partnershipPartner.create({
    data: {
      caseId: c.id,
      sortOrder: 10,
      name: SIGNATORY.name,
      fatherName: SIGNATORY.father,
      address: SIGNATORY.address,
      mobile: SIGNATORY.mobile,
      email: SIGNATORY.email,
      pan: SIGNATORY.pan,
      aadhaar: SIGNATORY.aadhaar,
      role: SIGNATORY.role,
    },
  })
  await addPartnerRequirements(c.id, partner, session)

  // Tick the checklist up to PROGRESS_PERCENT so the dashboard shows a
  // partially-progressed case instead of a blank 0/N.
  const items = await prisma.partnershipCaseItem.findMany({
    where: { caseId: c.id, deletedAt: null },
    select: {
      id: true,
      partnerId: true,
      category: { select: { perPartner: true, sortOrder: true } },
      sortOrder: true,
    },
  })
  const live = items
    .filter((i) => !isPartnerTemplateRow(i))
    .sort(
      (a, b) =>
        a.category.sortOrder - b.category.sortOrder || a.sortOrder - b.sortOrder,
    )
  const doneCount = Math.round((live.length * PROGRESS_PERCENT) / 100)
  if (doneCount > 0) {
    await prisma.partnershipCaseItem.updateMany({
      where: { id: { in: live.slice(0, doneCount).map((i) => i.id) } },
      data: { status: 'COMPLETED' },
    })
  }

  await prisma.partnershipCase.update({
    where: { id: c.id },
    data: {
      stage: 'APPLICATION_FILED',
      status: 'UNDER_REVIEW',
      detailsJson: JSON.stringify(DETAILS),
      lastActivityAt: new Date(),
    },
  })
  if (c.clientServiceId) {
    await prisma.clientService.update({
      where: { id: c.clientServiceId },
      data: { status: serviceStatusFor('UNDER_REVIEW') },
    })
  }
  await recompute(c.id)

  await prisma.registrationCredential.upsert({
    where: { clientId_typeCode: { clientId: CLIENT_ID, typeCode: CREDENTIALS.typeCode } },
    update: {},
    create: {
      clientId: CLIENT_ID,
      typeCode: CREDENTIALS.typeCode,
      mode: CREDENTIALS.mode,
      fieldsJson: JSON.stringify(CREDENTIALS.fields),
      passwordCiphertext: encryptPortalSecret(CREDENTIALS.password, 'registration_gst_password'),
      createdBy: session.userId,
      updatedBy: session.userId,
    },
  })

  return { status: 'created', caseId: c.id, caseCode: c.caseCode, progress: PROGRESS_PERCENT }
}

async function main() {
  const prisma = new PrismaClient()
  try {
    const r = await seedAbcGstRegistration(prisma)
    console.log('ABC GST registration sample:', r)
  } finally {
    await prisma.$disconnect()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
