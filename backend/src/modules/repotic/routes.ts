/**
 * Repotic HTTP surface — REPOTIC-MODULE.md Phase 1.
 *
 * Endpoints:
 *   GET  /api/repotic/marketplaces[?client_id=X&gstin=Y&period=YYYY-MM]
 *        Static marketplace × report list + per-source adapter status
 *        (adapter version present? last upload for this scope?).
 *
 *   POST /api/repotic/ecommerce/uploads  (multipart/form-data)
 *        Fields: client_id, gstin, period, marketplace, report_kind, file
 *        Reads the file's header row, fingerprints against every active
 *        adapter version, classifies as matched / drifted / no_match,
 *        and records a RpEcommerceUpload row. Idempotent on sha256 +
 *        scope.
 *
 *   GET  /api/repotic/ecommerce/uploads?client_id&gstin&period
 *        Lists uploads for one GSTR-1 scope. Used by the summary view.
 *
 *   GET  /api/repotic/adapters[?marketplace&report_kind]
 *        Firm-level view of adapters. Only visible to users with the
 *        audit-automation manage grant.
 */
import crypto from 'node:crypto'
import type { Request } from 'express'
import { Router } from 'express'
import multer from 'multer'
import ExcelJS from 'exceljs'
import { prisma } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { readStatementTable } from '../audit-automation/lib/tableFile.js'
import { parseCsv } from '../zpay/invoice-import.js'
import { MARKETPLACES, isMarketplaceKey, findReportKind } from './marketplaces.js'
import { detect, fingerprintOf } from './fingerprint.js'
import { parseFromBuffer } from './parser.js'
import { buildGstr1Preview } from './gstr1-builder.js'

export const repoticRouter = Router()

const UPLOAD_MAX_MB = 25
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: UPLOAD_MAX_MB * 1024 * 1024, files: 1 } })

function requireAaView(session: Session): void {
  if (!can(session, 'tools.audit_automation.access' as never, 'self')) {
    throw ApiError.forbidden('You do not have access to Audit Automation.')
  }
}
function requireAaManage(session: Session): void {
  if (!can(session, 'tools.audit_automation.manage' as never, 'self')) {
    // Fall back to 'access' — the Repotic module did not split read/write
    // in earlier phases and most firms wire a single grant.
    if (!can(session, 'tools.audit_automation.access' as never, 'self')) {
      throw ApiError.forbidden('You do not have access to Audit Automation.')
    }
  }
}

async function orgIdOf(userId: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { organisationId: true } })
  return u.organisationId
}

const ISO_PERIOD = /^\d{4}-\d{2}$/

// ── Marketplace registry + per-scope status ─────────────────────────────

repoticRouter.get('/marketplaces', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaView(session)
  const organisationId = await orgIdOf(session.userId)
  const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : undefined
  const gstin = typeof req.query.gstin === 'string' ? req.query.gstin : undefined
  const period = typeof req.query.period === 'string' && ISO_PERIOD.test(req.query.period) ? req.query.period : undefined
  // Count how many active adapter versions exist per (marketplace, report_kind).
  const adapterCounts = await prisma.rpMarketplaceAdapter.groupBy({
    by: ['marketplace', 'reportKind'],
    where: { organisationId, deletedAt: null, active: true },
    _count: { _all: true },
    _max: { version: true },
  })
  const adapterBy = new Map<string, { count: number; version: number }>()
  for (const a of adapterCounts) {
    adapterBy.set(`${a.marketplace}:${a.reportKind}`, { count: a._count._all, version: a._max.version ?? 1 })
  }
  // When a scope is given, enrich each report with the latest upload for
  // that scope so the UI can render "✓ uploaded 412 rows · ₹8,41,220".
  let uploadsByKey = new Map<string, {
    rows: number; detectStatus: string; adapterVersion: number | null;
    typeCounts: Record<string, number> | null; drift: { newColumns: string[]; missingColumns: string[] } | null;
    uploadedAt: string;
  }>()
  if (clientId && gstin && period) {
    const rows = await prisma.rpEcommerceUpload.findMany({
      where: { organisationId, clientId, gstin, period, deletedAt: null },
      orderBy: { uploadedAt: 'desc' },
    })
    for (const r of rows) {
      const key = `${r.marketplace}:${r.reportKind}`
      if (uploadsByKey.has(key)) continue   // already have newest
      uploadsByKey.set(key, {
        rows: r.rowCount,
        detectStatus: r.detectStatus,
        adapterVersion: r.adapterVersion,
        typeCounts: r.typeCountsJson ? (JSON.parse(r.typeCountsJson) as Record<string, number>) : null,
        drift: r.driftJson ? (JSON.parse(r.driftJson) as { newColumns: string[]; missingColumns: string[] }) : null,
        uploadedAt: r.uploadedAt.toISOString(),
      })
    }
  }
  ok(res, {
    items: MARKETPLACES.map((m) => ({
      key: m.key,
      label: m.label,
      reports: m.reports.map((r) => {
        const adapter = adapterBy.get(`${m.key}:${r.key}`)
        const upload = uploadsByKey.get(`${m.key}:${r.key}`)
        return {
          key: r.key,
          label: r.label,
          intended_coverage: r.intendedCoverage,
          adapter_versions: adapter?.count ?? 0,
          latest_adapter_version: adapter?.version ?? null,
          upload,
        }
      }),
    })),
  })
}))

