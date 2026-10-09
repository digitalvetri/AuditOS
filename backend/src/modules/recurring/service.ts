/**
 * RECURRING RETAINERS — a profile per client (monthly bookkeeping fee,
 * quarterly GST retainer…) that raises the invoice on its own.
 *
 * Each run, for a profile whose nextIssueDate has come:
 *   1. takes a per-profile advisory lock,
 *   2. looks for an invoice ALREADY raised for (profile, date) — if one
 *      exists the period is done and only the pointer moves,
 *   3. creates the invoice (draft, or sent + numbered when autoSend),
 *   4. moves nextIssueDate on with a compare-and-set.
 * All four in ONE transaction: a crash between "invoice created" and "date
 * advanced" rolls both back, so the next run cannot produce a second invoice
 * for the same period. Never two invoices for one profile + date.
 */
import type { Prisma } from '@prisma/client'
import { ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { istToday } from '../../lib/dates.js'
import { lockSequence } from '../../lib/sequence.js'
import type { Session } from '../../platform/auth.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import { assignedClientIds, assertCanSeeClient } from '../../platform/workstation/scope.js'
import { createInvoiceRecord, invoiceHouseStyle, sendInvoiceTx, type InvoiceInput, type Term } from '../invoice/service.js'
import { firstIssueDate, nextIssueDate, periodLabel, type Frequency } from './dates.js'

export interface RecurringLine {
  description: string
  sac_code: string | null
  quantity_centi: number
  unit_rate_paise: number
  gst_rate: number
  discount_paise: number
}

export interface ProfileInput {
  clientId: string
  name: string
  frequency: Frequency
  dayOfMonth: number
  startDate: string
  endDate: string | null
  terms: Exclude<Term, 'custom'>
  placeOfSupply: string | null
  clientServiceId: string | null
  lines: RecurringLine[]
  autoSend: boolean
  isActive: boolean
}

type Row = Prisma.RecurringInvoiceProfileGetPayload<object>

async function serialize(rows: Row[]) {
  const clientIds = [...new Set(rows.map((r) => r.clientId))]
  const lastIds = rows.map((r) => r.lastInvoiceId).filter((x): x is string => Boolean(x))
  const [clients, lasts, counts] = await Promise.all([
    prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, companyName: true } }),
    prisma.invoice.findMany({ where: { id: { in: lastIds } }, select: { id: true, invoiceNumber: true, deletedAt: true } }),
    prisma.invoice.groupBy({ by: ['recurringProfileId'], where: { recurringProfileId: { in: rows.map((r) => r.id) }, deletedAt: null }, _count: { _all: true } }),
  ])
  const cName = new Map(clients.map((c) => [c.id, c.companyName]))
  const last = new Map(lasts.map((l) => [l.id, l]))
  const count = new Map(counts.map((c) => [c.recurringProfileId, c._count._all]))
  return rows.map((r) => {
    const li = r.lastInvoiceId ? last.get(r.lastInvoiceId) : undefined
    return {
      id: r.id,
      client_id: r.clientId,
      client_name: cName.get(r.clientId) ?? null,
      name: r.name,
      frequency: r.frequency,
      day_of_month: r.dayOfMonth,
      start_date: r.startDate,
      end_date: r.endDate,
      next_issue_date: r.nextIssueDate,
      /** False once the next date is past the end date — nothing more will be raised. */
      has_ended: Boolean(r.endDate && r.nextIssueDate > r.endDate),
      terms: r.terms,
      place_of_supply: r.placeOfSupply,
      client_service_id: r.clientServiceId,
      lines: (Array.isArray(r.linesJson) ? r.linesJson : []) as unknown as RecurringLine[],
      auto_send: r.autoSend,
      is_active: r.isActive,
      last_generated_at: r.lastGeneratedAt?.toISOString() ?? null,
      last_invoice_id: li && !li.deletedAt ? li.id : null,
      last_invoice_number: li && !li.deletedAt ? li.invoiceNumber : null,
      invoice_count: count.get(r.id) ?? 0,
      created_at: r.createdAt.toISOString(),
    }
  })
}
export type SerializedProfile = Awaited<ReturnType<typeof serialize>>[number]

async function orgId(): Promise<string> {
  return (await prisma.organisation.findFirst({ select: { id: true } }))?.id ?? 'org-audit-os'
}

function assertLines(lines: RecurringLine[]) {
  if (lines.length === 0) throw ApiError.badRequest('A retainer needs at least one line.')
  for (const l of lines) {
    const gross = Math.round((l.quantity_centi * l.unit_rate_paise) / 100)
    if (l.discount_paise > gross) throw ApiError.badRequest(`The discount on "${l.description}" is more than the line.`)
  }
}

