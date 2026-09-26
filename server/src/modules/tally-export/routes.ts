/**
 * Tally Export HTTP surface — docs/tally-export/README.md.
 *
 * Endpoints:
 *   GET    /api/tally-export/rules[?companyId=X]           list rules
 *   POST   /api/tally-export/rules                        create rule
 *   PATCH  /api/tally-export/rules/:id                    update rule
 *   DELETE /api/tally-export/rules/:id                    soft-delete rule
 *   POST   /api/tally-export/preview                      preview rows for a scope
 *   POST   /api/tally-export/preflight                    full preflight report
 *   POST   /api/tally-export/generate                     stubbed until §11 fixture
 *   GET    /api/tally-export/history[?companyId=X&bankLedgerId=Y]
 *
 * RBAC reuses the accounting-engine grants — the operator running
 * exports is the same role that manages vouchers.
 */
import { Router } from 'express'
import { prisma } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { requireWorkstation } from '../../platform/workstation/scope.js'
import {
  buildPreview, computePreflight, createRule, deleteRule, listAllRules,
  listExportHistory, listRulesForClient, updateRule,
} from './service.js'
import { formatVouchersXml } from './xml.js'
import { MATCH_TYPES, VOUCHER_TYPES } from './types.js'

export const tallyExportRouter = Router()

const MANAGE = ['tools.audit_automation.bookkeeping.voucher.manage'] as const
const READ = [
  'tools.audit_automation.bookkeeping.voucher.read',
  'tools.audit_automation.bookkeeping.voucher.manage',
] as const

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

// ── Rules ────────────────────────────────────────────────────────────────

tallyExportRouter.get('/rules', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, ...READ)
  const companyId = str(req.query.companyId) ?? str(req.query.company_id)
  ok(res, { items: companyId ? await listRulesForClient(companyId) : await listAllRules() })
}))

tallyExportRouter.post('/rules', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, ...MANAGE)
  const b = (req.body ?? {}) as Record<string, unknown>
  const rule = await createRule({
    companyId: str(b.company_id) ?? str(b.companyId),
    matchType: (str(b.match_type) ?? 'contains') as (typeof MATCH_TYPES)[number],
    pattern: str(b.pattern) ?? '',
    ledgerName: str(b.ledger_name) ?? '',
    voucherType: (str(b.voucher_type) ?? null) as (typeof VOUCHER_TYPES)[number] | null,
    priority: typeof b.priority === 'number' ? b.priority : 0,
  }, session.userId ?? null)
  ok(res, rule, 201)
}))

tallyExportRouter.patch('/rules/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, ...MANAGE)
  const b = (req.body ?? {}) as Record<string, unknown>
  const patch: Parameters<typeof updateRule>[1] = {}
  if ('company_id' in b) patch.companyId = str(b.company_id) ?? str(b.companyId)
  if ('match_type' in b) patch.matchType = str(b.match_type) as (typeof MATCH_TYPES)[number]
  if ('pattern' in b) patch.pattern = str(b.pattern) ?? ''
  if ('ledger_name' in b) patch.ledgerName = str(b.ledger_name) ?? ''
  if ('voucher_type' in b) patch.voucherType = (str(b.voucher_type) ?? null) as (typeof VOUCHER_TYPES)[number] | null
  if ('priority' in b && typeof b.priority === 'number') patch.priority = b.priority
  const row = await updateRule(req.params.id, patch)
  ok(res, row)
}))

tallyExportRouter.delete('/rules/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, ...MANAGE)
  await deleteRule(req.params.id)
  ok(res, { ok: true })
}))

// ── Preview + preflight ──────────────────────────────────────────────────

