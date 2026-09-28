import type { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { prisma } from '../../lib/prisma.js'
import ExcelJS from 'exceljs'
import {
  previewWorkbook,
  saveMapping,
  listMappings,
  getMapping,
  isImportTarget,
  isMappableField,
  IMPORT_TARGETS,
  MAPPABLE_FIELDS,
  type ImportTarget,
  type MappableField,
} from './services/BookkeepingImportService.js'
import { buildLedgerSnapshot } from './services/BookkeepingLedgerSnapshot.js'
import { deriveBatch } from './engine/deriveVouchers.js'

/**
 * BOOKKEEPING · IMPORT MAPPING ROUTES (BOOKKEEPING-REBUILD §3.1).
 *
 * Mounted on the parent bookkeeping router — so every route below is
 * accessible as /api/bookkeeping/companies/:companyId/imports/...
 * Company-level authorisation is enforced by the tally.master.manage
 * permission the wizard already uses for masters and ledger rules; the
 * import is the same shape of "operator prepares data to post".
 */

const MAX_MB = 25
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
})

function requireImportRead(session: Session) {
  if (!can(session, 'tools.audit_automation.bookkeeping.master.read', 'self')) {
    throw ApiError.forbidden('You do not have permission to view import mappings.')
  }
}
function requireImportManage(session: Session) {
  if (!can(session, 'tools.audit_automation.bookkeeping.master.manage', 'self')) {
    throw ApiError.forbidden('You do not have permission to manage import mappings.')
  }
}

