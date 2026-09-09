import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { TallyCompanyService } from './TallyCompanyService.js'

/**
 * TallyLedgerService — the ledgers under a company. Opening balances
 * are captured in paise (Int); every voucher line written in Slice 2+
 * will reference these rows. Soft-delete is blocked in Slice 2+ once
 * posted voucher lines exist (spec §2.1 rule 8).
 */

export interface LedgerApi {
  id: string
  name: string
  group_id: string
  opening_balance_paise: number
  opening_balance_type: 'dr' | 'cr'
  opening_balance_as_of_fy_id: string | null
  address: string | null
  contact: string | null
  gstin: string | null
  pan: string | null
  state: string | null
  gst_registration_type: string | null
  credit_period_days: number | null
  bank_account_name: string | null
  bank_account_number: string | null
  bank_ifsc: string | null
  tax_config: unknown
  active: boolean
}

function toApi(row: {
  id: string; name: string; groupId: string; openingBalancePaise: number;
  openingBalanceType: string; openingBalanceAsOfFyId: string | null;
  address: string | null; contact: string | null; gstin: string | null;
  pan: string | null; state: string | null; gstRegistrationType: string | null;
  creditPeriodDays: number | null; bankAccountName: string | null;
  bankAccountNumber: string | null; bankIfsc: string | null;
  taxConfigJson: string | null; active: boolean;
}): LedgerApi {
  let tax: unknown = null
  if (row.taxConfigJson) { try { tax = JSON.parse(row.taxConfigJson) } catch { tax = null } }
  return {
    id: row.id, name: row.name, group_id: row.groupId,
    opening_balance_paise: row.openingBalancePaise,
    opening_balance_type: row.openingBalanceType === 'cr' ? 'cr' : 'dr',
    opening_balance_as_of_fy_id: row.openingBalanceAsOfFyId,
    address: row.address, contact: row.contact,
    gstin: row.gstin, pan: row.pan, state: row.state,
    gst_registration_type: row.gstRegistrationType,
    credit_period_days: row.creditPeriodDays,
    bank_account_name: row.bankAccountName,
    bank_account_number: row.bankAccountNumber,
    bank_ifsc: row.bankIfsc,
    tax_config: tax, active: row.active,
  }
}

export interface CreateLedgerInput {
  name: string
  groupId: string
  openingBalancePaise?: number
  openingBalanceType?: 'dr' | 'cr'
  openingBalanceAsOfFyId?: string | null
  address?: string
  contact?: string
  gstin?: string
  pan?: string
  state?: string
  gstRegistrationType?: string
  creditPeriodDays?: number
  bankAccountName?: string
  bankAccountNumber?: string
  bankIfsc?: string
  taxConfig?: unknown
}

async function assertGroupInCompany(companyId: string, groupId: string) {
  const group = await prisma.tallyGroup.findFirst({
    where: { id: groupId, tallyCompanyId: companyId, ...alive },
  })
  if (!group) throw ApiError.badRequest('Group does not belong to this company.')
}

async function assertFyInCompany(companyId: string, fyId: string) {
  const fy = await prisma.tallyFinancialYear.findFirst({
    where: { id: fyId, tallyCompanyId: companyId },
  })
  if (!fy) throw ApiError.badRequest('Financial year does not belong to this company.')
}

