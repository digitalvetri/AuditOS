import crypto from 'node:crypto'
import type { Request } from 'express'
import ExcelJS from 'exceljs'
import { prisma } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import { writeAudit } from '../../../platform/audit.js'
import { isSoleActiveEmployee } from '../../../platform/makerChecker.js'
import type { Session } from '../../../platform/auth.js'
import { formatVouchersXml } from '../../tally-export/xml.js'
import type { PreviewRow, VoucherType } from '../../tally-export/types.js'
import { parseStatementDate, parseMoney } from '../lib/statementParser.js'
import { AaJobService } from './AaJobService.js'
import { AaRuleService, classifyVoucherType, defaultVoucherType, VOUCHER_TYPES } from './AaRuleService.js'
import { fingerprintOf } from './AaExtractService.js'

/**
 * Review, edit, approve and export a job's bank transactions.
 *
 * Every edit keeps `original` (what was read) and re-runs the checks over
 * the whole statement, so fixing one amount clears — or raises — the
 * balance flags on every row after it. A flagged row is resolved by
 * fixing it, excluding it, or accepting it as-is (ACCEPTED). Approval
 * needs no open flags and a ledger on every row going to Tally; the
 * Tally export needs approval.
 */

/**
 * Any flag in this set drives status → 'flagged'. NO_LEDGER was added
 * per REPOTIC-MODULE.md §1 — the dashboard was reading rows with no
 * ledger assigned as "OK" while the header counted them as "without a
 * ledger", so staff learned to ignore both.
 */
const REVIEW_FLAGS = ['BALANCE_BREAK', 'NO_AMOUNT', 'BOTH_AMOUNTS', 'AUTO_SWAPPED', 'DATE_ORDER', 'OUT_OF_PERIOD', 'NO_LEDGER']
type Txn = Awaited<ReturnType<typeof prisma.aaBankTxn.findMany>>[number]

const csv = (s: string) => (s ? s.split(',').filter(Boolean) : [])
const n = (b: bigint | null) => (b === null ? null : Number(b))

export function txnToApi(t: Txn) {
  return {
    id: t.id, seq: t.seq, page: t.page, txn_date: t.txnDate, value_date: t.valueDate,
    narration: t.narration, reference: t.reference,
    debit_paise: n(t.debitPaise), credit_paise: n(t.creditPaise), balance_paise: n(t.balancePaise),
    status: t.status, flags: csv(t.flags), duplicate_of_id: t.duplicateOfId,
    ledger_name: t.ledgerName, voucher_type: t.voucherType, matched_rule_id: t.matchedRuleId,
    edited: Boolean(t.editedAt), edited_at: t.editedAt?.toISOString() ?? null, original: t.original,
  }
}

function fyBounds(fy: string | null): [string, string] | null {
  const m = fy?.match(/^(\d{4})-(\d{2})$/)
  return m ? [`${m[1]}-04-01`, `${Number(m[1]) + 1}-03-31`] : null
}

/** Recompute every row's check flags from its current values. */
async function recheck(jobId: string): Promise<void> {
  const job = await prisma.aaJob.findUniqueOrThrow({ where: { id: jobId } })
  const rows = await prisma.aaBankTxn.findMany({ where: { jobId }, orderBy: { seq: 'asc' } })
  const period = fyBounds(job.fy)
  let prev: Txn | null = null
  const updates: { id: string; flags: string; status: string }[] = []
  for (const r of rows) {
    const keep = csv(r.flags).filter((f) => !REVIEW_FLAGS.includes(f) || (f === 'AUTO_SWAPPED' && !r.editedAt))
    const flags = new Set(keep)
    if (r.status !== 'excluded' && r.status !== 'duplicate') {
      if (r.debitPaise === 0n && r.creditPaise === 0n) flags.add('NO_AMOUNT')
      if (r.debitPaise > 0n && r.creditPaise > 0n) flags.add('BOTH_AMOUNTS')
      if (period && (r.txnDate < period[0] || r.txnDate > period[1])) flags.add('OUT_OF_PERIOD')
      if (!r.ledgerName || !r.ledgerName.trim()) flags.add('NO_LEDGER')
      if (prev) {
        if (r.txnDate < prev.txnDate) flags.add('DATE_ORDER')
        if (prev.balancePaise !== null && r.balancePaise !== null) {
          const d = prev.balancePaise - r.debitPaise + r.creditPaise - r.balancePaise
          if (d > 1n || d < -1n) flags.add('BALANCE_BREAK')
        }
      }
      prev = r
    }
    const open = [...flags].some((f) => REVIEW_FLAGS.includes(f)) && !flags.has('ACCEPTED')
    const status = r.status === 'excluded' || r.status === 'duplicate' ? r.status : open ? 'flagged' : 'ok'
    const joined = [...flags].join(',')
    if (joined !== r.flags || status !== r.status) updates.push({ id: r.id, flags: joined, status })
  }
  for (const u of updates) await prisma.aaBankTxn.update({ where: { id: u.id }, data: { flags: u.flags, status: u.status } })
}

