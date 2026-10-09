import type { Prisma } from '@prisma/client'
import { CIN_RE, LLPIN_RE } from '../gst/validate.js'
import { alive } from '../../lib/prisma.js'
import type { Session } from '../../platform/auth.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import { nextClientCode } from '../../platform/workstation/codes.js'
import { deriveShortName } from '../../platform/workstation/organization.js'
import { clientIdWhere } from '../../platform/workstation/scope.js'
import { ORGANIZATION_REF } from '../../api/workstation.serialize.js'
import { TAN_RE } from '../gst/validate.js'
import { FieldErrors } from './validate.js'

/**
 * The pieces of "make a client" and "list clients" that more than one route
 * needs: POST /api/clients and the Excel import create clients through the
 * SAME field rules and the SAME insert, and the list, export and bulk routes
 * read the same filters.
 */

export interface ClientFields {
  companyName: string
  legalName: string | null
  businessType: string | null
  contactPerson: string
  contactNumber: string
  email: string | null
  address: string | null
  gstin: string | null
  pan: string | null
  tan: string | null
  cin: string | null
  accountManagerId: string
  secondaryManagerId: string | null
  isOrganization: boolean
  shortName: string | null
  organizationId: string | null
  onboardingDate: string | null
}

/**
 * Field-level validation for a new client. Errors are collected on `v`
 * (field → message); the caller decides when to throw. The return value is
 * only meaningful when `v` has no errors.
 */
export function readClientFields(v: FieldErrors, b: Record<string, unknown>): ClientFields {
  const companyName = v.str('company_name', b.company_name, { max: 200 })
  const contactPerson = v.str('contact_person', b.contact_person, { max: 120 })
  const contactNumber = v.phone('contact_number', b.contact_number)
  const email = v.email('email', b.email, false)
  const gstin = b.gstin ? v.gstin('gstin', b.gstin) : undefined
  const pan = b.pan ? v.pan('pan', b.pan) : undefined
  const accountManagerId = v.str('account_manager_id', b.account_manager_id)
  const secondaryManagerId = v.str('secondary_manager_id', b.secondary_manager_id, { required: false })
  if (secondaryManagerId && secondaryManagerId === accountManagerId) {
    v.add('secondary_manager_id', 'Choose a different person from the account manager.')
  }
  const businessType = v.str('business_type', b.business_type, { required: false, max: 80 })
  const address = v.str('address', b.address, { required: false, max: 500 })
  // A new client can be an organization, or be created under one.
  const organizationId = v.str('organization_id', b.organization_id, { required: false })
  const isOrganization = b.is_organization === true
  const shortName = v.str('short_name', b.short_name, { required: false, max: 20 })
  if (isOrganization && organizationId) {
    v.add('organization_id', 'An organization cannot be placed under another organization.')
  }
  // Optional extras (the import sends them; the Add Client form does not).
  const legalName = v.str('legal_name', b.legal_name, { required: false, max: 200 })
  let tan: string | undefined
  if (b.tan) {
    const raw = v.str('tan', b.tan, { required: false, max: 20 })
    if (raw !== undefined) {
      tan = raw.toUpperCase()
      if (!TAN_RE.test(tan)) v.add('tan', 'Enter a valid 10-character TAN (e.g. CHEK09876B).')
    }
  }
  let cin: string | undefined
  if (b.cin) {
    const raw = v.str('cin', b.cin, { required: false, max: 25 })
    if (raw !== undefined) {
      cin = raw.toUpperCase()
      if (!CIN_RE.test(cin) && !LLPIN_RE.test(cin)) v.add('cin', 'Enter a valid CIN (U74999TN2020PTC123456) or LLPIN (AAB-1234).')
    }
  }
  const onboardingDate = v.date('onboarding_date', b.onboarding_date, false)

  return {
    companyName: companyName ?? '',
    legalName: legalName ?? null,
    businessType: businessType ?? null,
    contactPerson: contactPerson ?? '',
    contactNumber: contactNumber ?? '',
    email: email ?? null,
    address: address ?? null,
    gstin: gstin ?? null,
    pan: pan ?? null,
    tan: tan ?? null,
    cin: cin ?? null,
    accountManagerId: accountManagerId ?? '',
    secondaryManagerId: secondaryManagerId ?? null,
    isOrganization,
    shortName: shortName ?? null,
    organizationId: organizationId ?? null,
    onboardingDate: onboardingDate ?? null,
  }
}

/**
 * The insert: the Client row (status `onboarding`, server-issued Client ID)
 * and its primary contact. `clientCode` may be passed by a caller that
 * allocates a run of codes inside one transaction (the import).
 */
