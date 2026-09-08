import { PrismaClient } from '@prisma/client'
import type { BooksContext } from '../engine/context.js'
import { createBooksOrganisation, systemLedger } from '../engine/organisation.js'
import type { SystemKey } from '../engine/chart.js'

/** One client per test file; the global setup already pushed the schema. */
export const prisma = new PrismaClient({ datasources: { db: { url: 'file:./books-test.db' } } })

let seq = 0
export function uid(prefix = 'id') { return `${prefix}-${Date.now().toString(36)}-${++seq}` }

/** A fresh set of books with the default chart, owned by a synthetic firm. */
export async function freshBooks(overrides: Partial<Parameters<typeof createBooksOrganisation>[1]> = {}) {
  const organisationId = overrides.organisationId ?? uid('firm')
  const userId = overrides.userId ?? uid('user')
  const org = await createBooksOrganisation(prisma, {
    organisationId, userId, name: overrides.name ?? `Books ${seq}`, stateCode: overrides.stateCode ?? '33', stateName: 'Tamil Nadu',
    gstin: overrides.gstin ?? '33AAACS1234A1Z5', ...overrides,
  })
  const ctx: BooksContext = { booksOrgId: org.id, organisationId, userId, role: 'admin', baseCurrency: org.baseCurrency, stateCode: org.stateCode, tdsEnabled: true }
  return { org, ctx, userId, organisationId }
}

export async function ledger(ctx: BooksContext, key: SystemKey) {
  return systemLedger(prisma, ctx.booksOrgId, key)
}

export async function ledgerByName(ctx: BooksContext, name: string) {
  const row = await prisma.booksLedger.findFirst({ where: { booksOrgId: ctx.booksOrgId, name } })
  if (!row) throw new Error(`no ledger ${name}`)
  return row
}

export async function taxRate(ctx: BooksContext, name: string) {
  const row = await prisma.booksTaxRate.findFirst({ where: { booksOrgId: ctx.booksOrgId, name } })
  if (!row) throw new Error(`no tax rate ${name}`)
  return row
}

/**
 * Net balance of a ledger: debit − credit, in paise. A voided journal stays
 * on the ledger together with its reversal (they cancel), which is how the
 * reports read it too — history is never removed.
 */
export async function balance(ctx: BooksContext, ledgerId: string): Promise<bigint> {
  const rows = await prisma.booksJournalLine.findMany({ where: { booksOrgId: ctx.booksOrgId, ledgerId, journal: { status: { in: ['posted', 'void'] } } } })
  return rows.reduce((t, l) => t + (l.side === 'debit' ? l.amount : -l.amount), 0n)
}

export const paise = (rupees: number) => BigInt(Math.round(rupees * 100))