async function jobFor(session: Session, jobId: string) {
  const api = await AaJobService.get(session, jobId)
  const job = await prisma.aaJob.findUniqueOrThrow({ where: { id: api.id }, include: { sourceDocument: { include: { bank: true, bankAccount: true } } } })
  if (job.sourceDocument.deletedAt) throw ApiError.notFound('No such job.')
  return job
}

async function rowFor(session: Session, rowId: string) {
  const row = await prisma.aaBankTxn.findUnique({ where: { id: rowId } })
  if (!row) throw ApiError.notFound('No such transaction.')
  const job = await jobFor(session, row.jobId) // same scope as reading the job
  return { row, job }
}

export const AaTxnService = {
  async list(session: Session, jobId: string, q: { status?: string; search?: string; limit?: number; offset?: number }) {
    const job = await jobFor(session, jobId)
    const where = {
      jobId: job.id,
      ...(q.status && q.status !== 'all' ? { status: q.status } : {}),
      ...(q.search ? { OR: [{ narration: { contains: q.search, mode: 'insensitive' as const } }, { reference: { contains: q.search, mode: 'insensitive' as const } }, { ledgerName: { contains: q.search, mode: 'insensitive' as const } }] } : {}),
    }
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500)
    const offset = Math.max(q.offset ?? 0, 0)
    const [items, total, byStatus] = await Promise.all([
      prisma.aaBankTxn.findMany({ where, orderBy: { seq: 'asc' }, take: limit, skip: offset }),
      prisma.aaBankTxn.count({ where }),
      prisma.aaBankTxn.groupBy({ by: ['status'], where: { jobId: job.id }, _count: { _all: true } }),
    ])
    const counts = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all]))
    const missingLedger = await prisma.aaBankTxn.count({ where: { jobId: job.id, status: { in: ['ok', 'flagged'] }, ledgerName: null } })
    return { items: items.map(txnToApi), total, limit, offset, counts, missing_ledger: missingLedger }
  },

  async update(session: Session, rowId: string, body: Record<string, unknown>, req?: Request) {
    const { row, job } = await rowFor(session, rowId)
    if (job.reviewStatus === 'approved') throw ApiError.conflict('job_approved', 'This statement is approved. Reopen it to make changes.')
    const data: Record<string, unknown> = {}
    const txt = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : undefined)
    const money = (k: string) => {
      if (body[k] === undefined) return undefined
      if (body[k] === null || body[k] === '') return 0n
      const v = typeof body[k] === 'number' ? BigInt(Math.round(body[k] as number)) : parseMoney(String(body[k]))
      if (v === null || v < 0n) throw ApiError.badRequest(`${k} must be an amount in paise, 0 or more.`)
      return v
    }
    if (txt('txn_date') !== undefined) { const d = parseStatementDate(txt('txn_date')!); if (!d) throw ApiError.badRequest('txn_date is not a date.'); data.txnDate = d }
    if (body.value_date !== undefined) data.valueDate = body.value_date ? parseStatementDate(String(body.value_date)) : null
    if (txt('narration') !== undefined) data.narration = txt('narration')!.slice(0, 1000)
    if (body.reference !== undefined) data.reference = txt('reference') || null
    const debit = money('debit_paise'); if (debit !== undefined) data.debitPaise = debit
    const credit = money('credit_paise'); if (credit !== undefined) data.creditPaise = credit
    if (body.balance_paise !== undefined) {
      if (body.balance_paise === null || body.balance_paise === '') data.balancePaise = null
      else { const b = typeof body.balance_paise === 'number' ? BigInt(Math.round(body.balance_paise)) : parseMoney(String(body.balance_paise), true); if (b === null) throw ApiError.badRequest('balance_paise is not an amount.'); data.balancePaise = b }
    }
    if (body.ledger_name !== undefined) data.ledgerName = txt('ledger_name') ? txt('ledger_name')!.slice(0, 120) : null
    if (body.voucher_type !== undefined) {
      const v = body.voucher_type === null || body.voucher_type === '' ? null : String(body.voucher_type)
      if (v !== null && !(VOUCHER_TYPES as readonly string[]).includes(v)) throw ApiError.badRequest('voucher_type is payment, receipt, contra or journal.')
      data.voucherType = v
    }
    let flags = csv(row.flags)
    if (body.action !== undefined) {
      const a = String(body.action)
      if (a === 'exclude') data.status = 'excluded'
      else if (a === 'include') { data.status = 'ok'; if (row.status === 'duplicate') data.duplicateOfId = null }
      else if (a === 'accept') { flags = [...new Set([...flags, 'ACCEPTED'])]; data.flags = flags.join(',') }
      else if (a === 'unaccept') { flags = flags.filter((f) => f !== 'ACCEPTED'); data.flags = flags.join(',') }
      else throw ApiError.badRequest('action is exclude, include, accept or unaccept.')
    }
    const touchedValues = ['txnDate', 'valueDate', 'narration', 'reference', 'debitPaise', 'creditPaise', 'balancePaise'].some((k) => k in data)
    if (touchedValues) { data.editedByUserId = session.userId; data.editedAt = new Date() }
    const updated = await prisma.aaBankTxn.update({ where: { id: row.id }, data })
    if (touchedValues) {
      await prisma.aaBankTxn.update({ where: { id: row.id }, data: { fingerprint: fingerprintOf(row.bankAccountId, updated) } })
    }
    await recheck(job.id)
    await writeAudit({
      actorUserId: session.userId, action: 'aa.bank.row_edited', entityType: 'AaBankTxn', entityId: row.id,
      before: { ...txnToApi(row), original: undefined }, after: { ...txnToApi(updated), original: undefined }, req,
    })
    return txnToApi(await prisma.aaBankTxn.findUniqueOrThrow({ where: { id: row.id } }))
  },

  /** Re-apply ledger rules to rows without a hand-set ledger. */
  async applyRules(session: Session, jobId: string) {
    const job = await jobFor(session, jobId)
    if (job.reviewStatus === 'approved') throw ApiError.conflict('job_approved', 'This statement is approved. Reopen it to make changes.')
    const rules = await AaRuleService.forClient(job.organisationId, job.clientId)
    const rows = await prisma.aaBankTxn.findMany({ where: { jobId: job.id } })
    let changed = 0
    for (const r of rows) {
      if (r.ledgerName && !r.matchedRuleId) continue // set by hand — leave it
      const rule = AaRuleService.match(rules, r.narration, r.debitPaise > 0n ? 'withdrawal' : 'deposit')
      const next = { ledgerName: rule?.ledgerName ?? null, voucherType: rule?.voucherType ?? null, matchedRuleId: rule?.id ?? null }
      if (next.ledgerName !== r.ledgerName || next.matchedRuleId !== r.matchedRuleId || next.voucherType !== r.voucherType) {
        await prisma.aaBankTxn.update({ where: { id: r.id }, data: next }); changed++
      }
    }
    return { changed }
  },

  async setJob(session: Session, jobId: string, body: { bank_ledger_name?: string; fy?: string }, req?: Request) {
    const job = await jobFor(session, jobId)
    const data: Record<string, unknown> = {}
    if (body.bank_ledger_name !== undefined) data.bankLedgerName = body.bank_ledger_name.trim().slice(0, 120) || null
    if (body.fy !== undefined) { if (body.fy && !/^\d{4}-\d{2}$/.test(body.fy)) throw ApiError.badRequest('FY is written 2026-27.'); data.fy = body.fy || null }
    await prisma.aaJob.update({ where: { id: job.id }, data })
    if ('fy' in data) await recheck(job.id)
    await writeAudit({ actorUserId: session.userId, action: 'aa.bank.job_updated', entityType: 'AaJob', entityId: job.id, after: body, req })
  },

  async approve(session: Session, jobId: string, approve: boolean, req?: Request) {
    const job = await jobFor(session, jobId)
    if (job.status !== 'extracted') throw ApiError.conflict('not_extracted', 'The statement has not been read yet.')
    if (approve) {
      // Maker-checker: the person who uploaded the statement does not also
      // sign it off, unless they are the firm's only active employee.
      if (job.createdByUserId === session.userId && !(await isSoleActiveEmployee(session.userId))) {
        throw ApiError.forbidden('You uploaded this statement, so someone else must approve it.')
      }
      const flagged = await prisma.aaBankTxn.count({ where: { jobId: job.id, status: 'flagged' } })
      if (flagged) throw ApiError.conflict('open_flags', `${flagged} flagged row${flagged === 1 ? '' : 's'} still need review — fix, exclude or accept ${flagged === 1 ? 'it' : 'them'}.`)
      const noLedger = await prisma.aaBankTxn.count({ where: { jobId: job.id, status: 'ok', ledgerName: null } })
      if (noLedger) throw ApiError.conflict('missing_ledger', `${noLedger} row${noLedger === 1 ? '' : 's'} have no Tally ledger yet.`)
      if (!job.bankLedgerName) throw ApiError.conflict('missing_bank_ledger', "Set the bank's ledger name in Tally first.")
    }
    await prisma.aaJob.update({ where: { id: job.id }, data: approve ? { reviewStatus: 'approved', approvedByUserId: session.userId, approvedAt: new Date() } : { reviewStatus: 'pending', approvedByUserId: null, approvedAt: null } })
    await writeAudit({ actorUserId: session.userId, action: approve ? 'aa.bank.job_approved' : 'aa.bank.job_reopened', entityType: 'AaJob', entityId: job.id, req })
  },

  async tallyXml(session: Session, jobId: string, req?: Request): Promise<{ xml: string; filename: string }> {
    const job = await jobFor(session, jobId)
    if (job.reviewStatus !== 'approved') throw ApiError.conflict('not_approved', 'Approve the reviewed statement before exporting to Tally.')
    const rows = await prisma.aaBankTxn.findMany({ where: { jobId: job.id, status: 'ok' }, orderBy: { seq: 'asc' } })
    const bankCode = (job.sourceDocument.bank.key.replace(/[^a-z]/gi, '').slice(0, 5) || 'BANK').toUpperCase()
    // Contra awareness — resolve the client's OTHER bank-ledger names from
    // every other approved statement on the same client, then pass that
    // set to classifyVoucherType. Keeps the "transfer between own
    // accounts → Contra" rule honest even when the rule system never
    // tagged the counter-ledger explicitly.
    const otherJobs = await prisma.aaJob.findMany({
      where: {
        clientId: job.clientId,
        organisationId: job.organisationId,
        reviewStatus: 'approved',
        bankLedgerName: { not: null },
        NOT: { id: job.id },
      },
      select: { bankLedgerName: true },
    })
    const ownBankCashLedgers = new Set<string>(
      otherJobs.map((j) => j.bankLedgerName!).filter((s) => s && s.trim()),
    )
    const preview: PreviewRow[] = rows.map((r) => {
      const direction = r.debitPaise > 0n ? 'withdrawal' as const : 'deposit' as const
      const defaultType = classifyVoucherType({
        direction, counterLedger: r.ledgerName, ownBankCashLedgers,
        currentBankLedger: job.bankLedgerName,
      })
      return {
        statement_line_id: r.id, date: r.txnDate, description: [r.narration, r.reference].filter(Boolean).join(' / '), ref_number: r.reference,
        debit_paise: Number(r.debitPaise), credit_paise: Number(r.creditPaise), direction,
        matched_rule_id: r.matchedRuleId, ledger_name: r.ledgerName,
        voucher_type: (r.voucherType ?? defaultType) as VoucherType,
        voucher_number: `${bankCode}/${r.txnDate.replace(/-/g, '')}/${String(r.seq).padStart(4, '0')}`,
        new_ledger: false,
      }
    })
    const xml = formatVouchersXml({ rows: preview, bankLedgerName: job.bankLedgerName! })
    const totDr = rows.reduce((t, r) => t + r.debitPaise, 0n)
    const totCr = rows.reduce((t, r) => t + r.creditPaise, 0n)
    const exp = await prisma.aaExport.create({
      data: {
        organisationId: job.organisationId, clientId: job.clientId, jobId: job.id, kind: 'tally_xml', rowCount: rows.length,
        totalDebitPaise: totDr, totalCreditPaise: totCr, sha256: crypto.createHash('sha256').update(xml).digest('hex'), createdByUserId: session.userId,
      },
    })
    await writeAudit({ actorUserId: session.userId, action: 'aa.bank.exported', entityType: 'AaJob', entityId: job.id, after: { export_id: exp.id, kind: 'tally_xml', rows: rows.length }, req })
    const acct = job.sourceDocument.bankAccount.accountNumberMasked.replace(/[^A-Za-z0-9]/g, '').slice(-4)
    return { xml, filename: `${bankCode}-${acct}-${job.periodFrom ?? ''}_${job.periodTo ?? ''}-tally.xml` }
  },

  /**
   * Every row, as reviewed, for the working papers. Approval-gated for the
   * same reason the Tally XML is: a half-mapped statement in Excel is the
   * same wrong data in a different file (REPOTIC-MODULE.md §1).
   *
   * `include_unreviewed = true` is the escape hatch for the Firm Manager
   * who genuinely wants to see raw rows alongside flags — the audit log
   * records which path was used.
   */
  async workbook(session: Session, jobId: string, req?: Request, opts?: { includeUnreviewed?: boolean }): Promise<{ bytes: Buffer; filename: string }> {
    const job = await jobFor(session, jobId)
    if (!opts?.includeUnreviewed && job.reviewStatus !== 'approved') {
      throw ApiError.conflict('not_approved', 'Approve the reviewed statement before exporting the workbook (same gate as the Tally XML export).')
    }
    const rows = await prisma.aaBankTxn.findMany({ where: { jobId: job.id }, orderBy: { seq: 'asc' } })
    const wb = new ExcelJS.Workbook()
    const rupees = (p: bigint | null) => (p === null ? null : Number(p) / 100)
    const s = wb.addWorksheet('Summary')
    s.columns = [{ header: 'Field', key: 'k', width: 28 }, { header: 'Value', key: 'v', width: 40 }]
    const inc = rows.filter((r) => r.status === 'ok' || r.status === 'flagged')
    for (const [k, v] of [
      ['Bank', job.sourceDocument.bank.name], ['Account', job.sourceDocument.bankAccount.accountNumberMasked],
      ['Period', `${job.periodFrom ?? ''} to ${job.periodTo ?? ''}`], ['FY', job.fy ?? ''],
      ['Opening balance', rupees(job.openingBalancePaise)], ['Closing balance', rupees(job.closingBalancePaise)],
      ['Transactions', rows.length], ['Included', inc.length],
      ['Duplicates', rows.filter((r) => r.status === 'duplicate').length], ['Excluded', rows.filter((r) => r.status === 'excluded').length],
      ['Total withdrawals', rupees(inc.reduce((t, r) => t + r.debitPaise, 0n))], ['Total deposits', rupees(inc.reduce((t, r) => t + r.creditPaise, 0n))],
      ['Review status', job.reviewStatus],
    ] as const) s.addRow({ k, v })
    const t = wb.addWorksheet('Transactions')
    t.columns = [
      { header: '#', key: 'seq', width: 6 }, { header: 'Date', key: 'd', width: 12 }, { header: 'Value date', key: 'vd', width: 12 },
      { header: 'Narration', key: 'n', width: 60 }, { header: 'Reference', key: 'r', width: 20 },
      { header: 'Withdrawal', key: 'dr', width: 14 }, { header: 'Deposit', key: 'cr', width: 14 }, { header: 'Balance', key: 'b', width: 16 },
      { header: 'Ledger', key: 'l', width: 28 }, { header: 'Voucher', key: 'vt', width: 10 }, { header: 'Status', key: 's', width: 10 }, { header: 'Flags', key: 'f', width: 30 }, { header: 'Edited', key: 'e', width: 8 },
    ]
    const otherBanks = await prisma.aaJob.findMany({
      where: { clientId: job.clientId, organisationId: job.organisationId, reviewStatus: 'approved', bankLedgerName: { not: null }, NOT: { id: job.id } },
      select: { bankLedgerName: true },
    })
    const ownSet = new Set<string>(otherBanks.map((j) => j.bankLedgerName!).filter(Boolean))
    for (const r of rows) {
      const direction = r.debitPaise > 0n ? 'withdrawal' as const : 'deposit' as const
      const defaultVt = classifyVoucherType({ direction, counterLedger: r.ledgerName, ownBankCashLedgers: ownSet, currentBankLedger: job.bankLedgerName })
      t.addRow({ seq: r.seq, d: r.txnDate, vd: r.valueDate, n: r.narration, r: r.reference, dr: rupees(r.debitPaise) || null, cr: rupees(r.creditPaise) || null, b: rupees(r.balancePaise), l: r.ledgerName, vt: r.voucherType ?? defaultVt, s: r.status, f: r.flags, e: r.editedAt ? 'yes' : '' })
    }
    for (const c of ['dr', 'cr', 'b']) t.getColumn(c).numFmt = '#,##0.00'
    t.getRow(1).font = { bold: true }
    await writeAudit({ actorUserId: session.userId, action: 'aa.bank.exported', entityType: 'AaJob', entityId: job.id, after: { kind: 'xlsx', rows: rows.length }, req })
    return { bytes: Buffer.from(await wb.xlsx.writeBuffer()), filename: `statement-${job.periodFrom ?? job.id}.xlsx` }
  },

  recheck,
}