export const TallyLedgerService = {
  toApi,

  async list(session: Session, companyId: string, filter: { groupId?: string; q?: string } = {}): Promise<LedgerApi[]> {
    await TallyCompanyService.requireOwned(session, companyId)
    const where: Record<string, unknown> = { tallyCompanyId: companyId, ...alive }
    if (filter.groupId) where.groupId = filter.groupId
    if (filter.q) where.name = { contains: filter.q }
    const rows = await prisma.tallyLedger.findMany({ where, orderBy: [{ name: 'asc' }] })
    return rows.map(toApi)
  },

  async get(session: Session, companyId: string, id: string): Promise<LedgerApi> {
    await TallyCompanyService.requireOwned(session, companyId)
    const row = await prisma.tallyLedger.findFirst({
      where: { id, tallyCompanyId: companyId, ...alive },
    })
    if (!row) throw ApiError.notFound('No such ledger.')
    return toApi(row)
  },

  async create(session: Session, companyId: string, input: CreateLedgerInput): Promise<LedgerApi> {
    await TallyCompanyService.requireOwned(session, companyId)
    const name = input.name.trim()
    if (!name) throw ApiError.badRequest('Ledger name is required.')
    await assertGroupInCompany(companyId, input.groupId)
    if (input.openingBalanceAsOfFyId) await assertFyInCompany(companyId, input.openingBalanceAsOfFyId)
    const clash = await prisma.tallyLedger.findFirst({
      where: { tallyCompanyId: companyId, name, ...alive }, select: { id: true },
    })
    if (clash) throw ApiError.conflict('duplicate_name', `A ledger named "${name}" already exists.`)

    const opening = Math.max(0, Math.round(input.openingBalancePaise ?? 0))
    const openingType = input.openingBalanceType === 'cr' ? 'cr' : 'dr'

    const row = await prisma.tallyLedger.create({
      data: {
        tallyCompanyId: companyId,
        name,
        groupId: input.groupId,
        openingBalancePaise: opening,
        openingBalanceType: openingType,
        openingBalanceAsOfFyId: input.openingBalanceAsOfFyId ?? null,
        address: input.address?.trim() || null,
        contact: input.contact?.trim() || null,
        gstin: input.gstin?.trim() || null,
        pan: input.pan?.trim() || null,
        state: input.state?.trim() || null,
        gstRegistrationType: input.gstRegistrationType?.trim() || null,
        creditPeriodDays: input.creditPeriodDays ?? null,
        bankAccountName: input.bankAccountName?.trim() || null,
        bankAccountNumber: input.bankAccountNumber?.trim() || null,
        bankIfsc: input.bankIfsc?.trim() || null,
        taxConfigJson: input.taxConfig ? JSON.stringify(input.taxConfig) : null,
      },
    })
    return toApi(row)
  },

  async update(session: Session, companyId: string, id: string, patch: Partial<CreateLedgerInput> & { active?: boolean }): Promise<LedgerApi> {
    await TallyCompanyService.requireOwned(session, companyId)
    const existing = await prisma.tallyLedger.findFirst({
      where: { id, tallyCompanyId: companyId, ...alive },
    })
    if (!existing) throw ApiError.notFound('No such ledger.')
    const data: Record<string, unknown> = {}
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) throw ApiError.badRequest('Ledger name is required.')
      const clash = await prisma.tallyLedger.findFirst({
        where: { tallyCompanyId: companyId, name, ...alive, NOT: { id } }, select: { id: true },
      })
      if (clash) throw ApiError.conflict('duplicate_name', `A ledger named "${name}" already exists.`)
      data.name = name
    }
    if (patch.groupId !== undefined) {
      await assertGroupInCompany(companyId, patch.groupId)
      data.groupId = patch.groupId
    }
    if (patch.openingBalancePaise !== undefined) data.openingBalancePaise = Math.max(0, Math.round(patch.openingBalancePaise))
    if (patch.openingBalanceType !== undefined) data.openingBalanceType = patch.openingBalanceType === 'cr' ? 'cr' : 'dr'
    if (patch.openingBalanceAsOfFyId !== undefined) {
      if (patch.openingBalanceAsOfFyId) await assertFyInCompany(companyId, patch.openingBalanceAsOfFyId)
      data.openingBalanceAsOfFyId = patch.openingBalanceAsOfFyId
    }
    for (const k of ['address', 'contact', 'gstin', 'pan', 'state', 'gstRegistrationType', 'bankAccountName', 'bankAccountNumber', 'bankIfsc'] as const) {
      if ((patch as Record<string, unknown>)[k] !== undefined) {
        const v = (patch as Record<string, string | null | undefined>)[k]
        data[k] = typeof v === 'string' ? v.trim() || null : null
      }
    }
    if (patch.creditPeriodDays !== undefined) data.creditPeriodDays = patch.creditPeriodDays
    if (patch.taxConfig !== undefined) data.taxConfigJson = patch.taxConfig ? JSON.stringify(patch.taxConfig) : null
    if (patch.active !== undefined) data.active = patch.active

    const updated = await prisma.tallyLedger.update({ where: { id }, data })
    return toApi(updated)
  },

  async softDelete(session: Session, companyId: string, id: string): Promise<void> {
    await TallyCompanyService.requireOwned(session, companyId)
    const existing = await prisma.tallyLedger.findFirst({
      where: { id, tallyCompanyId: companyId, ...alive },
    })
    if (!existing) throw ApiError.notFound('No such ledger.')
    // Slice 2+ will block this if any posted voucher lines reference the ledger.
    // For Slice 1 there are no vouchers yet, so soft-delete is unconditional.
    await prisma.tallyLedger.update({ where: { id }, data: { deletedAt: new Date(), active: false } })
  },
}
