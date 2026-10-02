import type { Prisma, PrismaClient } from '@prisma/client'

/**
 * Human-readable id allocation — 'LD-1001', 'CLI-1001' (§5.2).
 *
 * Allocated SERVER-SIDE, inside the transaction that creates the row, by
 * reading the current maximum. Never `count() + 1` outside a transaction:
 * with a soft-deleted row or two concurrent creates that reuses a code, and
 * `leadCode`/`clientCode` are @unique so the second insert would simply fail.
 *
 * Both sequences start at 1001 so the first record reads 'LD-1001', matching
 * the examples in the build prompt.
 */
type Tx = Prisma.TransactionClient | PrismaClient

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
  // Soft-deleted rows are INCLUDED deliberately — a retired code must never
  // be handed out again.
  const rows = await tx.lead.findMany({ select: { leadCode: true } })
  return nextFrom(rows.map((r) => r.leadCode), 'LD-')
}

export async function nextClientCode(tx: Tx): Promise<string> {
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
 * 'QT-2026-0001' — per-YEAR sequence, same rule as the two above: read the
 * maximum inside the creating transaction, soft-deleted rows included,
 * because `quotationCode` is @unique and a retired code must never be handed
 * out twice.
 */
export async function nextQuotationCode(tx: Tx, year: number): Promise<string> {
  const prefix = `QT-${year}-`
  const rows = await tx.quotation.findMany({
    where: { quotationCode: { startsWith: prefix } },
    select: { quotationCode: true },
  })
  let max = 0
  for (const r of rows) {
    const n = Number(r.quotationCode.slice(prefix.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}

/** 'EL-2026-0001' — per-year, allocated inside the creating transaction. */
export async function nextEngagementCode(tx: Tx, year: number): Promise<string> {
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
 * 'INV-000001' — a single FLAT sequence, deliberately not per-year.
 *
 * A GST invoice number must be unique and unbroken for the life of the
 * books. Restarting at 0001 each April — which is what the QT-YYYY-NNNN
 * shape does — would reissue numbers that already exist, so the invoice
 * sequence does not take a year at all. Six digits because the reference
 * document is already at INV-000188 and four would not hold a busy decade.
 *
 * Allocated inside the creating transaction by reading the current maximum,
 * for the reason the header gives: `count() + 1` reuses a number the moment
 * a row is soft-deleted, and `invoiceNumber` is @unique so the insert fails.
 */
export async function nextInvoiceNumber(tx: Tx): Promise<string> {
  const prefix = 'INV-'
  const rows = await tx.invoice.findMany({
    where: { invoiceNumber: { startsWith: prefix } },
    select: { invoiceNumber: true },
  })
  let max = 0
  for (const r of rows) {
    const n = Number(r.invoiceNumber.slice(prefix.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(6, '0')}`
}