export async function createClientRow(
  tx: Prisma.TransactionClient,
  f: ClientFields,
  userId: string,
  clientCode?: string,
) {
  const code = clientCode ?? await nextClientCode(tx)
  const created = await tx.client.create({
    data: {
      organisationId: 'org-audit-os',
      clientCode: code,
      companyName: f.companyName,
      legalName: f.legalName ?? f.companyName,
      businessType: f.businessType,
      contactPerson: f.contactPerson,
      contactNumber: f.contactNumber,
      email: f.email,
      address: f.address,
      gstin: f.gstin,
      pan: f.pan,
      tan: f.tan,
      cin: f.cin,
      accountManagerId: f.accountManagerId,
      secondaryManagerId: f.secondaryManagerId,
      status: 'onboarding',
      onboardingDate: f.onboardingDate ?? new Date().toISOString().slice(0, 10),
      isOrganization: f.isOrganization,
      shortName: f.isOrganization ? (f.shortName ?? deriveShortName(f.companyName)) : null,
      parentClientId: f.organizationId,
      createdBy: userId,
      updatedBy: userId,
    },
    include: { parentClient: { select: ORGANIZATION_REF } },
  })
  await tx.clientContact.create({
    data: {
      clientId: created.id, name: f.contactPerson, designation: 'Primary contact',
      phone: f.contactNumber, email: f.email, isPrimary: true, createdBy: userId,
    },
  })
  return created
}

/** 'CLI-1041' → 'CLI-1042'. */
export function bumpClientCode(code: string): string {
  const m = /^(.*?)(\d+)$/.exec(code)
  return m ? `${m[1]}${Number(m[2]) + 1}` : code
}

// ── List filters ────────────────────────────────────────────────────────────

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/**
 * The `where` for GET /api/clients and its export. Scope is folded in first,
 * so every filter only ever narrows what the caller may see.
 */
export async function clientListWhere(
  session: Session, scope: Scope, query: Record<string, unknown>,
): Promise<Prisma.ClientWhereInput> {
  const q = str(query.q)
  const status = str(query.status) || null
  const managerId = str(query.account_manager_id) || null
  const serviceId = str(query.service_id) || null
  const pendingDocs = query.pending_documents === 'true'
  // organization_id = the clients under one organization;
  // kind = organization | member (under an organization) | standalone.
  const organizationId = str(query.organization_id) || null
  const kind = str(query.kind) || null
  // mine=1 — the caller's own clients (primary or second staff).
  const mine = query.mine === '1' || query.mine === 'true'
  // ids=a,b,c — an explicit set (the "payment overdue" view, a deep link).
  const ids = str(query.ids) ? str(query.ids).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 1000) : null

  const and: Prisma.ClientWhereInput[] = []
  if (managerId) and.push({ OR: [{ accountManagerId: managerId }, { secondaryManagerId: managerId }] })
  if (mine) {
    const me = session.employeeId ?? '__none__'
    and.push({ OR: [{ accountManagerId: me }, { secondaryManagerId: me }] })
  }
  if (ids) and.push({ id: { in: ids } })
  // §7.2 search: company · client id · GSTIN · contact person · number,
  // plus the organization's name so "ABC" also finds ABC's clients.
  if (q) {
    and.push({
      OR: [
        { companyName: { contains: q, mode: 'insensitive' } },
        { clientCode: { contains: q, mode: 'insensitive' } },
        { gstin: { contains: q, mode: 'insensitive' } },
        { pan: { contains: q, mode: 'insensitive' } },
        { contactPerson: { contains: q, mode: 'insensitive' } },
        { contactNumber: { contains: q } },
        { parentClient: { companyName: { contains: q, mode: 'insensitive' } } },
      ],
    })
  }

  return {
    ...alive,
    ...(await clientIdWhere(session, scope)),
    ...(status ? { status } : {}),
    ...(serviceId ? { services: { some: { serviceId, deletedAt: null } } } : {}),
    ...(pendingDocs
      ? { documents: { some: { status: { in: ['requested', 'pending'] }, deletedAt: null } } }
      : {}),
    ...(organizationId ? { parentClientId: organizationId } : {}),
    ...(kind === 'organization' ? { isOrganization: true } : {}),
    ...(kind === 'member' ? { parentClientId: { not: null } } : {}),
    ...(kind === 'standalone' ? { isOrganization: false, parentClientId: null } : {}),
    ...(and.length ? { AND: and } : {}),
  }
}

/** Server-side sort keys for the client list. Outstanding and health are computed in the browser and are not here. */
export const CLIENT_SORTS = {
  company_name: 'companyName',
  client_id: 'clientCode',
  status: 'status',
  onboarding_date: 'onboardingDate',
  created_at: 'createdAt',
} as const

export function clientOrderBy(query: Record<string, unknown>): Prisma.ClientOrderByWithRelationInput[] {
  const key = str(query.sort) as keyof typeof CLIENT_SORTS
  const dir: Prisma.SortOrder = str(query.order) === 'desc' ? 'desc' : 'asc'
  const col = CLIENT_SORTS[key]
  // Client code breaks ties so a page boundary never shuffles rows.
  return col ? [{ [col]: dir }, { clientCode: 'asc' }] : [{ clientCode: 'asc' }]
}

/**
 * The business types offered in the import template's dropdown. Each one maps
 * to a real entity type in compliance/engine.ts `entityTypeOf` (never 'any'),
 * so an imported client gets the right statutory forms.
 */
export const BUSINESS_TYPES = [
  'Private Limited Company',
  'Public Limited Company',
  'One Person Company (OPC)',
  'Section 8 Company',
  'LLP',
  'Partnership Firm',
  'Proprietorship',
  'Individual',
  'HUF',
  'Trust',
  'Society',
  'AOP / BOI',
] as const
