import type { Prisma } from '@prisma/client'
import { lockSequence } from '../../lib/sequence.js'
import { takeNext } from './numbering.js'

/**
 * Human-readable id allocation — 'LD-1001', 'CLI-1001' (§5.2).
 *
 * Allocated SERVER-SIDE, inside the transaction that creates the row, by
 * reading the current maximum. Never `count() + 1` outside a transaction:
 * with a soft-deleted row or two concurrent creates that reuses a code, and
 * `leadCode`/`clientCode` are @unique so the second insert would simply fail.
 *
 * Being inside a transaction is not enough on its own — under READ
 * COMMITTED two creates still read the same maximum. Every allocator here
 * first takes a per-sequence advisory lock (lib/sequence.ts), so a second
 * create waits for the first to commit and then sees its code. That is
 * also why `tx` must be a transaction client.
 *
 * Both sequences start at 1001 so the first record reads 'LD-1001', matching
 * the examples in the build prompt.
 */
type Tx = Prisma.TransactionClient

const START = 1001

function nextFrom(codes: string[], prefix: string): string {
  let max = START - 1
  for (const c of codes) {
    const n = Number(c.slice(prefix.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${max + 1}`
}

export async function nextLeadCode(tx: Tx): Promise<string> {
  await lockSequence(tx, 'code:LD')
  // Soft-deleted rows are INCLUDED deliberately — a retired code must never
  // be handed out again.
  const rows = await tx.lead.findMany({ select: { leadCode: true } })
  return nextFrom(rows.map((r) => r.leadCode), 'LD-')
}

export async function nextClientCode(tx: Tx): Promise<string> {
  await lockSequence(tx, 'code:CLI')
  const rows = await tx.client.findMany({ select: { clientCode: true } })
  return nextFrom(rows.map((r) => r.clientCode), 'CLI-')
}

/**
 * 'INC-2026-0001' — per-YEAR sequence, so a case code carries the year it was
 * opened. Same rule as the two above: read the maximum inside the creating
 * transaction, soft-deleted rows included, because a retired code must never
 * be handed out twice and `caseCode` is @unique.
 */
export async function nextIncorporationCaseCode(tx: Tx, year: number): Promise<string> {
  await lockSequence(tx, `code:INC-${year}`)
  const prefix = `INC-${year}-`
  const rows = await tx.incorporationCase.findMany({
    where: { caseCode: { startsWith: prefix } },
    select: { caseCode: true },
  })
  let max = 0
  for (const r of rows) {
    const n = Number(r.caseCode.slice(prefix.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}

/**
 * 'REG-2026-0001' — per-YEAR sequence, same rule as the incorporation case
 * code above: read the maximum inside the creating transaction, soft-deleted
 * rows included, because `registrationCode` is @unique and a retired code
 * must never be handed out twice.
 */
export async function nextRegistrationCode(tx: Tx, year: number): Promise<string> {
  await lockSequence(tx, `code:REG-${year}`)
  const prefix = `REG-${year}-`
  const rows = await tx.clientRegistration.findMany({
    where: { registrationCode: { startsWith: prefix } },
    select: { registrationCode: true },
  })
  let max = 0
  for (const r of rows) {
    const n = Number(r.registrationCode.slice(prefix.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}

/**
 * The quotation number — 'QT-2026-0001' unless an Admin set another series
 * in Settings (platform/workstation/numbering.ts). Allocated inside the
 * creating transaction under the series lock. Pass the quotation's date so a
 * {FY} prefix lands in the right year; the year alone is the fallback.
 */
export async function nextQuotationCode(tx: Tx, year: number, date?: string): Promise<string> {
  return takeNext(tx, 'quotation', date ?? `${year}-06-01`)
}

/** 'EL-2026-0001' — per-year, allocated inside the creating transaction. */
export async function nextEngagementCode(tx: Tx, year: number): Promise<string> {
  await lockSequence(tx, `code:EL-${year}`)
  const prefix = `EL-${year}-`
  const rows = await tx.engagementLetter.findMany({
    where: { letterCode: { startsWith: prefix } },
    select: { letterCode: true },
  })
  let max = 0
  for (const r of rows) {
    const n = Number(r.letterCode.slice(prefix.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}

/** 'DOC-2026-0001' — per-year, allocated inside the creating transaction. */
export async function nextWorkstationDocCode(tx: Tx, year: number): Promise<string> {
  await lockSequence(tx, `code:DOC-${year}`)
  const prefix = `DOC-${year}-`
  const rows = await tx.workstationDoc.findMany({
    where: { docCode: { startsWith: prefix } },
    select: { docCode: true },
  })
  let max = 0
  for (const r of rows) {
    const n = Number(r.docCode.slice(prefix.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}

/**
 * The invoice number — 'INV-000001', a single flat series, unless an Admin
 * set another in Settings (platform/workstation/numbering.ts): a different
 * prefix, a {FY} prefix, or a number to continue from (a firm moving in with
 * 160 invoices already raised sets 161).
 *
 * Allocated when the invoice is SENT (drafts carry no number), inside that
 * transaction under the series lock, from the highest number already in the
 * series — soft-deleted rows included, because `invoiceNumber` is @unique
 * and an older deleted draft may still hold one.
 */
export async function nextInvoiceNumber(tx: Tx, invoiceDate: string): Promise<string> {
  return takeNext(tx, 'invoice', invoiceDate)
}

/** 'AUD-2026-0001' — audit files, per-year, allocated inside the creating transaction. */
export async function nextAuditCode(tx: Tx, year: number): Promise<string> {
  await lockSequence(tx, `code:AUD-${year}`)
  const prefix = `AUD-${year}-`
  const rows = await tx.auditEngagement.findMany({
    where: { auditCode: { startsWith: prefix } },
    select: { auditCode: true },
  })
  let max = 0
  for (const r of rows) {
    const n = Number(r.auditCode.slice(prefix.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}

/**
 * 'RCT-000001' — payment receipts. A single FLAT sequence like the invoice
 * number, taken when the payment is recorded (inside that transaction).
 *
 * Before receipt numbers were stored, a receipt's number was DERIVED from the
 * row's position among all payments (oldest first, removed rows included) and
 * printed that way. The backfill (backfillReceiptNumbers) gives every
 * unnumbered row exactly that derived number, so receipts already handed out
 * keep their numbers. To make sure a new allocation can never collide with a
 * position still waiting to be backfilled, the next number is at least one
 * more than the total row count (soft-deleted rows included) — every
 * unbackfilled row is older, so its position is at most that count.
 *
 * Take this lock LAST, right before the insert (after any `invoice:<id>` lock).
 */
export async function nextReceiptNumber(tx: Tx): Promise<string> {
  await lockSequence(tx, 'code:RCT')
  const prefix = 'RCT-'
  const [rows, total] = await Promise.all([
    tx.invoicePayment.findMany({ where: { receiptNumber: { startsWith: prefix } }, select: { receiptNumber: true } }),
    tx.invoicePayment.count(),
  ])
  let max = total
  for (const r of rows) {
    const n = Number((r.receiptNumber ?? '').slice(prefix.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(6, '0')}`
}

/**
 * 'RFD-000001' — the refund voucher series. Flat and gapless like receipts:
 * the maximum over EVERY refund row (removed ones included — a voucher number
 * that was handed out is never handed out again), under its own lock so two
 * refunds recorded at once cannot share a number (InvoiceRefund.refundNumber
 * is @unique).
 *
 * Take this lock LAST, right before the insert (after the `invoice:<id>` lock).
 */
export async function nextRefundNumber(tx: Tx): Promise<string> {
  await lockSequence(tx, 'code:RFD')
  const prefix = 'RFD-'
  const rows = await tx.invoiceRefund.findMany({ where: { refundNumber: { startsWith: prefix } }, select: { refundNumber: true } })
  let max = 0
  for (const r of rows) {
    const n = Number((r.refundNumber ?? '').slice(prefix.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(6, '0')}`
}
