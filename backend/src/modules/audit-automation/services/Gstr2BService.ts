import crypto from 'node:crypto'
import type { Request } from 'express'
import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { writeAudit } from '../../../platform/audit.js'
import { aaStorage } from '../storage.js'
import { parseGstr2BJson } from '../parsers/gstr2bJson.js'
import { parseGstr2BExcel } from '../parsers/gstr2bExcel.js'
import type { ParsedFiling2B } from '../parsers/types.js'

/**
 * Upload + parse + persist a GSTR-2B filing.
 *
 * Format is auto-detected from magic bytes (leading `{` for JSON, `PK`
 * for XLSX). Per-(client, sha256) dedupe — a re-upload returns 409 with
 * the existing filing id, mirroring the Repotic pattern.
 */
export interface UploadFilingInput {
  session: Session
  organisationId: string
  clientId: string
  periodMonth: number
  periodYear: number
  originalFilename: string
  bytes: Buffer
  req?: Request
}

export interface UploadFilingResult {
  filing_id: string
  source_format: 'json' | 'excel'
  entry_count: number
  gstin: string | null
  generated_at: string | null
}

function detectFormat(bytes: Buffer, filename: string): 'json' | 'excel' | null {
  if (bytes.length >= 4) {
    const head = bytes.subarray(0, 4)
    if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'excel'
    if (head[0] === 0x7b /* { */ || head[0] === 0x5b /* [ */) return 'json'
  }
  const lower = filename.toLowerCase()
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'excel'
  return null
}

async function verifyClient(organisationId: string, clientId: string) {
  const c = await prisma.client.findFirst({ where: { id: clientId, organisationId, deletedAt: null } })
  if (!c) throw ApiError.notFound('No such client.')
}

export const Gstr2BService = {
  async upload(input: UploadFilingInput): Promise<UploadFilingResult> {
    await verifyClient(input.organisationId, input.clientId)
    if (input.bytes[0] === 0xd0 && input.bytes[1] === 0xcf) {
      throw ApiError.unprocessable('unsupported_type', 'Old Excel (.xls) files are not supported. Save it as .xlsx, or download the GSTR-2B JSON.')
    }
    const fmt = detectFormat(input.bytes, input.originalFilename)
    if (!fmt) throw ApiError.unprocessable('unsupported_type', 'Upload a GSTR-2B JSON or Excel file.')

    const fileSha256 = crypto.createHash('sha256').update(input.bytes).digest('hex')
    const existing = await prisma.aaGstFiling2B.findFirst({
      where: { clientId: input.clientId, fileSha256, ...alive },
      select: { id: true },
    })
    if (existing) {
      throw ApiError.conflict('duplicate_upload', 'This 2B file is already uploaded for this client.',
        { existing_filing_id: existing.id })
    }

    let parsed: ParsedFiling2B
    try {
      parsed = fmt === 'json' ? parseGstr2BJson(input.bytes) : await parseGstr2BExcel(input.bytes)
    } catch (err) {
      const code = (err as Error).message
      throw ApiError.unprocessable(code || 'parse_failed', 'Could not parse the GSTR-2B file.')
    }
    if (parsed.entries.length === 0) {
      throw ApiError.unprocessable('no_entries', 'The GSTR-2B file has no invoice entries.')
    }

    const filingId = crypto.randomUUID()
    const storageKey = `${input.organisationId}/${input.clientId}/gst/2b/${filingId}/original.${fmt === 'json' ? 'json' : 'xlsx'}`
    await aaStorage.put(storageKey, input.bytes)

    await prisma.aaGstFiling2B.create({
      data: {
        id: filingId,
        organisationId: input.organisationId,
        clientId: input.clientId,
        uploadedByUserId: input.session.userId,
        periodMonth: input.periodMonth,
        periodYear: input.periodYear,
        sourceFormat: fmt,
        originalFilename: input.originalFilename,
        fileSize: input.bytes.length,
        fileSha256,
        storagePath: storageKey,
        gstin: parsed.gstin ?? null,
        generatedAt: parsed.generatedAt ? new Date(parsed.generatedAt + 'T00:00:00Z') : null,
      },
    })

    // Bulk-insert entries. Chunk to keep SQLite happy on very large filings.
    const CHUNK = 500
    for (let i = 0; i < parsed.entries.length; i += CHUNK) {
      const slice = parsed.entries.slice(i, i + CHUNK)
      await prisma.aaGstFiling2BEntry.createMany({
        data: slice.map((e) => ({
          filingId,
          section: e.section ?? 'b2b',
          supplierGstin: e.supplierGstin,
          supplierName: e.supplierName ?? null,
          invoiceNumber: e.invoiceNumber,
          invoiceDate: e.invoiceDate,
          taxableValue: e.taxableValue,
          igst: e.igst,
          cgst: e.cgst,
          sgst: e.sgst,
          cess: e.cess,
          itcAvailable: e.itcAvailable ?? true,
          docType: e.docType ?? 'INV',
          invoiceValue: e.invoiceValue ?? null,
          reverseCharge: e.reverseCharge ?? false,
          originalInvoiceNumber: e.originalInvoiceNumber ?? null,
          itcReason: e.itcReason ?? null,
          rawJson: e.rawJson ?? null,
        })),
      })
    }

    await writeAudit({
      actorUserId: input.session.userId,
      action: 'aa.gst.2b_uploaded',
      entityType: 'AaGstFiling2B',
      entityId: filingId,
      after: {
        client_id: input.clientId, source_format: fmt,
        period_month: input.periodMonth, period_year: input.periodYear,
        entry_count: parsed.entries.length, sha256: fileSha256,
      },
      req: input.req,
    })

    return {
      filing_id: filingId,
      source_format: fmt,
      entry_count: parsed.entries.length,
      gstin: parsed.gstin ?? null,
      generated_at: parsed.generatedAt ?? null,
    }
  },

  /** Delete an uploaded 2B (not while a reconciliation uses it); its hash is released for re-upload. */
  async remove(session: { userId: string }, organisationId: string, filingId: string, req?: Request) {
    const f = await prisma.aaGstFiling2B.findFirst({ where: { id: filingId, organisationId, ...alive }, include: { _count: { select: { reconJobs: true } } } })
    if (!f) throw ApiError.notFound('No such 2B filing.')
    if (f._count.reconJobs) throw ApiError.conflict('in_use', 'Delete the reconciliations that use this GSTR-2B first.')
    await prisma.aaGstFiling2B.update({ where: { id: f.id }, data: { deletedAt: new Date(), fileSha256: `${f.fileSha256}:deleted:${f.id}` } })
    await aaStorage.delete(f.storagePath).catch(() => undefined)
    await writeAudit({ actorUserId: session.userId, action: 'aa.gst.2b_deleted', entityType: 'AaGstFiling2B', entityId: f.id, after: { filename: f.originalFilename }, req })
  },

  async listForClient(clientId: string, organisationId: string) {
    const rows = await prisma.aaGstFiling2B.findMany({
      where: { clientId, organisationId, ...alive },
      orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }, { createdAt: 'desc' }],
      include: { _count: { select: { entries: true } } },
    })
    return rows.map((r) => ({
      id: r.id,
      period_month: r.periodMonth,
      period_year: r.periodYear,
      source_format: r.sourceFormat,
      original_filename: r.originalFilename,
      gstin: r.gstin,
      generated_at: r.generatedAt?.toISOString() ?? null,
      entry_count: r._count.entries,
      created_at: r.createdAt.toISOString(),
    }))
  },
}