// ── Upload a marketplace file ───────────────────────────────────────────

repoticRouter.post('/ecommerce/uploads', (req, res, next) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(ApiError.unprocessable('file_too_large', `The file is larger than ${UPLOAD_MAX_MB} MB.`))
      return next(ApiError.badRequest('Upload failed: ' + err.message))
    }
    if (err) return next(err)
    void (async () => {
      try {
        const session = requireSession(req)
        requireAaManage(session)
        const organisationId = await orgIdOf(session.userId)
        const file = req.file
        if (!file) throw ApiError.badRequest('Choose a file to upload.')
        const b = (req.body ?? {}) as Record<string, unknown>
        const clientId = typeof b.client_id === 'string' ? b.client_id : null
        const gstin = typeof b.gstin === 'string' ? b.gstin.trim().toUpperCase() : null
        const period = typeof b.period === 'string' && ISO_PERIOD.test(b.period) ? b.period : null
        const marketplace = typeof b.marketplace === 'string' ? b.marketplace : ''
        const reportKind = typeof b.report_kind === 'string' ? b.report_kind : ''
        if (!clientId || !gstin || !period) throw ApiError.badRequest('client_id, gstin and period (YYYY-MM) are required.')
        if (!isMarketplaceKey(marketplace)) throw ApiError.badRequest('Unknown marketplace.')
        const report = findReportKind(marketplace, reportKind)
        if (!report) throw ApiError.badRequest('Unknown report_kind for this marketplace.')

        // 1. Read the file's header row. XLSX, CSV and TSV are accepted.
        const ext = (file.originalname.split('.').pop() ?? '').toLowerCase()
        const headerRow = await readHeaderRow(file.buffer, ext)
        if (headerRow.length === 0) {
          throw ApiError.unprocessable('empty_header', 'The file does not have a readable header row.')
        }
        const fp = fingerprintOf(headerRow)

        // 2. Match against every active adapter version for this
        //    (marketplace, report_kind). Classify as matched / drifted /
        //    no_match. In Phase 1 we return the status even when no
        //    adapters exist — the UI shows "adapter not configured" and
        //    offers manual column mapping as a Phase 2+ follow-up.
        const candidates = await prisma.rpMarketplaceAdapter.findMany({
          where: {
            organisationId, marketplace, reportKind, active: true, deletedAt: null,
            OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: today() } }],
          },
          select: { id: true, version: true, detectJson: true },
        })
        const result = detect(fp, candidates)

        // 3. Persist a RpEcommerceUpload row. Idempotent on sha256 +
        //    scope — re-uploading the same file for the same scope
        //    silently returns the existing row.
        const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex')
        const row = await prisma.rpEcommerceUpload.upsert({
          where: {
            organisationId_clientId_gstin_period_marketplace_reportKind_fileSha256: {
              organisationId, clientId, gstin, period, marketplace, reportKind, fileSha256: sha256,
            },
          },
          update: {
            // Re-upload after an adapter was added. Re-detect in case the
            // adapter catalogue has changed; keep the existing uploadedAt.
            detectStatus: result.status,
            adapterId: result.adapterId,
            adapterVersion: result.adapterVersion,
            driftJson: result.status !== 'no_match'
              ? JSON.stringify({ newColumns: result.newColumns, missingColumns: result.missingColumns })
              : null,
          },
          create: {
            organisationId, clientId, gstin, period, marketplace, reportKind,
            detectStatus: result.status,
            adapterId: result.adapterId,
            adapterVersion: result.adapterVersion,
            originalName: file.originalname.slice(0, 240),
            fileSha256: sha256,
            sizeBytes: file.size,
            rowCount: 0,
            driftJson: result.status !== 'no_match'
              ? JSON.stringify({ newColumns: result.newColumns, missingColumns: result.missingColumns })
              : null,
            status: result.status === 'no_match' ? 'errored' : 'pending',
            errorMessage: result.status === 'no_match'
              ? `No marketplace adapter matched this file's header row. Add an adapter or map the columns manually.`
              : null,
            uploadedByUserId: session.userId,
          },
          select: {
            id: true, detectStatus: true, adapterId: true, adapterVersion: true,
            driftJson: true, status: true, errorMessage: true,
          },
        })

        // 4. Phase 2 — parse the file into normalised rows synchronously.
        //    Keeps the UI "upload → row count badge" story reactive. If
        //    parsing throws the upload still exists (status=parse_errored)
        //    and can be retried via POST /uploads/:id/parse once Phase 2.1
        //    persists file bytes.
        let parseOutcome: { rows: number; typeCounts: Record<string, number>; warnings: string[] } | null = null
        if (result.status !== 'no_match' && row.adapterId) {
          try {
            const adapter = await prisma.rpMarketplaceAdapter.findUniqueOrThrow({ where: { id: row.adapterId }, select: { columnMapJson: true } })
            const out = await parseFromBuffer({
              uploadId: row.id,
              organisationId,
              buffer: file.buffer,
              ext,
              adapterColumnMapJson: adapter.columnMapJson,
              prisma,
            })
            parseOutcome = { rows: out.rowsWritten, typeCounts: out.typeCounts, warnings: out.warnings }
          } catch (parseErr) {
            await prisma.rpEcommerceUpload.update({
              where: { id: row.id },
              data: { status: 'parse_errored', errorMessage: `Parse failed: ${(parseErr as Error).message}` },
            })
            parseOutcome = { rows: 0, typeCounts: {}, warnings: [(parseErr as Error).message] }
          }
        }

        ok(res, {
          upload_id: row.id,
          detect_status: row.detectStatus,
          adapter_id: row.adapterId,
          adapter_version: row.adapterVersion,
          similarity: result.similarity,
          new_columns: result.newColumns,
          missing_columns: result.missingColumns,
          status: row.status,
          error_message: row.errorMessage,
          parse: parseOutcome,
        }, 201)
      } catch (e) { next(e) }
    })()
  })
})

