import crypto from 'node:crypto'
import type { Request } from 'express'
import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { writeAudit } from '../../../platform/audit.js'
import { aaStorage } from '../storage.js'
import {
  parsePurchaseRegisterExcel,
  previewPurchaseRegister,
  type PurchaseRegisterPreview,
} from '../parsers/purchaseRegisterExcel.js'
import { parsePurchaseRegisterTallyXml } from '../parsers/purchaseRegisterTallyXml.js'
import type { PurchaseRegisterColumnMap } from '../parsers/types.js'

/**
 * Upload + parse + persist a Purchase Register.
 *
 * Format is auto-detected from magic bytes (PK for Excel, `<` for XML).
 * Excel uploads happen in two steps:
 *   1. Upload the file → server responds with a preview (first 10 rows)
 *      so the auditor can build the column map on the UI.
 *   2. Confirm the column map → server parses and persists entries.
 *
 * Tally XML uploads are one step (no column map needed).
 */

export type PurchaseRegisterFormat = 'excel' | 'tally_xml'

export interface UploadRegisterInput {
  session: Session
  organisationId: string
  clientId: string
  periodMonth: number
  periodYear: number
  originalFilename: string
  bytes: Buffer
  /** Required for Excel; ignored for Tally XML. */
  columnMap?: PurchaseRegisterColumnMap
  req?: Request
}

export interface UploadRegisterResult {
  register_id: string | null
  source_format: PurchaseRegisterFormat
  /** Excel first-upload response (no column map yet) — used for the mapping UI. */
  preview?: PurchaseRegisterPreview
  entry_count?: number
}

function detectFormat(bytes: Buffer, filename: string): PurchaseRegisterFormat | null {
  if (bytes.length >= 4) {
    const head = bytes.subarray(0, 4)
    if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'excel'
    // Tally XML often starts with <?xml or <ENVELOPE
    if (head[0] === 0x3c) return 'tally_xml'
  }
  const lower = filename.toLowerCase()
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'excel'
  if (lower.endsWith('.xml')) return 'tally_xml'
  return null
}

async function verifyClient(organisationId: string, clientId: string) {
  const c = await prisma.client.findFirst({ where: { id: clientId, organisationId, deletedAt: null } })
  if (!c) throw ApiError.notFound('No such client.')
}

