import type { Prisma, PrismaClient } from '@prisma/client'
import { CIN_RE, LLPIN_RE } from '../gst/validate.js'
import { alive, prisma } from '../../lib/prisma.js'
import type { Session } from '../../platform/auth.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import { nextClientCode } from '../../platform/workstation/codes.js'
import { deriveShortName } from '../../platform/workstation/organization.js'
import { assignedClientIds, clientIdWhere } from '../../platform/workstation/scope.js'
import { ORGANIZATION_REF } from '../../api/workstation.serialize.js'
import { TAN_RE } from '../gst/validate.js'
import { FieldErrors } from './validate.js'
import { istToday } from '../../lib/dates.js'
import { lockSequence } from '../../lib/sequence.js'
import { stringifyJson } from '../../lib/json.js'
import { AUDIT_CHAIN_LOCK, auditHash, type AuditHashInput } from '../../platform/audit.js'

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
  if (gstin && pan) {
    const msg = gstinPanMismatch(gstin, pan)
    if (msg) v.add('gstin', msg)
  }

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

/**
 * Validate the optional `additional_contacts` array on POST / PATCH /api/clients.
 *
 * Returns `undefined` when the key is absent (PATCH: leave contacts alone),
 * `[]` for an empty array (PATCH: clear extras), or the normalised rows.
 * Each extra needs a name + a valid phone; email and designation are optional.
 * Errors land on paths like `additional_contacts.0.phone`.
 */
export interface ExtraContact {
  name: string
  phone: string
  email: string | null
  designation: string | null
}
export function readExtraContacts(v: FieldErrors, b: Record<string, unknown>): ExtraContact[] | undefined {
  if (!('additional_contacts' in b)) return undefined
  const raw = b.additional_contacts
  if (raw === null || raw === undefined) return []
  if (!Array.isArray(raw)) {
    v.add('additional_contacts', 'Must be a list of contacts.')
    return []
  }
  const out: ExtraContact[] = []
  raw.slice(0, 20).forEach((row, i) => {
    const r = (row ?? {}) as Record<string, unknown>
    const name = v.str(`additional_contacts.${i}.name`, r.name, { max: 120 })
    const phone = v.phone(`additional_contacts.${i}.phone`, r.phone)
    const email = v.email(`additional_contacts.${i}.email`, r.email, false)
    const designation = v.str(`additional_contacts.${i}.designation`, r.designation, { required: false, max: 80 })
    if (name && phone) {
      out.push({ name, phone, email: email ?? null, designation: designation ?? null })
    }
  })
  return out
}

/** 'CLI-1041' → 'CLI-1042'. */
export function bumpClientCode(code: string): string {
  const m = /^(.*?)(\d+)$/.exec(code)
  return m ? `${m[1]}${Number(m[2]) + 1}` : code
}

/**
 * Phone-number collision scan (POST-DELIVERY-CHANGES §B2).
 *
 * Returns other clients already holding this contact_number. Compared on the
 * NORMALISED digits that v.phone() produces, so differently-formatted entries
 * ('044 12345678' vs '04412345678') still collide. Soft-deleted clients are
 * excluded — a historical row shouldn't pin a warning on a live creation.
 *
 * The doc's intent: WARN, DO NOT BLOCK. A proprietor and their firm
 * legitimately share a number; the firm needs to KNOW about the overlap,
 * not be forced to resolve it before saving.
 */
export async function findDuplicatePhoneClients(
  session: Session,
  phone: string | null | undefined,
  excludeId?: string,
): Promise<DuplicateClients> {
  if (!phone) return { visible: [], hidden: 0 }
  return findDuplicateClients(session, { contactNumber: phone }, excludeId)
}

/**
 * GSTIN collision scan: a GSTIN belongs to one taxpayer, so a second client
 * with it is almost always a duplicate (two GST filing jobs, two sets of
 * invoices). Warned, not blocked — a branch kept as its own client is a
 * legitimate exception — and scoped exactly like the phone warning.
 */
export async function findDuplicateGstinClients(
  session: Session,
  gstin: string | null | undefined,
  excludeId?: string,
): Promise<DuplicateClients> {
  if (!gstin) return { visible: [], hidden: 0 }
  return findDuplicateClients(session, { gstin }, excludeId)
}

export interface DuplicateClients {
  visible: Array<{ id: string; client_code: string; company_name: string }>
  hidden: number
}

async function findDuplicateClients(
  session: Session,
  match: Prisma.ClientWhereInput,
  excludeId?: string,
): Promise<DuplicateClients> {
  const where: Prisma.ClientWhereInput = {
    ...match,
    deletedAt: null,
    ...(excludeId ? { id: { not: excludeId } } : {}),
  }
  // Only clients the caller may see are named. Staff who see only their
  // assigned clients are told how many OTHER clients match, never which —
  // the warning must not become a way to discover unseen clients.
  const ids = await assignedClientIds(session, 'organisation')
  const visibleWhere: Prisma.ClientWhereInput = ids === 'ALL' ? where : { AND: [where, { id: { in: ids } }] }
  const [matches, total] = await Promise.all([
    prisma.client.findMany({
      where: visibleWhere,
      select: { id: true, clientCode: true, companyName: true },
      // Cap defensively — the warning only needs a nudge, not a full list.
      take: 5,
    }),
    prisma.client.count({ where }),
  ])
  const visibleCount = ids === 'ALL' ? total : await prisma.client.count({ where: visibleWhere })
  return {
    visible: matches.map((c) => ({ id: c.id, client_code: c.clientCode, company_name: c.companyName })),
    hidden: total - visibleCount,
  }
}

