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
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { requireWorkstation } from '../../platform/workstation/scope.js'
import { writeAudit } from '../../platform/audit.js'

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

// ── WRITE PATH ───────────────────────────────────────────────────────────
//
// Templates are firm-level catalogue (like ComplianceForm): editing them
// needs BOTH workstation.doc.manage AND settings.manage. A staff member
// who can prepare a document can't edit the template library behind it;
// a firm admin can.
//
// Writes come in two sizes:
//   * POST / and POST /:code/versions — the full composition in one body
//     (template + clauses + variants). Atomic in a $transaction so a half-
//     written template is never stored.
//   * PATCH /:id — metadata only (isActive, name, description, outputFormats).
//     Clause + variant edits are a NEW VERSION (POST /:code/versions), not
//     a mutation, so an older document pinned to a prior version regenerates
//     unchanged.

function requireManage(session: Session) {
  if (!can(session, 'workstation.doc.manage')) {
    throw ApiError.forbidden('Managing templates needs document → manage.')
  }
  if (!can(session, 'settings.manage')) {
    throw ApiError.forbidden('Editing the template catalogue needs Settings → manage.')
  }
}

const OUTPUT_FORMATS = ['pdf', 'docx', 'xlsx'] as const
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')

const variantBody = z.object({
  label: z.string().trim().min(1, 'Label is required.').max(120),
  body: z.string().max(100_000, 'Variant body is too long.').default(''),
  is_default: z.boolean().default(false),
})

const clauseBody = z.object({
  clause_code: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,63}$/i, 'Clause code is alphanumeric + underscore/dash.'),
  clause_title: z.string().trim().min(1, 'Clause title is required.').max(200),
  sort_order: z.coerce.number().int().nonnegative().default(0),
  required: z.boolean().default(true),
  variants: z.array(variantBody).default([]),
})

const templateBody = z.object({
  code: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,63}$/i, 'Template code is alphanumeric + underscore/dash.'),
  name: z.string().trim().min(1, 'Template name is required.').max(200),
  description: z.string().max(2000).nullish(),
  output_formats: z.array(z.enum(OUTPUT_FORMATS)).min(1, 'Pick at least one output format.').default(['pdf']),
  effective_from: ISO_DATE,
  body: z.string().max(200_000, 'Template body is too long.').default(''),
  is_active: z.boolean().default(true),
  clauses: z.array(clauseBody).default([]),
})

const newVersionBody = templateBody.omit({ code: true })
const patchBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).nullish().optional(),
  output_formats: z.array(z.enum(OUTPUT_FORMATS)).min(1).optional(),
  is_active: z.boolean().optional(),
})

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data)
  if (!r.success) {
    throw ApiError.badRequest('Check the highlighted fields.',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
  }
  return r.data
}

/** The single org row's id (Audit OS is single-tenant today). Matches the
 *  pattern used by docs/service.ts when creating workstation docs. */
async function orgIdOf(): Promise<string> {
  const o = await prisma.organisation.findFirst({ select: { id: true } })
  return o?.id ?? 'org-audit-os'
}

type ClauseIn = z.infer<typeof clauseBody>

async function assertOneDefaultPerClause(clauses: ClauseIn[]): Promise<void> {
  // The variant's is_default flag is enforced by the service, not a DB
  // constraint (see the schema comment). A clause can have ONE default or
  // zero — never two. This catches the bad input before we start writing.
  for (const c of clauses) {
    const defaults = c.variants.filter((v) => v.is_default).length
    if (defaults > 1) {
      throw ApiError.badRequest('A clause can have at most one default variant.',
        [{ path: `clauses.${c.clause_code}.variants`, message: 'At most one variant may be marked default.' }])
    }
  }
}

/**
 * POST /api/doc-templates — create a new template (version 1) with all its
 * clauses and variants. Fails if the code already exists at version 1.
 */
docTemplatesRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.doc.manage')
  requireManage(session)
  const b = parse(templateBody, req.body)
  await assertOneDefaultPerClause(b.clauses)

  const existing = await prisma.docTemplate.findFirst({ where: { code: b.code } })
  if (existing) throw ApiError.conflict('template_exists', 'A template with this code already exists — use POST /:code/versions to add a new version.')

  const organisationId = await orgIdOf()
  const created = await prisma.$transaction(async (tx) => {
    const template = await tx.docTemplate.create({
      data: {
        organisationId, code: b.code, version: 1, name: b.name,
        description: b.description ?? null,
        outputFormats: b.output_formats.join(','),
        effectiveFrom: b.effective_from,
        body: b.body,
        isActive: b.is_active,
        createdBy: session.userId, updatedBy: session.userId,
      },
    })
    for (const c of b.clauses) {
      const clause = await tx.docTemplateClause.create({
        data: {
          templateId: template.id,
          clauseCode: c.clause_code, clauseTitle: c.clause_title,
          sortOrder: c.sort_order, required: c.required,
        },
      })
      for (const v of c.variants) {
        await tx.docTemplateClauseVariant.create({
          data: { clauseId: clause.id, label: v.label, body: v.body, isDefault: v.is_default },
        })
      }
    }
    return template
  })
  await writeAudit({
    actorUserId: session.userId, action: 'doc_template.create',
    entityType: 'DocTemplate', entityId: created.id, after: b, req,
  })
  // Read the created shape back so the response matches the GET /:code one.
  const full = await prisma.docTemplate.findUnique({
    where: { id: created.id },
    include: { clauses: { orderBy: { sortOrder: 'asc' }, include: { variants: { orderBy: { label: 'asc' } } } } },
  })
  ok(res, detail(full as unknown as DetailRow), 201)
}))

