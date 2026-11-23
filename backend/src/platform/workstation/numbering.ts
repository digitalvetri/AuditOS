import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { lockSequence } from '../../lib/sequence.js'

/**
 * INVOICE AND QUOTATION NUMBERS — set by an Admin in Settings.
 *
 * A series is a PREFIX + a zero-padded NUMBER. The prefix may carry
 *   {YYYY}  the document's calendar year   (2026)
 *   {FY}    its financial year, April–March (2026-27)
 *   {FY2}   the same, short                  (26-27)
 * so a prefix with a year in it starts a fresh series each year, and one
 * without (INV-) runs on for the life of the books.
 *
 * START is the number to continue from — a firm moving in with 160 invoices
 * already raised elsewhere sets it to 161. It applies only to the series it
 * was set for (`start_prefix`, the prefix as resolved on that day): when a
 * {FY} prefix rolls into a new year, that year begins at 1 again.
 *
 * The next number is max(highest already issued in the series, start − 1) + 1,
 * read under the series' advisory lock inside the issuing transaction, so it
 * is gapless and never repeats (soft-deleted rows count: a number once given
 * is never given again).
 *
 * With no settings saved this reproduces the original series exactly:
 * INV-000001 (flat) and QT-YYYY-0001 (per year).
 */
export type SeriesKind = 'invoice' | 'quotation'

export interface SeriesConfig {
  prefix: string
  digits: number
  /** The number to continue from in `start_prefix`'s series; null = from 1. */
  start: number | null
  start_prefix: string | null
}

export const SERIES_DEFAULTS: Record<SeriesKind, SeriesConfig> = {
  invoice: { prefix: 'INV-', digits: 6, start: null, start_prefix: null },
  quotation: { prefix: 'QT-{YYYY}-', digits: 4, start: null, start_prefix: null },
}

type Db = Prisma.TransactionClient | typeof prisma

/** The financial year (April–March) a YYYY-MM-DD date falls in. */
export function fyOf(date: string): { start: number; end: number } {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  const start = m >= 4 ? y : y - 1
  return { start, end: start + 1 }
}

/** The prefix pattern with its year tokens filled in for `date`. */
export function resolvePrefix(pattern: string, date: string): string {
  const fy = fyOf(date)
  return pattern
    .replaceAll('{YYYY}', date.slice(0, 4))
    .replaceAll('{FY}', `${fy.start}-${String(fy.end).slice(2)}`)
    .replaceAll('{FY2}', `${String(fy.start).slice(2)}-${String(fy.end).slice(2)}`)
}

export async function seriesConfig(db: Db, kind: SeriesKind): Promise<SeriesConfig> {
  // The same firm record Settings writes to (invoice/supply.ts firmOrgId).
  const org = await db.organisation.findFirst({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { numberingConfig: true } })
  const raw = (org?.numberingConfig ?? {}) as Partial<Record<SeriesKind, Partial<SeriesConfig>>>
  const saved = raw[kind] ?? {}
  const d = SERIES_DEFAULTS[kind]
  return {
    prefix: typeof saved.prefix === 'string' && saved.prefix ? saved.prefix : d.prefix,
    digits: Number.isInteger(saved.digits) && saved.digits! >= 1 && saved.digits! <= 10 ? saved.digits! : d.digits,
    start: Number.isInteger(saved.start) && saved.start! >= 1 ? saved.start! : null,
    start_prefix: typeof saved.start_prefix === 'string' ? saved.start_prefix : null,
  }
}

/** Every number already in the series `prefix` (soft-deleted rows included). */
async function issuedIn(db: Db, kind: SeriesKind, prefix: string): Promise<string[]> {
  if (kind === 'invoice') {
    const rows = await db.invoice.findMany({ where: { invoiceNumber: { startsWith: prefix } }, select: { invoiceNumber: true } })
    return rows.map((r) => r.invoiceNumber ?? '')
  }
  const rows = await db.quotation.findMany({ where: { quotationCode: { startsWith: prefix } }, select: { quotationCode: true } })
  return rows.map((r) => r.quotationCode)
}

/** The highest number issued in `prefix`'s series; 0 when none. Codes whose tail is not a plain number belong to another series. */
export async function highestIssued(db: Db, kind: SeriesKind, prefix: string): Promise<number> {
  let max = 0
  for (const c of await issuedIn(db, kind, prefix)) {
    const tail = c.slice(prefix.length)
    if (!/^\d+$/.test(tail)) continue
    const n = Number(tail)
    if (n > max) max = n
  }
  return max
}

function format(prefix: string, n: number, digits: number): string {
  return `${prefix}${String(n).padStart(digits, '0')}`
}

/** What the next number would be on `date`, without taking it. */
export async function peekNext(db: Db, kind: SeriesKind, date: string, cfg?: SeriesConfig): Promise<string> {
  const c = cfg ?? await seriesConfig(db, kind)
  const prefix = resolvePrefix(c.prefix, date)
  let last = await highestIssued(db, kind, prefix)
  if (c.start && c.start_prefix === prefix) last = Math.max(last, c.start - 1)
  return format(prefix, last + 1, c.digits)
}

/**
 * Take the next number. Call inside the issuing transaction (the lock is
 * transaction-scoped), with `tx`.
 */
export async function takeNext(tx: Prisma.TransactionClient, kind: SeriesKind, date: string): Promise<string> {
  const cfg = await seriesConfig(tx, kind)
  const prefix = resolvePrefix(cfg.prefix, date)
  await lockSequence(tx, `series:${kind}:${prefix}`)
  return peekNext(tx, kind, date, cfg)
}
