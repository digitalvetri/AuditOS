import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'

/**
 * Bank accounts per client — the auditor picks one before uploading a
 * statement. Full account numbers are NOT stored on this slice; only the
 * masked form (e.g. "•••4471"). If the firm ever needs the full number,
 * add an encrypted column then — see the plan's "Follow-on slices".
 *
 * Scope: every read is bound to the caller's organisationId. Cross-org
 * access is not possible even by id.
 */

export interface AaAccountApi {
  id: string
  client_id: string
  bank_id: string
  account_number_masked: string
  label: string | null
  currency: string
}

function orgIdOf(session: Session) {
  return prisma.user.findUniqueOrThrow({
    where: { id: session.userId },
    select: { organisationId: true },
  })
}

function toApi(row: {
  id: string
  clientId: string
  bankId: string
  accountNumberMasked: string
  label: string | null
  currency: string
}): AaAccountApi {
  return {
    id: row.id,
    client_id: row.clientId,
    bank_id: row.bankId,
    account_number_masked: row.accountNumberMasked,
    label: row.label,
    currency: row.currency,
  }
}

export const AaAccountService = {
  toApi,

  async listForClient(session: Session, clientId: string, bankId?: string): Promise<AaAccountApi[]> {
    const { organisationId } = await orgIdOf(session)
    const rows = await prisma.aaBankAccount.findMany({
      where: { ...alive, organisationId, clientId, active: true, ...(bankId ? { bankId } : {}) },
      orderBy: [{ createdAt: 'asc' }],
    })
    return rows.map(toApi)
  },

  async create(session: Session, input: {
    clientId: string
    bankId: string
    accountNumberMasked: string
    label?: string | null
    currency?: string
  }): Promise<AaAccountApi> {
    const { organisationId } = await orgIdOf(session)
    // Confirm the client belongs to this org — never trust the id.
    const client = await prisma.client.findFirst({
      where: { id: input.clientId, organisationId, deletedAt: null },
      select: { id: true },
    })
    if (!client) throw ApiError.notFound('No such client.')
    const bank = await prisma.aaBank.findUnique({ where: { id: input.bankId }, select: { id: true, active: true } })
    if (!bank || !bank.active) throw ApiError.notFound('No such bank.')

    // Sanity check: the mask should only contain digits and common masking
    // glyphs (•, X, x, *, ., -, space). We never accept a full account number
    // here — the plan defers that.
    const masked = input.accountNumberMasked.trim()
    if (!masked) throw ApiError.badRequest('Enter the account number (masked, e.g. •••4471).')
    if (!/^[0-9•Xx*.\-\s]{4,32}$/.test(masked)) throw ApiError.badRequest('Account number contains unsupported characters.')

    const row = await prisma.aaBankAccount.create({
      data: {
        organisationId,
        clientId: input.clientId,
        bankId: input.bankId,
        accountNumberMasked: masked,
        label: input.label?.trim() || null,
        currency: input.currency?.trim() || 'INR',
      },
    })
    return toApi(row)
  },

  async requireOwned(session: Session, id: string) {
    const { organisationId } = await orgIdOf(session)
    const row = await prisma.aaBankAccount.findFirst({
      where: { id, ...alive, organisationId },
    })
    if (!row) throw ApiError.notFound('No such account.')
    return row
  },
}