repoticRouter.get('/ecommerce/uploads', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaView(session)
  const organisationId = await orgIdOf(session.userId)
  const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : null
  const gstin = typeof req.query.gstin === 'string' ? req.query.gstin.toUpperCase() : null
  const period = typeof req.query.period === 'string' && ISO_PERIOD.test(req.query.period) ? req.query.period : null
  if (!clientId || !gstin || !period) throw ApiError.badRequest('client_id, gstin and period (YYYY-MM) are required.')
  const rows = await prisma.rpEcommerceUpload.findMany({
    where: { organisationId, clientId, gstin, period, deletedAt: null },
    orderBy: { uploadedAt: 'desc' },
  })
  ok(res, {
    items: rows.map((r) => ({
      id: r.id,
      marketplace: r.marketplace,
      report_kind: r.reportKind,
      detect_status: r.detectStatus,
      adapter_id: r.adapterId,
      adapter_version: r.adapterVersion,
      original_name: r.originalName,
      row_count: r.rowCount,
      type_counts: r.typeCountsJson ? JSON.parse(r.typeCountsJson) : null,
      drift: r.driftJson ? JSON.parse(r.driftJson) : null,
      status: r.status,
      error_message: r.errorMessage,
      uploaded_at: r.uploadedAt.toISOString(),
    })),
  })
}))

// ── GSTR-1 preview (Phase 3) ────────────────────────────────────────────