function parseBuildOptions(b: Record<string, unknown>) {
  const companyId = str(b.company_id) ?? str(b.companyId)
  const bankLedgerId = str(b.bank_ledger_id) ?? str(b.bankLedgerId)
  const periodFrom = str(b.period_from) ?? str(b.periodFrom)
  const periodTo = str(b.period_to) ?? str(b.periodTo)
  if (!companyId) throw ApiError.badRequest('company_id is required.')
  if (!bankLedgerId) throw ApiError.badRequest('bank_ledger_id is required.')
  if (!periodFrom || !ISO_DATE.test(periodFrom)) throw ApiError.badRequest('period_from must be YYYY-MM-DD.')
  if (!periodTo || !ISO_DATE.test(periodTo)) throw ApiError.badRequest('period_to must be YYYY-MM-DD.')
  if (periodFrom > periodTo) throw ApiError.badRequest('period_from must not be later than period_to.')
  return { companyId, bankLedgerId, periodFrom, periodTo }
}

tallyExportRouter.post('/preview', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, ...READ)
  const opts = parseBuildOptions((req.body ?? {}) as Record<string, unknown>)
  const preview = await buildPreview(opts)
  ok(res, preview)
}))

tallyExportRouter.post('/preflight', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, ...READ)
  const opts = parseBuildOptions((req.body ?? {}) as Record<string, unknown>)
  const report = await computePreflight(opts)
  ok(res, report)
}))

// ── Generate — deferred until §11 fixture ────────────────────────────────

/**
 * POST /api/tally-export/generate — spec §9.
 *
 * Body: same as /preflight PLUS `format` = 'xml' | 'xlsx'. When `format`
 * is 'xml' the response streams the Tally XML envelope (Appendix A) as
 * `application/xml`. `xlsx` remains stubbed until §11's fixture arrives —
 * the row grouping and date format the Excel writer needs are unknowns
 * only a real exported voucher can settle.
 *
 * Preflight is run before generating; any error blocks the write (§6).
 * A refused XLSX still returns 501 with the same message as before.
 */
tallyExportRouter.post('/generate', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, ...MANAGE)
  const b = (req.body ?? {}) as Record<string, unknown>
  const opts = parseBuildOptions(b)
  const format = typeof b.format === 'string' ? b.format : 'xml'
  if (format !== 'xml' && format !== 'xlsx') {
    throw ApiError.badRequest('format must be "xml" or "xlsx".')
  }

  const report = await computePreflight(opts)
  if (report.errors.length > 0) {
    throw ApiError.unprocessable('preflight_failed',
      `Preflight blocked the export — ${report.errors.length} error(s). `
      + report.errors.slice(0, 3).map((e) => e.message).join(' · '))
  }

  if (format === 'xlsx') {
    throw new ApiError(501, 'not_implemented',
      'The XLSX writer is deferred until a real voucher exported from the client\'s '
      + 'Tally is committed as a test fixture (spec §0 / §11). '
      + 'Use format="xml" for now, or preview via /preflight.')
  }

  const bankLedger = await prisma.bookkeepingLedger.findFirst({
    where: { id: opts.bankLedgerId, tallyCompanyId: opts.companyId, deletedAt: null },
    select: { name: true },
  })
  if (!bankLedger) throw ApiError.notFound('Bank ledger not found on this company.')

  const xml = formatVouchersXml({ rows: report.rows, bankLedgerName: bankLedger.name })
  const filename = `tally-vouchers-${opts.bankLedgerId.slice(0, 8)}-${opts.periodFrom}_${opts.periodTo}.xml`

  res.setHeader('Content-Type', 'application/xml; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.end(xml)
}))

// ── History ──────────────────────────────────────────────────────────────

tallyExportRouter.get('/history', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, ...READ)
  const companyId = str(req.query.companyId) ?? str(req.query.company_id)
  if (!companyId) throw ApiError.badRequest('companyId is required.')
  const bankLedgerId = str(req.query.bankLedgerId) ?? str(req.query.bank_ledger_id) ?? undefined
  const items = await listExportHistory(companyId, bankLedgerId)
  ok(res, { items })
}))