/**
 * Profile lines → invoice items. InvoiceItem carries a PERCENT discount and
 * the profile a rupee one, so a line's rupee discount becomes a reduced rate
 * when it divides exactly; otherwise the rupee discounts are applied as the
 * invoice-level discount (spread pro rata by the totals engine) so the
 * taxable value is exact either way.
 */
export function linesToItems(lines: RecurringLine[]): { items: InvoiceInput['items']; discountPaise: number } {
  let discountPaise = 0
  const items = lines.map((l) => {
    let rate = l.unit_rate_paise
    if (l.discount_paise > 0) {
      const perUnit = (l.discount_paise * 100) / l.quantity_centi
      if (Number.isInteger(perUnit)) rate = l.unit_rate_paise - perUnit
      else discountPaise += l.discount_paise
    }
    return {
      itemName: l.description,
      description: null,
      hsnSac: l.sac_code || null,
      quantityCenti: l.quantity_centi,
      unit: 'Nos',
      ratePaise: Math.max(0, rate),
      discountPercent: 0,
      gstRatePercent: l.gst_rate,
    }
  })
  return { items, discountPaise }
}

async function scopeWhere(session: Session, scope: Scope): Promise<Prisma.RecurringInvoiceProfileWhereInput> {
  if (scope === 'organisation' || scope === 'department') return { deletedAt: null }
  const ids = await assignedClientIds(session, scope)
  return { deletedAt: null, ...(ids === 'ALL' ? {} : { clientId: { in: ids } }) }
}

export type RunOutcome = { created: boolean; invoice_id: string | null; invoice_number: string | null; reason?: string }

/**
 * Raise the invoice for one profile's current nextIssueDate, if it is due.
 * Idempotent: a second call for the same period finds the invoice and
 * creates nothing.
 */
export async function generateForProfile(profileId: string, opts: { today?: string; userId?: string | null; employeeId?: string | null } = {}): Promise<RunOutcome> {
  const today = opts.today ?? istToday()
  return prisma.$transaction(async (tx) => {
    await lockSequence(tx, `recurring:${profileId}`)
    const p = await tx.recurringInvoiceProfile.findFirst({ where: { id: profileId, deletedAt: null } })
    if (!p) throw ApiError.notFound('No such recurring profile.')
    if (!p.isActive) return { created: false, invoice_id: null, invoice_number: null, reason: 'The profile is paused.' }
    const date = p.nextIssueDate
    if (p.endDate && date > p.endDate) return { created: false, invoice_id: null, invoice_number: null, reason: 'The profile has ended.' }
    if (date > today) return { created: false, invoice_id: null, invoice_number: null, reason: `Not due until ${date}.` }

    const next = nextIssueDate(date, p.frequency as Frequency, p.dayOfMonth)
    const existing = await tx.invoice.findFirst({
      where: { recurringProfileId: p.id, invoiceDate: date, deletedAt: null },
      select: { id: true, invoiceNumber: true },
    })
    let invoiceId: string
    let invoiceNumber: string | null = null
    let created = false
    if (existing) {
      invoiceId = existing.id
      invoiceNumber = existing.invoiceNumber
    } else {
      const lines = (Array.isArray(p.linesJson) ? p.linesJson : []) as unknown as RecurringLine[]
      const { items, discountPaise } = linesToItems(lines)
      const style = await invoiceHouseStyle(tx)
      invoiceId = await createInvoiceRecord(tx, {
        ...style,
        clientId: p.clientId,
        invoiceDate: date,
        terms: p.terms as Term,
        placeOfSupply: p.placeOfSupply,
        discountPaise,
        notes: `${p.name} — ${periodLabel(date, p.frequency as Frequency)}`,
        items,
      }, { userId: opts.userId ?? p.createdBy ?? null, employeeId: opts.employeeId ?? null, recurringProfileId: p.id, clientServiceId: p.clientServiceId })
      if (p.autoSend) invoiceNumber = await sendInvoiceTx(tx, invoiceId, opts.userId ?? null)
      created = true
    }
    // Compare-and-set: only the run that still sees `date` may move it on.
    const moved = await tx.recurringInvoiceProfile.updateMany({
      where: { id: p.id, nextIssueDate: date },
      data: { nextIssueDate: next, lastGeneratedAt: new Date(), lastInvoiceId: invoiceId, updatedBy: opts.userId ?? undefined },
    })
    if (moved.count === 0) throw ApiError.conflict('concurrent_run', 'Another run raised this period at the same moment.')
    return { created, invoice_id: invoiceId, invoice_number: invoiceNumber, ...(created ? {} : { reason: 'Already raised for this period.' }) }
  }, { maxWait: 10_000, timeout: 60_000 })
}

/**
 * Every due profile, catching up any periods a stopped server missed (one
 * invoice per period, oldest first). Returns how many invoices were created.
 */