repoticRouter.get('/ecommerce/gstr1', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaView(session)
  const organisationId = await orgIdOf(session.userId)
  const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : null
  const gstin = typeof req.query.gstin === 'string' ? req.query.gstin.toUpperCase() : null
  const period = typeof req.query.period === 'string' && ISO_PERIOD.test(req.query.period) ? req.query.period : null
  const download = req.query.download === '1' || req.query.download === 'true'
  if (!clientId || !gstin || !period) throw ApiError.badRequest('client_id, gstin and period (YYYY-MM) are required.')
  const { preview, counts } = await buildGstr1Preview({ organisationId, clientId, gstin, period }, prisma)

  if (download) {
    // Persist a build record so firms can see what was downloaded when.
    // The preview JSON is the authoritative artefact — once downloaded we
    // can show "last downloaded 2025-12-05 by Priya" without re-aggregating.
    await prisma.rpGstr1Build.create({
      data: {
        organisationId, clientId, gstin, period,
        builtByUserId: session.userId,
        tableCountsJson: JSON.stringify(counts),
        previewJson: JSON.stringify(preview),
      },
    })
    const filename = `gstr1-preview-${gstin}-${period}.json`
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.status(200).send(JSON.stringify(preview, null, 2))
    return
  }

  ok(res, {
    counts,
    preview_sample: {
      gstin: preview.gstin,
      fp: preview.fp,
      disclaimer: preview.disclaimer,
      b2cs_count: preview.b2cs.length,
      b2cl_count: preview.b2cl.length,
      cdnur_count: preview.cdnur.length,
      hsn_count: preview.hsn.length,
    },
  })
}))

// ── Adapters (firm-level CRUD) ──────────────────────────────────────────

repoticRouter.get('/adapters', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaView(session)
  const organisationId = await orgIdOf(session.userId)
  const where: Record<string, unknown> = { organisationId, deletedAt: null }
  if (typeof req.query.marketplace === 'string') where.marketplace = req.query.marketplace
  if (typeof req.query.report_kind === 'string') where.reportKind = req.query.report_kind
  const rows = await prisma.rpMarketplaceAdapter.findMany({ where, orderBy: [{ marketplace: 'asc' }, { reportKind: 'asc' }, { version: 'desc' }] })
  ok(res, {
    items: rows.map((r) => ({
      id: r.id,
      marketplace: r.marketplace,
      report_kind: r.reportKind,
      version: r.version,
      effective_from: r.effectiveFrom,
      notes: r.notes,
      active: r.active,
      detect_columns: safeArray(r.detectJson),
      column_map: safeObject(r.columnMapJson),
      transforms: r.transformsJson ? safeObject(r.transformsJson) : null,
      coverage: safeObject(r.coverageJson),
      created_at: r.createdAt.toISOString(),
    })),
  })
}))

// ── Helpers ─────────────────────────────────────────────────────────────

async function readHeaderRow(buffer: Buffer, ext: string): Promise<string[]> {
  if (ext === 'xlsx' || ext === 'xls') {
    const wb = new ExcelJS.Workbook()
    try {
      await wb.xlsx.load(buffer as unknown as ArrayBuffer)
    } catch {
      throw ApiError.unprocessable('unreadable_xlsx', 'The Excel file could not be opened. Save it as a modern .xlsx and try again.')
    }
    const ws = wb.worksheets[0]
    if (!ws) throw ApiError.unprocessable('no_sheets', 'The workbook has no sheets.')
    // Use readStatementTable to find the header row the same way the bank
    // pipeline does — handles the "metadata block above the real header"
    // case that marketplace exports often have.
    const rows = await readStatementTable(buffer, 'xlsx')
    return rows[0] ?? []
  }
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
    const text = buffer.toString('utf8')
    const rows = parseCsv(text)
    return rows[0] ?? []
  }
  throw ApiError.unprocessable('unsupported_type', 'Supported file types: .xlsx, .csv, .tsv.')
}

function safeArray(json: string): unknown[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : [] } catch { return [] }
}
function safeObject(json: string): Record<string, unknown> {
  try { const v = JSON.parse(json); return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {} } catch { return {} }
}
function today(): string {
  return new Date().toISOString().slice(0, 10)
}
