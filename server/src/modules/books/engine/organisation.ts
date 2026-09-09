import type { PrismaClient } from '@prisma/client'
import type { BooksContext, Db } from './context.js'
import { DEFAULT_GROUPS, DEFAULT_LEDGERS, DEFAULT_TAX_RATES, type SystemKey } from './chart.js'
import { booksAudit } from './audit.js'
import { BooksError } from './errors.js'
import { postJournal } from './posting.js'
import { withBooksTx } from './posting.js'
import type { Minor } from './money.js'

/**
 * Create a set of books with the default chart of accounts, tax rates and
 * number sequences, and make the creator its first admin.
 */
export async function createBooksOrganisation(prisma: PrismaClient, input: {
  organisationId: string
  userId: string | null
  name: string
  legalName?: string | null
  gstin?: string | null
  pan?: string | null
  stateCode?: string | null
  stateName?: string | null
  baseCurrency?: string
  fiscalYearStartMonth?: number
  clientId?: string | null
  addressLine1?: string | null
  city?: string | null
  pincode?: string | null
}) {
  return withBooksTx(prisma, async (tx) => {
    const org = await tx.booksOrganisation.create({
      data: {
        organisationId: input.organisationId,
        clientId: input.clientId ?? null,
        name: input.name.trim(),
        legalName: input.legalName ?? null,
        gstin: input.gstin ?? null,
        pan: input.pan ?? null,
        stateCode: input.stateCode ?? null,
        stateName: input.stateName ?? null,
        addressLine1: input.addressLine1 ?? null,
        city: input.city ?? null,
        pincode: input.pincode ?? null,
        baseCurrency: input.baseCurrency ?? 'INR',
        fiscalYearStartMonth: input.fiscalYearStartMonth ?? 4,
        createdBy: input.userId,
        updatedBy: input.userId,
      },
    })
    if (input.userId) {
      await tx.booksMembership.create({ data: { booksOrgId: org.id, userId: input.userId, role: 'admin', createdBy: input.userId } })
    }
    await seedChart(tx, org.id, org.baseCurrency)
    for (const t of DEFAULT_TAX_RATES) {
      await tx.booksTaxRate.create({
        data: { booksOrgId: org.id, name: t.name, type: t.type, percentageBp: t.percentageBp, noPanPercentageBp: 'noPanPercentageBp' in t ? t.noPanPercentageBp : null, section: 'section' in t ? t.section : null },
      })
    }
    const ctx: BooksContext = { booksOrgId: org.id, organisationId: org.organisationId, userId: input.userId, role: 'admin', baseCurrency: org.baseCurrency, stateCode: org.stateCode, tdsEnabled: org.tdsEnabled }
    await booksAudit(tx, ctx, { entityType: 'organisation', entityId: org.id, action: 'organisation.created', after: { name: org.name, gstin: org.gstin, state: org.stateCode } })
    return org
  })
}

async function seedChart(db: Db, booksOrgId: string, currency: string) {
  const groupIds = new Map<string, string>()
  for (const g of DEFAULT_GROUPS) {
    const row = await db.booksAccountGroup.create({
      data: { booksOrgId, name: g.name, rootCategory: g.rootCategory, tallyGroup: g.tallyGroup, parentGroupId: g.parent ? groupIds.get(g.parent) ?? null : null, isSystem: true, sortOrder: g.sortOrder },
    })
    groupIds.set(g.name, row.id)
  }
  for (const l of DEFAULT_LEDGERS) {
    const g = DEFAULT_GROUPS.find((x) => x.name === l.group)!
    await db.booksLedger.create({
      data: {
        booksOrgId, groupId: groupIds.get(l.group)!, name: l.name, rootCategory: g.rootCategory, tallyGroup: g.tallyGroup,
        systemKey: l.systemKey ?? null, billWise: l.billWise ?? false, isBank: l.isBank ?? false, isCash: l.isCash ?? false,
        isSystem: Boolean(l.systemKey), currency, description: l.description ?? null,
      },
    })
  }
}

/** The engine's named ledger. Throws if a set of books has lost it. */
export async function systemLedger(db: Db, booksOrgId: string, key: SystemKey) {
  const row = await db.booksLedger.findFirst({ where: { booksOrgId, systemKey: key, deletedAt: null } })
  if (!row) throw new BooksError('missing_system_ledger', `This set of books has no "${key}" ledger. Restore it in the chart of accounts.`)
  return row
}

/**
 * Opening balance for a ledger: posted as an opening journal against
 * Opening Balance Equity, so reports derive purely from journals.
 */
export async function postOpeningBalance(db: Db, ctx: BooksContext, ledgerId: string, amount: Minor, type: 'debit' | 'credit', date: string) {
  if (amount <= 0n) throw new BooksError('invalid_amount', 'Opening balance must be greater than zero.')
  const obe = await systemLedger(db, ctx.booksOrgId, 'opening_balance_equity')
  return postJournal(db, ctx, {
    date, voucherType: 'opening', sourceModule: 'ledger', sourceId: ledgerId, narration: 'Opening balance',
    lines: [
      { ledgerId, side: type, amount },
      { ledgerId: obe.id, side: type === 'debit' ? 'credit' : 'debit', amount },
    ],
  })
}
