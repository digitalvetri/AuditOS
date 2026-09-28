/**
 * BOOKKEEPING · IMPORT COMMIT SERVICE (BOOKKEEPING-REBUILD §3.3-§3.5).
 *
 * The bridge between a derived batch (from Step 2's deriveVouchers) and
 * the existing posting engine. It never writes vouchers itself — every
 * NEW row goes through postVoucher(), the single writer of financial
 * state, so the "engine guarantees" listed at the top of posting.ts
 * apply to imported vouchers exactly the same way as to hand-entered
 * ones.
 *
 * Two things happen here that don't happen anywhere else:
 *
 *   1. Idempotency classification (`classifyExistence`).
 *      Every derived voucher is compared against existing vouchers for
 *      the same company + FY, keyed as:
 *        sales    → (voucherTypeCode=sales,    voucherNumber=invoice_no)
 *        purchase → (voucherTypeCode=purchase, referenceNumber=bill_no, date=<row date>, partyLedgerId=<supplier>)
 *      Result is one of: new | unchanged | changed | skip.
 *
 *   2. Party ledger auto-creation.
 *      A row whose customer/supplier still has no ledger after the
 *      operator's proposal decisions gets one under Sundry Debtors /
 *      Creditors before the voucher is posted. Fuzzy-matched proposals
 *      the operator accepted route to the existing ledger instead.
 *
 * The audit stub — one BookkeepingImportRun per commit — records
 * counts, mapping version, file SHA and the operator's decisions.
 */
import crypto from 'node:crypto'
import type { PrismaClient, Prisma } from '@prisma/client'
import { ApiError } from '../../../lib/http.js'
import { prisma as defaultPrisma } from '../../../lib/prisma.js'
import { postVoucher } from '../engine/posting.js'
import { normalizeParty } from '../engine/partyMatch.js'
import type {
  DerivedBatch,
  DerivedVoucher,
  PartyProposal,
} from '../engine/deriveVouchers.js'
import type { ImportTarget } from './BookkeepingImportService.js'

export type ExistenceStatus = 'new' | 'unchanged' | 'changed' | 'skip'

export interface VoucherClassification {
  rowNumber: number
  existence: ExistenceStatus
  /** Populated for `changed` / `unchanged` — the current voucher on record. */
  existingVoucherId?: string
  /** For `changed`: what differs. `amount` covers grandTotal, dr/cr totals. */
  changedFields?: ('amount' | 'date' | 'party')[]
}

export interface ClassifiedBatch extends DerivedBatch {
  classification: Record<number, VoucherClassification>
  counts: {
    new: number
    unchanged: number
    changed: number
    skipped: number
  }
}

/**
 * Enrich a DerivedBatch with an idempotency classification per voucher.
 * The batch is returned unchanged plus a `classification` map keyed by
 * rowNumber and a `counts` roll-up.
 */
