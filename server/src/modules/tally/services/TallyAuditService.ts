import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { TallyCompanyService } from './TallyCompanyService.js'
import { trialBalance } from '../engine/balances.js'
import { stockPositions } from '../engine/inventory.js'

/**
 * TallyAuditService — the verification surface. Audit OS exists to look
 * at other people's books; this is the part that lets an auditor look at
 * these ones.
 *
 * Two sources, both append-only:
 *   TallyVoucherRevision — every create / alter / cancel / restore of a
 *     voucher, with the before and after snapshots.
 *   AuditLog — the platform-wide actor/action/IP trail the rest of
 *     Audit OS already writes.
 *
 * Nothing in the UI deletes from either.
 */

export const TallyAuditService = {
  /** Full trail for a company, newest first. */
  async trail(session: Session, companyId: string, filter: { action?: string; voucherId?: string; from?: string; to?: string; limit?: number } = {}) {
    await TallyCompanyService.requireOwned(session, companyId)
    const rows = await prisma.tallyVoucherRevision.findMany({
      where: {
        tallyCompanyId: companyId,
        ...(filter.action && filter.action !== 'all' ? { action: filter.action } : {}),
        ...(filter.voucherId ? { voucherId: filter.voucherId } : {}),
        ...(filter.from || filter.to
          ? { createdAt: { ...(filter.from ? { gte: new Date(filter.from + 'T00:00:00Z') } : {}), ...(filter.to ? { lte: new Date(filter.to + 'T23:59:59Z') } : {}) } }
          : {}),
      },
      include: { voucher: { select: { voucherNumber: true, voucherTypeCode: true, date: true, status: true } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter.limit ?? 200, 1000),
    })
    const actorIds = Array.from(new Set(rows.map((r) => r.actorUserId).filter((x): x is string => Boolean(x))))
    const actors = actorIds.length
      ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } })
      : []
    const actorById = new Map(actors.map((a) => [a.id, a.email]))
    return rows.map((r) => ({
      id: r.id,
      voucher_id: r.voucherId,
      voucher_number: r.voucher.voucherNumber,
      voucher_type_code: r.voucher.voucherTypeCode,
      voucher_date: r.voucher.date,
      voucher_status: r.voucher.status,
      version: r.version,
      action: r.action,
      actor_user_id: r.actorUserId,
      actor_label: r.actorUserId ? actorById.get(r.actorUserId) ?? r.actorUserId : 'system',
      note: r.note,
      at: r.createdAt.toISOString(),
      has_before: Boolean(r.beforeJson),
      has_after: Boolean(r.afterJson),
    }))
  },

  /** The old/new comparison for one revision. */
  async revision(session: Session, companyId: string, revisionId: string) {
    await TallyCompanyService.requireOwned(session, companyId)
    const r = await prisma.tallyVoucherRevision.findFirst({ where: { id: revisionId, tallyCompanyId: companyId } })
    if (!r) throw ApiError.notFound('No such revision.')
    const safeParse = (s: string | null) => { if (!s) return null; try { return JSON.parse(s) as unknown } catch { return { raw: s } } }
    return {
      id: r.id, voucher_id: r.voucherId, version: r.version, action: r.action,
      at: r.createdAt.toISOString(), actor_user_id: r.actorUserId,
      before: safeParse(r.beforeJson),
      after: safeParse(r.afterJson),
    }
  },

  /** Vouchers that have been altered since they were first posted. */
  async alteredVouchers(session: Session, companyId: string, filter: { from?: string; to?: string } = {}) {
    await TallyCompanyService.requireOwned(session, companyId)
    const rows = await prisma.tallyVoucher.findMany({
      where: {
        tallyCompanyId: companyId, ...alive, version: { gt: 1 },
        ...(filter.from || filter.to
          ? { date: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
          : {}),
      },
      select: {
        id: true, voucherNumber: true, voucherTypeCode: true, date: true, status: true, version: true,
        grandTotalPaise: true, updatedAt: true, modifiedByUserId: true,
        partyLedger: { select: { name: true } },
        _count: { select: { revisions: true } },
      },
      orderBy: { updatedAt: 'desc' }, take: 500,
    })
    return rows.map((v) => ({
      voucher_id: v.id, voucher_number: v.voucherNumber, voucher_type_code: v.voucherTypeCode,
      date: v.date, status: v.status, version: v.version, revision_count: v._count.revisions,
      party_name: v.partyLedger?.name ?? null, grand_total_paise: v.grandTotalPaise,
      last_modified_at: v.updatedAt.toISOString(), last_modified_by: v.modifiedByUserId,
    }))
  },

  /** Cancelled vouchers — they are never removed, only marked. */
  async cancelledVouchers(session: Session, companyId: string, filter: { from?: string; to?: string } = {}) {
    await TallyCompanyService.requireOwned(session, companyId)
    const rows = await prisma.tallyVoucher.findMany({
      where: {
        tallyCompanyId: companyId, ...alive, status: 'cancelled',
        ...(filter.from || filter.to
          ? { date: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
          : {}),
      },
      select: {
        id: true, voucherNumber: true, voucherTypeCode: true, date: true, grandTotalPaise: true,
        cancelledAt: true, cancelledByUserId: true, cancelReason: true, partyLedger: { select: { name: true } },
      },
      orderBy: { cancelledAt: 'desc' }, take: 500,
    })
    return rows.map((v) => ({
      voucher_id: v.id, voucher_number: v.voucherNumber, voucher_type_code: v.voucherTypeCode,
      date: v.date, grand_total_paise: v.grandTotalPaise, party_name: v.partyLedger?.name ?? null,
      cancelled_at: v.cancelledAt?.toISOString() ?? null, cancelled_by: v.cancelledByUserId, reason: v.cancelReason,
    }))
  },

  /** Who did what, from the platform audit log, filtered to Tally actions. */
  async userActivity(session: Session, companyId: string, limit = 200) {
    await TallyCompanyService.requireOwned(session, companyId)
    const rows = await prisma.auditLog.findMany({
      where: { action: { startsWith: 'tally.' } },
      orderBy: { createdAt: 'desc' }, take: Math.min(limit, 500),
    })
    const actorIds = Array.from(new Set(rows.map((r) => r.actorUserId).filter((x): x is string => Boolean(x))))
    const actors = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } }) : []
    const byId = new Map(actors.map((a) => [a.id, a.email]))
    return rows.map((r) => ({
      id: r.id, action: r.action, entity_type: r.entityType, entity_id: r.entityId,
      actor_label: r.actorUserId ? byId.get(r.actorUserId) ?? r.actorUserId : 'system',
      ip: r.ip, user_agent: r.userAgent, at: r.createdAt.toISOString(),
    }))
  },

  /**
   * Exception report — the checks an auditor would run first. Each row is
   * a real query against the posted data, not a placeholder.
   */
  async exceptions(session: Session, companyId: string, opts: { from?: string; to?: string } = {}) {
    await TallyCompanyService.requireOwned(session, companyId)
    const range = { from: opts.from ?? null, to: opts.to ?? null }
    const dateWhere = range.from || range.to
      ? { date: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
      : {}

    const [tb, stock, noNarration, backdated, negativeCash, cancelled, altered, unreconciled] = await Promise.all([
      trialBalance(companyId, range),
      stockPositions(companyId, range),
      prisma.tallyVoucher.count({ where: { tallyCompanyId: companyId, ...alive, status: 'active', narration: null, ...dateWhere } }),
      prisma.tallyVoucher.count({
        where: { tallyCompanyId: companyId, ...alive, status: 'active', ...dateWhere },
      }),
      (async () => {
        const rows = await import('../engine/balances.js').then((m) => m.ledgerBalances(companyId, range))
        return rows.filter((r) => (r.primaryGroupName === 'Cash-in-Hand' || r.primaryGroupName === 'Bank Accounts') && r.closingPaise < 0)
      })(),
      prisma.tallyVoucher.count({ where: { tallyCompanyId: companyId, ...alive, status: 'cancelled', ...dateWhere } }),
      prisma.tallyVoucher.count({ where: { tallyCompanyId: companyId, ...alive, version: { gt: 1 }, ...dateWhere } }),
      prisma.tallyBankStatementLine.count({ where: { tallyCompanyId: companyId, ...alive, status: 'unmatched' } }),
    ])

    const items = [
      {
        key: 'trial_balance', label: 'Trial balance does not balance',
        severity: 'critical' as const, count: tb.totals.balanced ? 0 : 1,
        detail: tb.totals.balanced ? 'Debits equal credits.' : `Out by ₹${(Math.abs(tb.totals.differencePaise) / 100).toFixed(2)}.`,
      },
      {
        key: 'negative_stock', label: 'Stock items with a negative closing quantity',
        severity: 'high' as const, count: stock.filter((s) => s.negative).length,
        detail: 'Goods were issued that the books say were never received.',
      },
      {
        key: 'negative_cash', label: 'Cash or bank ledgers with a credit balance',
        severity: 'high' as const, count: negativeCash.length,
        detail: negativeCash.map((r) => r.ledgerName).join(', ') || 'None.',
      },
      {
        key: 'below_reorder', label: 'Stock items below their reorder level',
        severity: 'info' as const, count: stock.filter((s) => s.belowReorder).length, detail: 'Reordering may be due.',
      },
      {
        key: 'altered', label: 'Vouchers altered after posting',
        severity: 'medium' as const, count: altered, detail: 'Every alteration is recorded with a before/after snapshot.',
      },
      {
        key: 'cancelled', label: 'Cancelled vouchers',
        severity: 'medium' as const, count: cancelled, detail: 'Cancelled vouchers keep their number and their history.',
      },
      {
        key: 'no_narration', label: 'Posted vouchers with no narration',
        severity: 'low' as const, count: noNarration, detail: 'Narration is how a voucher explains itself at audit time.',
      },
      {
        key: 'unreconciled_bank', label: 'Unmatched bank statement lines',
        severity: 'medium' as const, count: unreconciled, detail: 'Import and match to close the bank reconciliation.',
      },
    ]
    return { period: range, voucher_count: backdated, items: items.sort((a, b) => b.count - a.count) }
  },
}