export const PurchaseRegisterService = {
  async upload(input: UploadRegisterInput): Promise<UploadRegisterResult> {
    await verifyClient(input.organisationId, input.clientId)
    if (input.bytes[0] === 0xd0 && input.bytes[1] === 0xcf) {
      throw ApiError.unprocessable('unsupported_type', 'Old Excel (.xls) files are not supported. Save the register as .xlsx.')
    }
    const fmt = detectFormat(input.bytes, input.originalFilename)
    if (!fmt) throw ApiError.unprocessable('unsupported_type', 'Upload a Purchase Register as Excel or Tally XML.')

    const fileSha256 = crypto.createHash('sha256').update(input.bytes).digest('hex')
    const existing = await prisma.aaPurchaseRegister.findFirst({
      where: { clientId: input.clientId, fileSha256, ...alive },
      select: { id: true },
    })
    if (existing) {
      throw ApiError.conflict('duplicate_upload', 'This purchase register is already uploaded for this client.',
        { existing_register_id: existing.id })
    }

    // Excel + no columnMap = first step: a preview for the column mapping.
    // Step 2 sends the same file again with the map, so nothing is kept here.
    if (fmt === 'excel' && !input.columnMap) {
      try {
        const preview = await previewPurchaseRegister(input.bytes)
        return { register_id: null, source_format: 'excel', preview }
      } catch {
        throw ApiError.unprocessable('unreadable', "This Excel file couldn't be opened. Is it password-protected or damaged?")
      }
    }

    // Parse — a malformed file or an incomplete column map is the user's to fix, not a 500.
    let parsed: Awaited<ReturnType<typeof parsePurchaseRegisterExcel>>
    try {
      parsed = fmt === 'excel'
        ? await parsePurchaseRegisterExcel(input.bytes, input.columnMap!)
        : parsePurchaseRegisterTallyXml(input.bytes)
    } catch (err) {
      const raw = (err as Error).message || ''
      // Only our own short codes go back to the client; anything else is a parser bug.
      const code = /^[a-z0-9_]+$/.test(raw) ? raw : 'parse_failed'
      if (code === 'parse_failed') console.error('[aa] purchase register parse failed:', err)
      const msg: Record<string, string> = {
        pr_tally_xml_invalid: "This isn't a readable Tally XML export.",
        pr_excel_invalid: "This Excel file couldn't be read.",
      }
      throw ApiError.unprocessable(code, msg[code] ?? (/column/i.test(code) ? 'The column mapping is incomplete — map GSTIN, invoice number, date and taxable value.' : 'Could not read the purchase register.'))
    }
    if (parsed.entries.length === 0) {
      throw ApiError.unprocessable('no_entries', 'The purchase register has no invoice entries.')
    }

    const registerId = crypto.randomUUID()
    const storageKey = `${input.organisationId}/${input.clientId}/gst/pr/${registerId}/original.${fmt === 'excel' ? 'xlsx' : 'xml'}`
    await aaStorage.put(storageKey, input.bytes)

    await prisma.aaPurchaseRegister.create({
      data: {
        id: registerId,
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
        columnMapJson: input.columnMap ? JSON.stringify(input.columnMap) : null,
      },
    })

    const CHUNK = 500
    for (let i = 0; i < parsed.entries.length; i += CHUNK) {
      const slice = parsed.entries.slice(i, i + CHUNK)
      await prisma.aaPurchaseRegisterEntry.createMany({
        data: slice.map((e) => ({
          registerId,
          supplierGstin: e.supplierGstin,
          supplierName: e.supplierName ?? null,
          invoiceNumber: e.invoiceNumber,
          invoiceDate: e.invoiceDate,
          taxableValue: e.taxableValue,
          igst: e.igst,
          cgst: e.cgst,
          sgst: e.sgst,
          cess: e.cess,
          glCode: e.glCode ?? null,
          docType: e.docType ?? 'INV',
          invoiceValue: e.invoiceValue ?? null,
          reverseCharge: e.reverseCharge ?? false,
          rawJson: e.rawJson ?? null,
        })),
      })
    }

    await writeAudit({
      actorUserId: input.session.userId,
      action: 'aa.gst.pr_uploaded',
      entityType: 'AaPurchaseRegister',
      entityId: registerId,
      after: {
        client_id: input.clientId, source_format: fmt,
        period_month: input.periodMonth, period_year: input.periodYear,
        entry_count: parsed.entries.length, sha256: fileSha256,
      },
      req: input.req,
    })

    return {
      register_id: registerId,
      source_format: fmt,
      entry_count: parsed.entries.length,
    }
  },

  /** Delete an uploaded register (not while a reconciliation uses it); its hash is released for re-upload. */
  async remove(session: { userId: string }, organisationId: string, registerId: string, req?: Request) {
    const r = await prisma.aaPurchaseRegister.findFirst({ where: { id: registerId, organisationId, ...alive }, include: { _count: { select: { reconJobs: true } } } })
    if (!r) throw ApiError.notFound('No such purchase register.')
    if (r._count.reconJobs) throw ApiError.conflict('in_use', 'Delete the reconciliations that use this purchase register first.')
    await prisma.aaPurchaseRegister.update({ where: { id: r.id }, data: { deletedAt: new Date(), fileSha256: `${r.fileSha256}:deleted:${r.id}` } })
    await aaStorage.delete(r.storagePath).catch(() => undefined)
    await writeAudit({ actorUserId: session.userId, action: 'aa.gst.pr_deleted', entityType: 'AaPurchaseRegister', entityId: r.id, after: { filename: r.originalFilename }, req })
  },

  async listForClient(clientId: string, organisationId: string) {
    const rows = await prisma.aaPurchaseRegister.findMany({
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
      entry_count: r._count.entries,
      created_at: r.createdAt.toISOString(),
    }))
  },
}
