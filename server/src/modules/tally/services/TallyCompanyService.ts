import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { PRIMARY_GROUPS } from './primaryGroups.js'

/**
 * TallyCompanyService — the one place a TallyCompany is created,
 * listed, read, updated, or soft-deleted. Strict (organisationId)
 * scoping on every read; nested company scoping is enforced by the
 * ledger/group services on top of this.
 *
 * `createCompany` seeds the 17 primary groups and the first financial
 * year in a single Prisma transaction — either everything lands or
 * nothing does, so a company is never left half-initialised.
 */

export interface CompanyApi {
  id: string
  name: string
  mailing_name: string | null
  address: string | null
  country: string
  state: string | null
  pin: string | null
  phone: string | null
  email: string | null
  website: string | null
  base_currency: string
  gst_registration_type: string
  gstin: string | null
  pan: string | null
  tan: string | null
  fy_begin_month: number
  books_begin_from: string
  active: boolean
  created_at: string
}

function toApi(row: {
  id: string; name: string; mailingName: string | null; address: string | null;
  country: string; state: string | null; pin: string | null; phone: string | null;
  email: string | null; website: string | null; baseCurrency: string;
  gstRegistrationType: string; gstin: string | null; pan: string | null; tan: string | null;
  fyBeginMonth: number; booksBeginFrom: string; active: boolean; createdAt: Date;
}): CompanyApi {
  return {
    id: row.id, name: row.name, mailing_name: row.mailingName, address: row.address,
    country: row.country, state: row.state, pin: row.pin, phone: row.phone,
    email: row.email, website: row.website, base_currency: row.baseCurrency,
    gst_registration_type: row.gstRegistrationType, gstin: row.gstin, pan: row.pan, tan: row.tan,
    fy_begin_month: row.fyBeginMonth, books_begin_from: row.booksBeginFrom, active: row.active,
    created_at: row.createdAt.toISOString(),
  }
}

async function organisationIdOf(session: Session): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({
    where: { id: session.userId }, select: { organisationId: true },
  })
  return u.organisationId
}

/** Compute the FY label + range from a books-begin date (Indian FY). */
function fyRangeFor(booksBeginFrom: string, fyBeginMonth: number): { label: string; startDate: string; endDate: string } {
  const [yStr, mStr] = booksBeginFrom.split('-')
  const y = Number(yStr)
  const m = Number(mStr)
  const start = m >= fyBeginMonth ? y : y - 1
  const end = start + 1
  const label = `${start}-${String(end).slice(-2)}`
  const startDate = `${start}-${String(fyBeginMonth).padStart(2, '0')}-01`
  // Last day of the month before fyBeginMonth (e.g. March 31 for Indian FY).
  const endMonth = fyBeginMonth === 1 ? 12 : fyBeginMonth - 1
  const endYear = fyBeginMonth === 1 ? end : end
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate()
  const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  return { label, startDate, endDate }
}