export async function classifyExistence(
  prisma: PrismaClient,
  companyId: string,
  batch: DerivedBatch,
): Promise<ClassifiedBatch> {
  const salesRows = batch.vouchers.filter((v) => v.type === 'sales')
  const purchRows = batch.vouchers.filter((v) => v.type === 'purchase')

  // Sales key on voucherNumber (== invoice_no on the source doc). One
  // query fetches every existing sales voucher whose number is in the
  // batch, so we compare in-memory rather than N+1.
  const salesNumbers = salesRows
    .map((v) => v.invoiceOrBillNo?.trim())
    .filter((v): v is string => Boolean(v))
  const existingSales = salesNumbers.length
    ? await prisma.bookkeepingVoucher.findMany({
        where: {
          tallyCompanyId: companyId,
          voucherTypeCode: 'sales',
          voucherNumber: { in: salesNumbers },
          deletedAt: null,
        },
        select: { id: true, voucherNumber: true, grandTotalPaise: true, date: true },
      })
    : []
  const salesByNumber = new Map(existingSales.map((v) => [v.voucherNumber, v]))

  // Purchases are keyed on (referenceNumber == bill_no, date, partyLedgerId).
  // referenceNumber can be null on old rows but any imported row that
  // reaches this function had bill_no on the source doc.
  const purchBillNos = purchRows
    .map((v) => v.invoiceOrBillNo?.trim())
    .filter((v): v is string => Boolean(v))
  const existingPurch = purchBillNos.length
    ? await prisma.bookkeepingVoucher.findMany({
        where: {
          tallyCompanyId: companyId,
          voucherTypeCode: 'purchase',
          referenceNumber: { in: purchBillNos },
          deletedAt: null,
        },
        select: {
          id: true,
          referenceNumber: true,
          date: true,
          grandTotalPaise: true,
          partyLedgerId: true,
        },
      })
    : []
  const purchByKey = new Map<string, (typeof existingPurch)[number]>()
  for (const p of existingPurch) {
    const key = `${p.referenceNumber ?? ''}|${p.date}|${p.partyLedgerId ?? ''}`
    purchByKey.set(key, p)
  }

  const classification: Record<number, VoucherClassification> = {}
  let n = 0, u = 0, c = 0, s = 0
  for (const v of batch.vouchers) {
    const cls = classifyOne(v, salesByNumber, purchByKey)
    classification[v.rowNumber] = cls
    if (cls.existence === 'new') n++
    else if (cls.existence === 'unchanged') u++
    else if (cls.existence === 'changed') c++
    else s++
  }

  return { ...batch, classification, counts: { new: n, unchanged: u, changed: c, skipped: s } }
}

function classifyOne(
  v: DerivedVoucher,
  salesByNumber: Map<string, { id: string; voucherNumber: string; grandTotalPaise: number; date: string }>,
  purchByKey: Map<string, { id: string; referenceNumber: string | null; date: string; grandTotalPaise: number; partyLedgerId: string | null }>,
): VoucherClassification {
  const { rowNumber } = v
  // A row with no invoice/bill number can't be idempotency-keyed → post
  // it as new. The row-flag layer already surfaces "missing invoice_no"
  // as a warning; a re-import of the same file would double-post,
  // which is the trade for allowing incomplete rows through at all.
  const key = v.invoiceOrBillNo?.trim()
  if (!key || !v.date) {
    return { rowNumber, existence: 'new' }
  }
  // A row with an unresolved party ledger (and no proposal decision yet)
  // is "skip" here — the commit path can't post without a real ledgerId.
  // The commit endpoint may reclassify to `new` after resolving proposals.
  if (v.partyLedgerId === null) {
    return { rowNumber, existence: 'skip' }
  }

  if (v.type === 'sales') {
    const existing = salesByNumber.get(key)
    if (!existing) return { rowNumber, existence: 'new' }
    const changed: VoucherClassification['changedFields'] = []
    if (existing.grandTotalPaise !== v.totalPaise) changed.push('amount')
    if (existing.date !== isoFromMappingDate(v.date, 'DD/MM/YYYY')) changed.push('date')
    if (changed.length === 0) return { rowNumber, existence: 'unchanged', existingVoucherId: existing.id }
    return { rowNumber, existence: 'changed', existingVoucherId: existing.id, changedFields: changed }
  }

  // Purchase
  const iso = isoFromMappingDate(v.date, 'DD/MM/YYYY')
  const purchKey = `${key}|${iso}|${v.partyLedgerId}`
  const existing = purchByKey.get(purchKey)
  if (!existing) return { rowNumber, existence: 'new' }
  const changed: VoucherClassification['changedFields'] = []
  if (existing.grandTotalPaise !== v.totalPaise) changed.push('amount')
  if (existing.partyLedgerId !== v.partyLedgerId) changed.push('party')
  if (changed.length === 0) return { rowNumber, existence: 'unchanged', existingVoucherId: existing.id }
  return { rowNumber, existence: 'changed', existingVoucherId: existing.id, changedFields: changed }
}

