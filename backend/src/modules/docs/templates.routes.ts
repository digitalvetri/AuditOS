/**
 * Doc-template read API (POST-DELIVERY-CHANGES §D2 + §D3).
 *
 * Read-only in this PR. Templates, clauses and variants are DATA (doc §D3:
 * "variants are data, not code — the firm will want a third profit-sharing
 * wording within a month; that must be a row, not a deployment"), so the
 * write path is a Settings surface. Without a UI for that yet, write
 * endpoints have no caller and ship with the UI they belong to.
 *
 *   GET /api/doc-templates             — latest active version per code
 *   GET /api/doc-templates/:code       — latest active version + clauses + variants
 *   GET /api/doc-templates/:code/:version
 *                                     — the PINNED version for regenerating
 *                                       an already-composed document (doc §D3
 *                                       "versioned and pinned at document
 *                                       creation"). Returns inactive versions
 *                                       so a March deed still regenerates in
 *                                       November after the template moved on.
 *
 * Permission is the same `workstation.doc.read` the Doc list uses — a firm
 * member who sees documents sees the templates they can be composed from.
 */
import { Router } from 'express'
import { ApiError, handler, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { requireSession } from '../../platform/auth.js'
import { requireWorkstation } from '../../platform/workstation/scope.js'

export const docTemplatesRouter = Router()

interface SummaryRow {
  id: string; code: string; version: number; name: string; description: string | null
  outputFormats: string; effectiveFrom: string
}
function summary(r: SummaryRow) {
  return {
    id: r.id,
    code: r.code,
    version: r.version,
    name: r.name,
    description: r.description,
    output_formats: r.outputFormats ? r.outputFormats.split(',').map((s) => s.trim()).filter(Boolean) : [],
    effective_from: r.effectiveFrom,
  }
}

interface VariantRow { id: string; label: string; body: string; isDefault: boolean }
interface ClauseRow {
  id: string; clauseCode: string; clauseTitle: string; sortOrder: number; required: boolean
  variants: VariantRow[]
}
interface DetailRow extends SummaryRow {
  body: string
  isActive: boolean
  clauses: ClauseRow[]
}

function detail(r: DetailRow) {
  // Parse the JSON body up front where possible so the editor doesn't have
  // to. If the body is plain prose (no JSON), pass it through verbatim —
  // the renderer (render.ts) walks the template body as a single string.
  return {
    ...summary(r),
    is_active: r.isActive,
    body: r.body,
    clauses: r.clauses.map((c) => ({
      id: c.id,
      clause_code: c.clauseCode,
      clause_title: c.clauseTitle,
      sort_order: c.sortOrder,
      required: c.required,
      variants: c.variants.map((v) => ({
        id: v.id,
        label: v.label,
        body: v.body,
        is_default: v.isDefault,
      })),
    })),
  }
}

/**
 * GET /api/doc-templates — one row per CODE, latest active version.
 *
 * Ordered by `code` for stable listings; a firm scanning the picker wants
 * the catalogue in a predictable order, not newest-first (there's one
 * active version per code at a time, so newest-first collapses to nothing
 * useful).
 */
docTemplatesRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.doc.read')
  const rows = await prisma.docTemplate.findMany({
    where: { isActive: true, deletedAt: null },
    orderBy: [{ code: 'asc' }, { version: 'desc' }],
    select: { id: true, code: true, version: true, name: true, description: true, outputFormats: true, effectiveFrom: true },
  })
  // Dedupe to the latest version per code (SQL `distinct on` equivalent).
  const seen = new Set<string>()
  const latest: SummaryRow[] = []
  for (const r of rows) {
    if (seen.has(r.code)) continue
    seen.add(r.code)
    latest.push(r)
  }
  ok(res, latest.map(summary))
}))

/**
 * GET /api/doc-templates/:code — the latest ACTIVE version of a template,
 * with all clauses and variants eagerly loaded so the editor can render the
 * picker in a single request.
 *
 * 404 on an unknown code or when every version is deactivated — a dormant
 * code is NOT a draftable template, even if it still exists.
 */
docTemplatesRouter.get('/:code', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.doc.read')
  const row = await prisma.docTemplate.findFirst({
    where: { code: req.params.code, isActive: true, deletedAt: null },
    orderBy: { version: 'desc' },
    include: {
      clauses: {
        orderBy: { sortOrder: 'asc' },
        include: { variants: { orderBy: { label: 'asc' } } },
      },
    },
  })
  if (!row) throw ApiError.notFound('Template not found.')
  ok(res, detail(row))
}))

/**
 * GET /api/doc-templates/:code/:version — the EXACT pinned version.
 *
 * Returns INACTIVE rows too. A document generated in March pins (code,
 * version) at creation; regenerating it in November, after the firm has
 * moved on to version N+1, must still produce the SAME paper. The
 * document's view calls this endpoint; the editor's picker uses the
 * `/:code` path above.
 */
docTemplatesRouter.get('/:code/:version', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.doc.read')
  const version = Number(req.params.version)
  if (!Number.isInteger(version) || version < 1) throw ApiError.badRequest('Version must be a positive integer.')
  const row = await prisma.docTemplate.findFirst({
    where: { code: req.params.code, version, deletedAt: null },
    include: {
      clauses: {
        orderBy: { sortOrder: 'asc' },
        include: { variants: { orderBy: { label: 'asc' } } },
      },
    },
  })
  if (!row) throw ApiError.notFound('Template version not found.')
  ok(res, detail(row))
}))
