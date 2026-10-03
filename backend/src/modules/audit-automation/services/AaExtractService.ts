import crypto from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../../lib/prisma.js'
import { aaStorage } from '../storage.js'
import type { ExtractedPage } from '../lib/pdfInspect.js'
import { parseStatementPdf, parseStatementTable, type ParsedTxn, type ParseResult } from '../lib/statementParser.js'
import { AaRuleService, type RuleRow } from './AaRuleService.js'
import { notifyUser } from '../../../platform/notify.js'

/**
 * Statement → AaBankTxn rows. Replaces the old stub extractor.
 *
 * Runs after the upload response (setImmediate), and again for any job a
 * restart left queued or extracting (recoverStuck, called at boot), so a
 * job never sits at "queued" forever.
 *
 * Steps: read the stored extraction → parse the table → balance chain
 * (in the parser) → period check against the chosen FY → per-client
 * duplicates → ledger rules → save rows and statement facts in ONE
 * transaction (a failure leaves no half-written job).
 */

/** Flags that need a person to look at the row before it can go to Tally. */
const REVIEW_FLAGS = new Set(['BALANCE_BREAK', 'NO_AMOUNT', 'BOTH_AMOUNTS', 'AUTO_SWAPPED', 'DATE_ORDER', 'OUT_OF_PERIOD'])

const normNarration = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

/** Same account, date, amounts, balance and narration → the same transaction. */
export function fingerprintOf(bankAccountId: string, t: Pick<ParsedTxn, 'txnDate' | 'debitPaise' | 'creditPaise' | 'balancePaise' | 'narration'>): string {
  return crypto.createHash('sha256')
    .update([bankAccountId, t.txnDate, t.debitPaise, t.creditPaise, t.balancePaise ?? '', normNarration(t.narration)].join('|'))
    .digest('hex')
}

/** Tell the uploader the background extraction finished. Best effort. */
async function notifyJobOwner(job: { id: string; createdByUserId: string; sourceDocument: { originalFilename: string } }, failed: boolean, detail: string) {
  try {
    await notifyUser({
      userId: job.createdByUserId,
      type: failed ? 'aa.bank_extraction_failed' : 'aa.bank_extracted', module: 'system',
      title: failed ? 'Statement extraction failed' : 'Statement extracted',
      body: `${job.sourceDocument.originalFilename} · ${detail}`,
      entityType: 'AaJob', entityId: job.id,
      actionUrl: `/audit-automation/bank/jobs/${job.id}`,
    })
  } catch { /* best effort */ }
}

/** "2026-27" → [2026-04-01, 2027-03-31]. */
function fyBounds(fy: string | null): [string, string] | null {
  const m = fy?.match(/^(\d{4})-(\d{2})$/)
  if (!m) return null
  const y = Number(m[1])
  return [`${y}-04-01`, `${y + 1}-03-31`]
}