/**
 * Convert a mapping-formatted date ("08/04/2025", "2025-04-08", …) to
 * ISO YYYY-MM-DD, which is what postVoucher expects and what the DB
 * stores. Only two formats are supported for MVP; the mapping's
 * dateFormat value drives the pick.
 */
export function isoFromMappingDate(raw: string, format: string): string {
  const s = (raw ?? '').trim()
  if (!s) throw ApiError.badRequest('Empty date cannot be posted.')
  // Fast paths first.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const dmy = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/
  const m = dmy.exec(s)
  if (m) {
    const [, d, mo, y] = m
    const dd = d.padStart(2, '0')
    const mm = mo.padStart(2, '0')
    if (format.toUpperCase().startsWith('DD')) return `${y}-${mm}-${dd}`
    // MM/DD/YYYY explicitly.
    return `${y}-${dd}-${mm}`
  }
  throw ApiError.badRequest(`Cannot parse "${s}" as a date (mapping format: ${format}).`)
}

// --- Commit ------------------------------------------------------------

export interface PartyDecision {
  /** The party name as it appeared in the file — the key for matching a proposal. */
  name: string
  /** create = new ledger; use = point at an existing ledger the operator picked. */
  action: 'create' | 'use'
  useExistingLedgerId?: string
}

export interface ChangedRowDecision {
  rowNumber: number
  /** MVP supports skip only; update = cancel + re-post is future work (§3.5). */
  action: 'skip'
}

export interface CommitInput {
  target: ImportTarget
  fileName: string
  fileSha256: string
  mappingId: string
  mappingVersion: number
  partyDecisions: PartyDecision[]
  changedRowDecisions: ChangedRowDecision[]
  batch: ClassifiedBatch
}

export interface CommitResult {
  runId: string
  vouchersCreated: number
  vouchersSkipped: number
  vouchersUpdated: number
  ledgersCreated: number
  totalPaise: number
  errors: { rowNumber: number; message: string }[]
}

/**
 * Actually write. Everything that touches the ledger goes through
 * postVoucher(), which enforces balance + FY + isolation + uniqueness
 * in its own transaction.
 *
 * Party ledgers are created OUTSIDE the postVoucher transaction so a
 * later row's posting failure doesn't roll back party creations from
 * earlier rows; the alternative — one giant transaction — makes the
 * "commit half the batch on partial failure" trade impossible.
 */