export async function runDueProfiles(today = istToday()): Promise<{ created: number; failed: number }> {
  const due = await prisma.recurringInvoiceProfile.findMany({
    where: { deletedAt: null, isActive: true, nextIssueDate: { lte: today } },
    select: { id: true },
  })
  let created = 0
  let failed = 0
  for (const { id } of due) {
    for (let i = 0; i < 36; i++) {
      try {
        const r = await generateForProfile(id, { today })
        if (r.created) created++
        if (!r.invoice_id) break // not due / ended / paused
      } catch (e) {
        failed++
        console.error('[recurring] profile', id, e instanceof Error ? e.message : e)
        break
      }
    }
  }
  return { created, failed }
}

export const RecurringService = {
  async list(session: Session, scope: Scope) {
    const rows = await prisma.recurringInvoiceProfile.findMany({
      where: await scopeWhere(session, scope), orderBy: [{ isActive: 'desc' }, { nextIssueDate: 'asc' }],
    })
    return { items: await serialize(rows) }
  },

  async get(session: Session, scope: Scope, id: string): Promise<SerializedProfile> {
    const row = await prisma.recurringInvoiceProfile.findFirst({ where: { AND: [await scopeWhere(session, scope), { id }] } })
    if (!row) throw ApiError.notFound('No such recurring profile.')
    return (await serialize([row]))[0]
  },

  async create(session: Session, scope: Scope, input: ProfileInput): Promise<SerializedProfile> {
    await assertCanSeeClient(session, scope, input.clientId)
    assertLines(input.lines)
    if (input.endDate && input.endDate < input.startDate) throw ApiError.badRequest('The end date is before the start date.')
    const row = await prisma.recurringInvoiceProfile.create({
      data: {
        organisationId: await orgId(),
        clientId: input.clientId,
        name: input.name,
        frequency: input.frequency,
        dayOfMonth: input.dayOfMonth,
        startDate: input.startDate,
        endDate: input.endDate,
        nextIssueDate: firstIssueDate(input.startDate, input.frequency, input.dayOfMonth),
        terms: input.terms,
        placeOfSupply: input.placeOfSupply,
        clientServiceId: input.clientServiceId,
        linesJson: input.lines as unknown as Prisma.InputJsonValue,
        autoSend: input.autoSend,
        isActive: input.isActive,
        createdBy: session.userId,
        updatedBy: session.userId,
      },
    })
    return this.get(session, scope, row.id)
  },

  /**
   * Edit a profile. Changing the schedule (start, frequency, day) recomputes
   * the next date from the later of the start date and the day after the
   * last invoice raised, so an edit never re-raises a period already billed.
   */
  async update(session: Session, scope: Scope, id: string, input: ProfileInput): Promise<SerializedProfile> {
    const cur = await this.get(session, scope, id)
    await assertCanSeeClient(session, scope, input.clientId)
    assertLines(input.lines)
    if (input.endDate && input.endDate < input.startDate) throw ApiError.badRequest('The end date is before the start date.')
    const scheduleChanged = cur.start_date !== input.startDate || cur.frequency !== input.frequency || cur.day_of_month !== input.dayOfMonth
    let next = cur.next_issue_date
    if (scheduleChanged) {
      const lastRaised = await prisma.invoice.findFirst({
        where: { recurringProfileId: id, deletedAt: null }, orderBy: { invoiceDate: 'desc' }, select: { invoiceDate: true },
      })
      const after = lastRaised ? (() => { const d = new Date(`${lastRaised.invoiceDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10) })() : input.startDate
      const from = after > input.startDate ? after : input.startDate
      next = firstIssueDate(from, input.frequency, input.dayOfMonth)
    }
    await prisma.recurringInvoiceProfile.update({
      where: { id },
      data: {
        clientId: input.clientId,
        name: input.name,
        frequency: input.frequency,
        dayOfMonth: input.dayOfMonth,
        startDate: input.startDate,
        endDate: input.endDate,
        nextIssueDate: next,
        terms: input.terms,
        placeOfSupply: input.placeOfSupply,
        clientServiceId: input.clientServiceId,
        linesJson: input.lines as unknown as Prisma.InputJsonValue,
        autoSend: input.autoSend,
        isActive: input.isActive,
        updatedBy: session.userId,
      },
    })
    return this.get(session, scope, id)
  },

  async remove(session: Session, scope: Scope, id: string): Promise<SerializedProfile> {
    const cur = await this.get(session, scope, id)
    await prisma.recurringInvoiceProfile.update({ where: { id }, data: { deletedAt: new Date(), isActive: false, updatedBy: session.userId } })
    return cur
  },

  async runNow(session: Session, scope: Scope, id: string): Promise<RunOutcome> {
    await this.get(session, scope, id)
    return generateForProfile(id, { userId: session.userId, employeeId: session.employeeId ?? null })
  },
}