export const AaExtractService = {
  /** Fire-and-forget after upload. */
  schedule(jobId: string): void {
    setImmediate(() => { void AaExtractService.run(jobId) })
  },

  async parse(extraction: { pages?: ExtractedPage[]; table?: string[][] }): Promise<ParseResult> {
    if (extraction.table) return parseStatementTable(extraction.table)
    return parseStatementPdf(extraction.pages ?? [])
  },

  async run(jobId: string): Promise<void> {
    const job = await prisma.aaJob.findUnique({ where: { id: jobId }, include: { sourceDocument: true } })
    if (!job || job.status === 'extracted') return
    await prisma.aaJob.update({ where: { id: jobId }, data: { status: 'extracting', progress: 10, startedAt: new Date(), errorMessage: null } })
    try {
      const blob = await aaStorage.get(job.sourceDocument.extractionPath)
      const parsed = await AaExtractService.parse(JSON.parse(blob.toString('utf8')))
      if (parsed.warnings.includes('NO_HEADER') || parsed.rows.length === 0) {
        throw new Error(parsed.warnings.includes('NO_HEADER')
          ? "Couldn't find the transaction table (no header with Date, Narration and Debit/Credit or Balance columns)."
          : 'The statement table has no transactions.')
      }
      await prisma.aaJob.update({ where: { id: jobId }, data: { progress: 60 } })

      const period = fyBounds(job.fy)
      const rules = await AaRuleService.forClient(job.organisationId, job.clientId)
      const accountId = job.sourceDocument.bankAccountId

      // Duplicates: the same transaction already stored for this client under another job.
      const fps = parsed.rows.map((r) => fingerprintOf(accountId, r))
      const seen = await prisma.aaBankTxn.findMany({
        where: { clientId: job.clientId, fingerprint: { in: fps }, jobId: { not: jobId }, status: { not: 'duplicate' }, job: { sourceDocument: { deletedAt: null } } },
        select: { id: true, fingerprint: true },
      })
      const firstSeen = new Map(seen.map((s) => [s.fingerprint, s.id]))
      const inThisFile = new Set<string>()

      const data: Prisma.AaBankTxnCreateManyInput[] = parsed.rows.map((r, i) => {
        const flags = [...r.flags]
        if (period && (r.txnDate < period[0] || r.txnDate > period[1])) flags.push('OUT_OF_PERIOD')
        const fp = fps[i]
        const dupOf = firstSeen.get(fp) ?? null
        // Two genuinely identical lines in one statement (same balance too) are rare but real — keep both.
        const repeated = inThisFile.has(fp)
        inThisFile.add(fp)
        const status = dupOf && !repeated ? 'duplicate' : flags.some((f) => REVIEW_FLAGS.has(f)) ? 'flagged' : 'ok'
        const rule: RuleRow | null = AaRuleService.match(rules, r.narration, r.debitPaise > 0n ? 'withdrawal' : 'deposit')
        return {
          jobId, organisationId: job.organisationId, clientId: job.clientId, bankAccountId: accountId,
          seq: r.seq, page: r.page, txnDate: r.txnDate, valueDate: r.valueDate,
          narration: r.narration.slice(0, 1000), reference: r.reference?.slice(0, 120) ?? null,
          debitPaise: r.debitPaise, creditPaise: r.creditPaise, balancePaise: r.balancePaise,
          fingerprint: fp, status, flags: flags.join(','), duplicateOfId: status === 'duplicate' ? dupOf : null,
          ledgerName: rule?.ledgerName ?? null, voucherType: rule?.voucherType ?? null, matchedRuleId: rule?.id ?? null,
          original: {
            txn_date: r.txnDate, value_date: r.valueDate, narration: r.narration, reference: r.reference,
            debit_paise: r.debitPaise.toString(), credit_paise: r.creditPaise.toString(),
            balance_paise: r.balancePaise?.toString() ?? null, flags: r.flags,
          },
        }
      })

      const flagged = data.filter((d) => d.status === 'flagged').length
      const dups = data.filter((d) => d.status === 'duplicate').length
      const jobFlags = new Set(job.flags ? job.flags.split(',').filter(Boolean) : [])
      for (const w of parsed.warnings) jobFlags.add(w)
      if (data.some((d) => String(d.flags).includes('BALANCE_BREAK'))) jobFlags.add('BALANCE_BREAKS')
      if (dups) jobFlags.add('DUPLICATE_ROWS')
      const meta = { ...(job.metaJson ? JSON.parse(job.metaJson) as object : {}), columns: parsed.columns, rows: data.length, flagged_rows: flagged, duplicate_rows: dups }

      await prisma.$transaction([
        prisma.aaBankTxn.deleteMany({ where: { jobId } }),
        prisma.aaBankTxn.createMany({ data }),
        prisma.aaJob.update({
          where: { id: jobId },
          data: {
            status: 'extracted', progress: 100, completedAt: new Date(), rowCount: data.length,
            periodFrom: parsed.periodFrom, periodTo: parsed.periodTo,
            openingBalancePaise: parsed.openingBalancePaise, closingBalancePaise: parsed.closingBalancePaise,
            flags: [...jobFlags].join(','), metaJson: JSON.stringify(meta), reviewStatus: 'pending',
          },
        }),
      ])
      await notifyJobOwner(job, false, `${data.length} transaction${data.length === 1 ? '' : 's'}${flagged ? `, ${flagged} flagged for review` : ''}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Extraction failed.'
      const saved = await prisma.aaJob.update({ where: { id: jobId }, data: { status: 'failed', progress: 100, errorMessage: msg.slice(0, 500), completedAt: new Date() } }).then(() => true, () => false)
      if (saved) await notifyJobOwner(job, true, msg.slice(0, 160))
    }
  },

  /** Boot: finish any job a restart interrupted. */
  async recoverStuck(): Promise<void> {
    const stuck = await prisma.aaJob.findMany({ where: { status: { in: ['queued', 'extracting'] } }, select: { id: true } })
    for (const j of stuck) await AaExtractService.run(j.id)
  },
}