/**
 * POST /api/doc-templates/:code/versions — create the NEXT version for an
 * existing code. The latest previous version is DEACTIVATED automatically
 * (the firm's picker shows one row per code; keeping two active is just
 * clutter). A document pinned to the prior version regenerates unchanged
 * because pinning reads /:code/:version, not /:code.
 */
docTemplatesRouter.post('/:code/versions', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.doc.manage')
  requireManage(session)
  const b = parse(newVersionBody, req.body)
  await assertOneDefaultPerClause(b.clauses)

  // Find the latest version (active or not) for this code.
  const prior = await prisma.docTemplate.findFirst({
    where: { code: req.params.code, deletedAt: null },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, code: true },
  })
  if (!prior) throw ApiError.notFound('No template with this code — use POST / to create the first version.')

  const nextVersion = prior.version + 1
  const organisationId = await orgIdOf()
  const created = await prisma.$transaction(async (tx) => {
    // Deactivate prior — new version takes over the "active" slot.
    await tx.docTemplate.update({ where: { id: prior.id }, data: { isActive: false, updatedBy: session.userId } })
    const template = await tx.docTemplate.create({
      data: {
        organisationId, code: prior.code, version: nextVersion, name: b.name,
        description: b.description ?? null,
        outputFormats: b.output_formats.join(','),
        effectiveFrom: b.effective_from,
        body: b.body,
        isActive: b.is_active,
        createdBy: session.userId, updatedBy: session.userId,
      },
    })
    for (const c of b.clauses) {
      const clause = await tx.docTemplateClause.create({
        data: {
          templateId: template.id,
          clauseCode: c.clause_code, clauseTitle: c.clause_title,
          sortOrder: c.sort_order, required: c.required,
        },
      })
      for (const v of c.variants) {
        await tx.docTemplateClauseVariant.create({
          data: { clauseId: clause.id, label: v.label, body: v.body, isDefault: v.is_default },
        })
      }
    }
    return template
  })
  await writeAudit({
    actorUserId: session.userId, action: 'doc_template.new_version',
    entityType: 'DocTemplate', entityId: created.id, before: { code: prior.code, version: prior.version }, after: { ...b, version: nextVersion }, req,
  })
  const full = await prisma.docTemplate.findUnique({
    where: { id: created.id },
    include: { clauses: { orderBy: { sortOrder: 'asc' }, include: { variants: { orderBy: { label: 'asc' } } } } },
  })
  ok(res, detail(full as unknown as DetailRow), 201)
}))

/**
 * PATCH /api/doc-templates/:id — metadata only. Clause / variant edits are
 * a NEW VERSION (POST /:code/versions). This endpoint flips isActive and
 * fixes typos on name / description / output_formats — low-risk edits that
 * don't change what a document pinned to this row regenerates to.
 */
docTemplatesRouter.patch('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.doc.manage')
  requireManage(session)
  const b = parse(patchBody, req.body)
  const before = await prisma.docTemplate.findFirst({ where: { id: req.params.id, deletedAt: null } })
  if (!before) throw ApiError.notFound('Template not found.')

  const data: Record<string, unknown> = { updatedBy: session.userId }
  if (b.name !== undefined) data.name = b.name
  if (b.description !== undefined) data.description = b.description ?? null
  if (b.output_formats !== undefined) data.outputFormats = b.output_formats.join(',')
  if (b.is_active !== undefined) data.isActive = b.is_active

  const after = await prisma.docTemplate.update({ where: { id: before.id }, data })
  await writeAudit({
    actorUserId: session.userId, action: 'doc_template.update',
    entityType: 'DocTemplate', entityId: after.id, before, after, req,
  })
  const full = await prisma.docTemplate.findUnique({
    where: { id: after.id },
    include: { clauses: { orderBy: { sortOrder: 'asc' }, include: { variants: { orderBy: { label: 'asc' } } } } },
  })
  ok(res, detail(full as unknown as DetailRow))
}))

/**
 * DELETE /api/doc-templates/:id — SOFT delete. A document pinned to this
 * row still regenerates (the pin reads via /:code/:version and the delete
 * only stamps deletedAt on the row — the data is still there). Hard delete
 * would break regeneration retroactively, which contradicts §D3's pinning
 * invariant.
 */
docTemplatesRouter.delete('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.doc.manage')
  requireManage(session)
  const before = await prisma.docTemplate.findFirst({ where: { id: req.params.id, deletedAt: null } })
  if (!before) throw ApiError.notFound('Template not found.')
  const now = new Date()
  await prisma.docTemplate.update({
    where: { id: before.id },
    data: { deletedAt: now, isActive: false, updatedBy: session.userId },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'doc_template.delete',
    entityType: 'DocTemplate', entityId: before.id, before, req,
  })
  ok(res, { id: before.id, deleted_at: now.toISOString() })
}))