/**
 * Characters 3–12 of a GSTIN are the holder's PAN. Null when they agree (or
 * either is missing); otherwise the message for the `gstin` field.
 */
export function gstinPanMismatch(gstin: string | null | undefined, pan: string | null | undefined): string | null {
  if (!gstin || !pan) return null
  const embedded = gstin.slice(2, 12).toUpperCase()
  return embedded === pan.toUpperCase()
    ? null
    : `This GSTIN belongs to PAN ${embedded}, but the PAN entered is ${pan.toUpperCase()}. Correct whichever is wrong.`
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * A client is `onboarding` until the firm takes on its first piece of work:
 * assigning a service moves it to `active` (so "Active clients" counts it).
 * Only `onboarding` moves — a client set to another status by hand keeps it.
 * Returns true when it changed.
 */
export async function activateIfOnboarding(tx: Prisma.TransactionClient, clientId: string, userId: string | null): Promise<boolean> {
  const r = await tx.client.updateMany({ where: { id: clientId, status: 'onboarding' }, data: { status: 'active', updatedBy: userId } })
  return r.count > 0
}

/**
 * One-time deploy correction (run from seed): before activateIfOnboarding
 * existed nothing moved a client out of `onboarding`, so clients that already
 * have a service are moved to `active` once. Marked by its audit row, so a
 * client deliberately set back to onboarding later is never touched again.
 * Returns how many clients moved (0 when already done).
 */
export const ONBOARDING_BACKFILL_ACTION = 'client.onboarding_backfill'
export async function backfillOnboardingWithServices(db: PrismaClient): Promise<number> {
  return db.$transaction(async (tx) => {
    await lockSequence(tx, AUDIT_CHAIN_LOCK)
    if (await tx.auditLog.findFirst({ where: { action: ONBOARDING_BACKFILL_ACTION }, select: { id: true } })) return 0
    const rows = await tx.client.findMany({
      where: { status: 'onboarding', deletedAt: null, services: { some: { deletedAt: null } } }, select: { id: true },
    })
    const ids = rows.map((r) => r.id)
    if (ids.length) await tx.client.updateMany({ where: { id: { in: ids } }, data: { status: 'active' } })
    const content: AuditHashInput = {
      actorUserId: null, action: ONBOARDING_BACKFILL_ACTION, entityType: 'Client', entityId: 'all',
      beforeJson: null, afterJson: stringifyJson({ moved_to_active: ids.length, client_ids: ids }), ip: null, createdAt: new Date(),
    }
    const last = await tx.auditLog.findFirst({ where: { hash: { not: null } }, orderBy: { seq: 'desc' }, select: { hash: true } })
    const prevHash = last?.hash ?? null
    await tx.auditLog.create({ data: { ...content, prevHash, hash: auditHash(prevHash, content) } })
    return ids.length
  }, { maxWait: 15_000, timeout: 30_000 })
}

/**
 * The client master's contact fields ARE the primary contact: keep the
 * primary ClientContact row in step (create it if a legacy client has none),
 * so the header's tel:/mailto: never reach the old person or number.
 */
export async function syncPrimaryContact(
  tx: Prisma.TransactionClient,
  client: { id: string; contactPerson: string; contactNumber: string; email: string | null },
  userId: string | null,
): Promise<void> {
  const primary = await tx.clientContact.findFirst({ where: { clientId: client.id, isPrimary: true, deletedAt: null }, orderBy: { createdAt: 'asc' } })
  const data = { name: client.contactPerson, phone: client.contactNumber, email: client.email }
  if (!primary) {
    await tx.clientContact.create({ data: { clientId: client.id, ...data, designation: 'Primary contact', isPrimary: true, createdBy: userId } })
  } else if (primary.name !== data.name || primary.phone !== data.phone || primary.email !== data.email) {
    await tx.clientContact.update({ where: { id: primary.id }, data: { ...data, updatedBy: userId } })
  }
}

// ── Exit date ───────────────────────────────────────────────────────────────

/**
 * The exit-date half of a status change. The exit date is the day the firm
 * stopped acting, and the retention period (data-protection/retention.ts)
 * runs from it, so every path that changes a client's status goes through
 * here:
 *  - leaving `inactive` clears the exit date and reason, so a stale date can
 *    never come back with the next exit;
 *  - an inactive client always has an exit date: the one given, else the one
 *    it already had if it was already inactive, else today.
 */
export function exitFieldsFor(
  before: { status: string; exitDate: string | null },
  nextStatus: string,
  givenExitDate?: string | null,
): { exitDate?: string | null; exitReason?: null } {
  if (nextStatus !== 'inactive') {
    return before.status === 'inactive' || before.exitDate ? { exitDate: null, exitReason: null } : {}
  }
  if (givenExitDate) return { exitDate: givenExitDate }
  if (before.status === 'inactive' && before.exitDate && givenExitDate === undefined) return {}
  return { exitDate: istToday() }
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