export const TallyCompanyService = {
  toApi,
  organisationIdOf,

  async listForOrg(session: Session): Promise<CompanyApi[]> {
    const organisationId = await organisationIdOf(session)
    const rows = await prisma.tallyCompany.findMany({
      where: { organisationId, ...alive },
      orderBy: [{ createdAt: 'asc' }],
    })
    return rows.map(toApi)
  },

  async get(session: Session, id: string): Promise<CompanyApi> {
    const organisationId = await organisationIdOf(session)
    const row = await prisma.tallyCompany.findFirst({
      where: { id, organisationId, ...alive },
    })
    if (!row) throw ApiError.notFound('No such company.')
    return toApi(row)
  },

  /**
   * Load the company row plus assert organisation ownership. Used by
   * the group/ledger services (and future voucher services) to gate
   * every read/write on the parent company.
   */
  async requireOwned(session: Session, companyId: string) {
    const organisationId = await organisationIdOf(session)
    const row = await prisma.tallyCompany.findFirst({
      where: { id: companyId, organisationId, ...alive },
    })
    if (!row) throw ApiError.notFound('No such company.')
    return row
  },

  async create(session: Session, input: {
    name: string
    mailingName?: string
    address?: string
    state?: string
    pin?: string
    phone?: string
    email?: string
    website?: string
    gstRegistrationType?: string
    gstin?: string
    pan?: string
    tan?: string
    fyBeginMonth?: number
    booksBeginFrom: string
  }): Promise<CompanyApi> {
    const organisationId = await organisationIdOf(session)
    const name = input.name.trim()
    if (!name) throw ApiError.badRequest('Company name is required.')
    // Basic date sanity
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.booksBeginFrom)) {
      throw ApiError.badRequest('Books begin date must be YYYY-MM-DD.')
    }
    // Uniqueness within the org (also enforced by the @@unique on the model)
    const clash = await prisma.tallyCompany.findFirst({
      where: { organisationId, name, ...alive }, select: { id: true },
    })
    if (clash) throw ApiError.conflict('duplicate_name', `A company named "${name}" already exists.`)

    const fyBeginMonth = input.fyBeginMonth ?? 4
    const fy = fyRangeFor(input.booksBeginFrom, fyBeginMonth)

    const created = await prisma.$transaction(async (tx) => {
      const company = await tx.tallyCompany.create({
        data: {
          organisationId,
          name,
          mailingName: input.mailingName?.trim() || null,
          address: input.address?.trim() || null,
          state: input.state?.trim() || null,
          pin: input.pin?.trim() || null,
          phone: input.phone?.trim() || null,
          email: input.email?.trim() || null,
          website: input.website?.trim() || null,
          gstRegistrationType: input.gstRegistrationType?.trim() || 'regular',
          gstin: input.gstin?.trim() || null,
          pan: input.pan?.trim() || null,
          tan: input.tan?.trim() || null,
          fyBeginMonth,
          booksBeginFrom: input.booksBeginFrom,
        },
      })
      // Seed the 17 primary groups.
      await tx.tallyGroup.createMany({
        data: PRIMARY_GROUPS.map((g) => ({
          tallyCompanyId: company.id,
          name: g.name,
          nature: g.nature,
          affectsPL: g.affectsPL,
          isPrimary: true,
        })),
      })
      // Seed the first FY.
      await tx.tallyFinancialYear.create({
        data: {
          tallyCompanyId: company.id,
          label: fy.label,
          startDate: fy.startDate,
          endDate: fy.endDate,
        },
      })
      return company
    })
    return toApi(created)
  },

  async update(session: Session, id: string, patch: Partial<{
    name: string
    mailingName: string | null
    address: string | null
    state: string | null
    pin: string | null
    phone: string | null
    email: string | null
    website: string | null
    gstRegistrationType: string
    gstin: string | null
    pan: string | null
    tan: string | null
    active: boolean
  }>): Promise<CompanyApi> {
    await TallyCompanyService.requireOwned(session, id)
    const data: Record<string, unknown> = {}
    if (patch.name !== undefined) data.name = patch.name.trim()
    if (patch.mailingName !== undefined) data.mailingName = patch.mailingName?.trim() || null
    if (patch.address !== undefined) data.address = patch.address?.trim() || null
    if (patch.state !== undefined) data.state = patch.state?.trim() || null
    if (patch.pin !== undefined) data.pin = patch.pin?.trim() || null
    if (patch.phone !== undefined) data.phone = patch.phone?.trim() || null
    if (patch.email !== undefined) data.email = patch.email?.trim() || null
    if (patch.website !== undefined) data.website = patch.website?.trim() || null
    if (patch.gstRegistrationType !== undefined) data.gstRegistrationType = patch.gstRegistrationType.trim() || 'regular'
    if (patch.gstin !== undefined) data.gstin = patch.gstin?.trim() || null
    if (patch.pan !== undefined) data.pan = patch.pan?.trim() || null
    if (patch.tan !== undefined) data.tan = patch.tan?.trim() || null
    if (patch.active !== undefined) data.active = patch.active
    const updated = await prisma.tallyCompany.update({ where: { id }, data })
    return toApi(updated)
  },

  async softDelete(session: Session, id: string): Promise<void> {
    await TallyCompanyService.requireOwned(session, id)
    // Never hard-delete posted financial data (spec §2.1 rule 8).
    // Slice 1 has no vouchers yet, but the soft-delete pattern is the
    // right shape now so we never accidentally start hard-deleting.
    await prisma.tallyCompany.update({ where: { id }, data: { deletedAt: new Date(), active: false } })
  },
}