export async function commitBatch(
  companyId: string,
  input: CommitInput,
  actorUserId: string | null,
  prisma: PrismaClient = defaultPrisma,
): Promise<CommitResult> {
  const errors: { rowNumber: number; message: string }[] = []
  let vouchersCreated = 0
  let vouchersSkipped = 0
  const vouchersUpdated = 0 // reserved for future §3.5 update path
  let ledgersCreated = 0
  let totalPaise = 0

  // Resolve party decisions to a name → ledgerId map. Auto-create any
  // proposal that has no decision but that the batch flagged as new.
  const partyLedgerByName = new Map<string, string>()
  const decisionByName = new Map(
    input.partyDecisions.map((d) => [normalizeParty(d.name), d]),
  )
  for (const proposal of input.batch.proposals) {
    const key = normalizeParty(proposal.name)
    const decision = decisionByName.get(key)
    if (decision?.action === 'use' && decision.useExistingLedgerId) {
      partyLedgerByName.set(key, decision.useExistingLedgerId)
      continue
    }
    const groupName = proposal.group === 'sundry_debtors' ? 'Sundry Debtors' : 'Sundry Creditors'
    try {
      const ledgerId = await createPartyLedger(prisma, companyId, proposal.name, groupName, actorUserId)
      partyLedgerByName.set(key, ledgerId)
      ledgersCreated++
    } catch (e) {
      errors.push({ rowNumber: -1, message: `Party "${proposal.name}": ${(e as Error).message}` })
    }
  }

  const changedByRow = new Map(input.changedRowDecisions.map((d) => [d.rowNumber, d]))

  for (const voucher of input.batch.vouchers) {
    const cls = input.batch.classification[voucher.rowNumber]
    if (!cls) {
      errors.push({ rowNumber: voucher.rowNumber, message: 'Missing classification.' })
      continue
    }
    if (cls.existence === 'unchanged') {
      vouchersSkipped++
      continue
    }
    if (cls.existence === 'changed') {
      // MVP: CHANGED rows are ALWAYS skipped unless a decision says
      // otherwise, and the decision set only supports 'skip' — so this
      // is effectively always skip until §3.5 lands the update path.
      const decision = changedByRow.get(voucher.rowNumber)
      if (!decision || decision.action === 'skip') {
        vouchersSkipped++
        continue
      }
    }
    if (cls.existence === 'skip') {
      vouchersSkipped++
      continue
    }

    // NEW — resolve the party ledger before posting.
    let partyLedgerId = voucher.partyLedgerId
    if (!partyLedgerId) {
      const key = normalizeParty(voucher.partyName)
      partyLedgerId = partyLedgerByName.get(key) ?? null
    }
    if (!partyLedgerId) {
      errors.push({ rowNumber: voucher.rowNumber, message: `No ledger resolved for party "${voucher.partyName}".` })
      continue
    }

    try {
      const dateIso = isoFromMappingDate(voucher.date ?? '', 'DD/MM/YYYY')
      await postVoucher(
        companyId,
        {
          voucherTypeCode: voucher.type,
          date: dateIso,
          voucherNumber: voucher.invoiceOrBillNo ?? undefined,
          referenceNumber: voucher.invoiceOrBillNo,
          partyLedgerId,
          narration: `Imported from ${input.fileName}`,
          entries: voucher.entries.map((e) => ({
            ledgerId: e.role === 'party'
              ? partyLedgerId!
              : (e.ledgerId ?? ''),
            entryType: e.side,
            amountPaise: e.amountPaise,
          })),
        },
        actorUserId,
      )
      vouchersCreated++
      totalPaise += voucher.totalPaise
    } catch (e) {
      errors.push({ rowNumber: voucher.rowNumber, message: (e as Error).message })
    }
  }

  const run = await prisma.bookkeepingImportRun.create({
    data: {
      tallyCompanyId: companyId,
      target: input.target,
      fileName: input.fileName,
      fileSha256: input.fileSha256,
      mappingId: input.mappingId,
      mappingVersion: input.mappingVersion,
      rowsScanned: input.batch.totals.rowsScanned,
      rowsDerived: input.batch.totals.rowsDerived,
      vouchersCreated,
      vouchersSkipped,
      vouchersUpdated,
      ledgersCreated,
      totalPaise,
      currenciesJson: input.batch.totals.currencies as Prisma.InputJsonValue,
      summaryJson: {
        counts: input.batch.counts,
        flagCount: input.batch.flags.length,
        errorCount: errors.length,
        errors: errors.slice(0, 20),
      } as Prisma.InputJsonValue,
      createdByUserId: actorUserId,
    },
    select: { id: true },
  })

  return { runId: run.id, vouchersCreated, vouchersSkipped, vouchersUpdated, ledgersCreated, totalPaise, errors }
}

async function createPartyLedger(
  prisma: PrismaClient,
  companyId: string,
  name: string,
  groupName: string,
  actorUserId: string | null,
): Promise<string> {
  const group = await prisma.bookkeepingGroup.findFirst({
    where: { tallyCompanyId: companyId, name: groupName },
    select: { id: true },
  })
  if (!group) throw new Error(`Primary group "${groupName}" is missing on this company.`)
  // BookkeepingLedger has no created/updated-by columns. `actorUserId`
  // is threaded through so we can wire it into an audit row later
  // without changing the signature.
  void actorUserId
  const created = await prisma.bookkeepingLedger.create({
    data: {
      tallyCompanyId: companyId,
      groupId: group.id,
      name: name.trim(),
    },
    select: { id: true },
  })
  return created.id
}

export function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}