export function registerBookkeepingImportRoutes(router: Router): void {
  // POST /companies/:companyId/imports/preview — parse an uploaded workbook.
  // Returns every sheet with column letters, header row and 10 sample rows,
  // so the wizard can render the sheet picker + column-mapping table.
  router.post(
    '/companies/:companyId/imports/preview',
    (req, res, next) => {
      upload.single('file')(req, res, (err: unknown) => {
        if (!err) return next()
        const code = (err as { code?: string }).code
        if (code === 'LIMIT_FILE_SIZE') {
          return next(ApiError.unprocessable('too_large', `File is larger than ${MAX_MB} MB.`))
        }
        next(ApiError.badRequest('Upload could not be read.'))
      })
    },
    handler(async (req, res) => {
      const session = requireSession(req)
      requireImportManage(session)
      const file = req.file
      if (!file || file.size === 0) throw ApiError.unprocessable('empty', 'Choose a file to upload.')
      const preview = await previewWorkbook(file.buffer)
      ok(res, preview)
    }),
  )

  // GET /companies/:companyId/imports/mappings — list every saved mapping
  // for the company, so the wizard can show "you already have a mapping
  // for sales_register — pick it up or re-map?"
  router.get(
    '/companies/:companyId/imports/mappings',
    handler(async (req, res) => {
      const session = requireSession(req)
      requireImportRead(session)
      const items = await listMappings(prisma, req.params.companyId)
      ok(res, { items })
    }),
  )

  // GET /companies/:companyId/imports/mappings/:target
  router.get(
    '/companies/:companyId/imports/mappings/:target',
    handler(async (req, res) => {
      const session = requireSession(req)
      requireImportRead(session)
      if (!isImportTarget(req.params.target)) {
        throw ApiError.badRequest(`Target must be one of: ${IMPORT_TARGETS.join(', ')}.`)
      }
      const item = await getMapping(prisma, req.params.companyId, req.params.target)
      if (!item) throw ApiError.notFound('No saved mapping for that target yet.')
      ok(res, item)
    }),
  )

  const columnMapSchema = z.record(
    z.string().regex(/^[A-Z]+$/, 'Column keys must be Excel letters (A, B, ..., AA).'),
    z.enum(MAPPABLE_FIELDS as unknown as [MappableField, ...MappableField[]]),
  )

  // POST /companies/:companyId/imports/mappings — upsert.
  // One mapping per (company, target). Re-saving bumps version.
  router.post(
    '/companies/:companyId/imports/mappings',
    handler(async (req, res) => {
      const session = requireSession(req)
      requireImportManage(session)

      const body = z.object({
        sheet_name: z.string().min(1).max(200),
        target: z.enum(IMPORT_TARGETS as unknown as [ImportTarget, ...ImportTarget[]]),
        header_row: z.coerce.number().int().min(1).max(50).default(1),
        column_map: columnMapSchema,
        date_format: z.string().min(1).max(50).default('DD/MM/YYYY'),
        currency_aliases: z.record(z.string(), z.string()).default({}),
      }).safeParse(req.body)
      if (!body.success) throw ApiError.badRequest(body.error.issues[0]?.message ?? 'Invalid input.')

      // Guard against mapping fields that would collide with a column being
      // both "date" and "invoice_no" — one field per column, and the input
      // validator already enforces exactly one Date column.
      const usedFields = new Set<MappableField>()
      for (const field of Object.values(body.data.column_map)) {
        if (field === 'ignore') continue
        if (usedFields.has(field)) {
          throw ApiError.badRequest(`Two columns are mapped to "${field}". Pick a different target for one.`)
        }
        usedFields.add(field)
      }

      const saved = await saveMapping(
        prisma,
        req.params.companyId,
        {
          sheetName: body.data.sheet_name,
          target: body.data.target,
          headerRow: body.data.header_row,
          columnMap: body.data.column_map,
          dateFormat: body.data.date_format,
          currencyAliases: body.data.currency_aliases,
        },
        session.userId,
      )

      await writeAudit({
        actorUserId: session.userId,
        action: 'bookkeeping.import_mapping.save',
        entityType: 'bookkeeping_import_mapping',
        entityId: saved.id,
        after: {
          target: saved.target,
          sheetName: saved.sheetName,
          version: saved.version,
        },
        req,
      })
      ok(res, saved)
    }),
  )

  // POST /companies/:companyId/imports/derive
  //
  // Uses the saved mapping for the requested target, parses the uploaded
  // workbook's matching sheet, and returns a derived-voucher batch WITH
  // party proposals and per-row flags. Nothing is written to the ledger
  // — the preview screen (Step 3) commits.
  //
  // Body (multipart): `file`. Query: `target=sales_register|purchase_register|...`
  router.post(
    '/companies/:companyId/imports/derive',
    (req, res, next) => {
      upload.single('file')(req, res, (err: unknown) => {
        if (!err) return next()
        const code = (err as { code?: string }).code
        if (code === 'LIMIT_FILE_SIZE') {
          return next(ApiError.unprocessable('too_large', `File is larger than ${MAX_MB} MB.`))
        }
        next(ApiError.badRequest('Upload could not be read.'))
      })
    },
    handler(async (req, res) => {
      const session = requireSession(req)
      requireImportManage(session)

      const target = String(req.query.target ?? '')
      if (!isImportTarget(target)) {
        throw ApiError.badRequest(`target= must be one of: ${IMPORT_TARGETS.join(', ')}.`)
      }
      const file = req.file
      if (!file || file.size === 0) throw ApiError.unprocessable('empty', 'Choose a file to upload.')

      const mapping = await getMapping(prisma, req.params.companyId, target)
      if (!mapping) {
        throw ApiError.badRequest(
          `No saved mapping for ${target} yet — save one on the Import screen first.`,
        )
      }

      // Load only the sheet the mapping points at. If it's missing —
      // the client renamed the tab — say so specifically so the operator
      // knows to re-map, not "empty preview".
      const wb = new ExcelJS.Workbook()
      try {
        await wb.xlsx.load(file.buffer as unknown as ArrayBuffer)
      } catch {
        throw ApiError.badRequest('The workbook could not be read as .xlsx.')
      }
      const ws = wb.worksheets.find((s) => s.name === mapping.sheetName)
      if (!ws) {
        throw ApiError.badRequest(
          `The saved mapping points at sheet "${mapping.sheetName}" but that tab is not in this workbook. Re-map on the Import screen.`,
        )
      }

      // Read from headerRow + 1 to the end. ExcelJS is 1-indexed.
      const rows: string[][] = []
      const width = Math.min(ws.columnCount || 0, 200)
      for (let r = mapping.headerRow + 1; r <= ws.rowCount; r++) {
        const excelRow = ws.getRow(r)
        const vals: string[] = []
        for (let c = 1; c <= width; c++) vals.push(String(excelRow.getCell(c).text ?? '').trim())
        rows.push(vals)
      }

      const snapshot = await buildLedgerSnapshot(prisma, req.params.companyId)
      const columnMap = mapping.columnMapJson as Record<string, MappableField>
      const currencyAliases = mapping.currencyAliasesJson as Record<string, string>

      const batch = deriveBatch(rows, {
        target,
        columnMap,
        headerRow: mapping.headerRow,
        dateFormat: mapping.dateFormat,
        currencyAliases,
        ledgers: snapshot,
      })

      ok(res, batch)
    }),
  )
}
