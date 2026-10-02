import crypto from 'node:crypto'
import type { Request } from 'express'
import { Prisma } from '@prisma/client'
import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { writeAudit } from '../../../platform/audit.js'
import { aaStorage } from '../storage.js'
import { parseTds26ASText, parseTds26ASPdf } from '../parsers/tds26ASText.js'
import { parseTds26ASExcel } from '../parsers/tds26ASExcel.js'
import { ayLabel, fyLabel, ayOfDate, type ParsedTds26AS } from '../parsers/tdsTypes.js'
import { inspectPdf, PasswordRequiredError, WrongPasswordError, UnreadablePdfError } from '../lib/pdfInspect.js'

/**
 * Form 26AS uploads — the TRACES text download, the TRACES PDF (usually
 * password-protected with the assessee's date of birth) or an Excel copy.
 *
 * A PDF password is used to decrypt in memory and dropped; only the file
 * as uploaded is stored, and the audit log records that it was unlocked,
 * never the password. The AY printed in the 26AS must agree with the AY
 * chosen for the upload.
 */

export type Tds26ASFormat = 'text' | 'excel' | 'pdf'

export interface Upload26ASInput {
  session: Session
  organisationId: string
  clientId: string
  assessmentYear: number
  originalFilename: string
  bytes: Buffer
  password?: string
  authorised?: boolean
  req?: Request
}
export interface Upload26ASResult {
  filing_id: string
  source_format: Tds26ASFormat
  entry_count: number
  pan: string | null
  assessment_year: number
  financial_year: string | null
  assessee_name: string | null
  generated_at: string | null
  /** Transactions dated outside the FY of the chosen AY. */
  out_of_year: number
  parts: Record<string, number>
}

function detectFormat(bytes: Buffer, filename: string): Tds26ASFormat | null {
  const lower = filename.toLowerCase()
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'excel'
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0xd0cf11e0) return null // legacy .xls
  if (lower.endsWith('.txt') || lower.endsWith('.csv')) return 'text'
  // Printable text with carets or PART headings.
  const head = bytes.subarray(0, 4096).toString('utf8')
  if (/\^|PART\s*[-–]?\s*(I|A)\b/i.test(head) && !/[\x00-\x08]/.test(head)) return 'text'
  return null
}

async function verifyClient(orgId: string, clientId: string) {
  const c = await prisma.client.findFirst({ where: { id: clientId, organisationId: orgId, deletedAt: null } })
  if (!c) throw ApiError.notFound('No such client.')
}

export const Tds26ASService = {
  async upload(input: Upload26ASInput): Promise<Upload26ASResult> {
    await verifyClient(input.organisationId, input.clientId)
    const fmt = detectFormat(input.bytes, input.originalFilename)
    if (!fmt) {
      throw ApiError.unprocessable('unsupported_type', /\.xls$/i.test(input.originalFilename)
        ? 'Old .xls files cannot be read — save it as .xlsx, or upload the TRACES text (.txt) or PDF.'
        : 'Upload Form 26AS as the TRACES text file (.txt), the TRACES PDF, or Excel (.xlsx).')
    }
    if (input.password && !input.authorised) {
      throw ApiError.unprocessable('authorisation_required', 'Confirm you are authorised to open this 26AS.')
    }

    const fileSha256 = crypto.createHash('sha256').update(input.bytes).digest('hex')
    const existing = await prisma.aaTds26AS.findFirst({ where: { clientId: input.clientId, fileSha256, ...alive }, select: { id: true } })
    if (existing) throw ApiError.conflict('duplicate_upload', 'This 26AS is already uploaded for this client.', { existing_filing_id: existing.id })

    let parsed: ParsedTds26AS
    let unlocked = false
    try {
      if (fmt === 'pdf') {
        let doc
        try {
          doc = await inspectPdf(input.bytes, input.password || undefined)
        } catch (err) {
          if (err instanceof PasswordRequiredError) throw ApiError.unprocessable('password_required', 'This 26AS PDF is password-protected. TRACES uses the date of birth / incorporation as DDMMYYYY.')
          if (err instanceof WrongPasswordError) throw ApiError.unprocessable('wrong_password', 'Incorrect password for this 26AS PDF.')
          if (err instanceof UnreadablePdfError) throw ApiError.unprocessable('unreadable', 'This PDF could not be read.')
          throw err
        }
        unlocked = doc.encrypted
        if (doc.textLayerBytes < 40) throw ApiError.unprocessable('no_text_layer', 'This 26AS is a scan with no text. Download the text or PDF version from TRACES.')
        parsed = parseTds26ASPdf(doc.pages)
      } else {
        parsed = fmt === 'text' ? parseTds26ASText(input.bytes) : await parseTds26ASExcel(input.bytes)
      }
    } catch (err) {
      if (err instanceof ApiError) throw err
      const raw = (err as Error).message || ''
      const code = /^[a-z0-9_]+$/.test(raw) ? raw : 'parse_failed'
      if (code === 'parse_failed') console.error('[aa] 26AS parse failed:', err)
      throw ApiError.unprocessable(code, 'Could not read this 26AS. Upload the text (.txt) or PDF download from TRACES.')
    }
    if (parsed.entries.length === 0) {
      throw ApiError.unprocessable('no_entries', 'No TDS or TCS credits were found in this 26AS (Parts I–VI). Check it is the Annual Tax Statement for this client.')
    }
    if (parsed.assessmentYear && parsed.assessmentYear !== input.assessmentYear) {
      throw ApiError.unprocessable('ay_mismatch',
        `This 26AS is for AY ${ayLabel(parsed.assessmentYear)} (FY ${fyLabel(parsed.assessmentYear)}), not AY ${ayLabel(input.assessmentYear)}. Choose that year, or upload the right statement.`,
        { file_assessment_year: parsed.assessmentYear })
    }

    const filingId = crypto.randomUUID()
    const ext = fmt === 'text' ? 'txt' : fmt === 'excel' ? 'xlsx' : 'pdf'
    const storageKey = `${input.organisationId}/${input.clientId}/tds/26as/${filingId}/original.${ext}`
    await aaStorage.put(storageKey, input.bytes)
    try {
      await prisma.$transaction(async (tx) => {
        await tx.aaTds26AS.create({
          data: {
            id: filingId, organisationId: input.organisationId, clientId: input.clientId, uploadedByUserId: input.session.userId,
            pan: parsed.pan ?? null, assessmentYear: input.assessmentYear, sourceFormat: fmt,
            originalFilename: input.originalFilename, fileSize: input.bytes.length, fileSha256, storagePath: storageKey,
            tracesGeneratedAt: parsed.generatedAt ? new Date(parsed.generatedAt + 'T00:00:00Z') : null,
            financialYear: parsed.financialYear ?? null, assesseeName: parsed.assesseeName ?? null,
          },
        })
        for (let i = 0; i < parsed.entries.length; i += 500) {
          await tx.aaTds26ASEntry.createMany({
            data: parsed.entries.slice(i, i + 500).map((e) => ({
              filingId, part: e.part ?? 'part_i', section: e.section, deductorTan: e.deductorTan, deductorName: e.deductorName ?? null,
              quarter: e.quarter, amountPaid: e.amountPaid, tdsAmount: e.tdsAmount, tdsDeposited: e.tdsDeposited ?? e.tdsAmount,
              tdsDate: e.tdsDate, status: e.status ?? null, bookingDate: e.bookingDate ?? null, remarks: e.remarks ?? null, rawJson: e.rawJson ?? null,
            })),
          })
        }
      }, { timeout: 60_000 })
    } catch (err) {
      await aaStorage.delete(storageKey).catch(() => undefined)
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw ApiError.conflict('duplicate_upload', 'This 26AS is already uploaded for this client.')
      }
      throw err
    }

    const parts: Record<string, number> = {}
    for (const e of parsed.entries) parts[e.part ?? 'part_i'] = (parts[e.part ?? 'part_i'] ?? 0) + 1
    const outOfYear = parsed.entries.filter((e) => e.tdsDate && ayOfDate(e.tdsDate) !== input.assessmentYear).length
    await writeAudit({
      actorUserId: input.session.userId, action: 'aa.tds.26as_uploaded', entityType: 'AaTds26AS', entityId: filingId,
      after: { client_id: input.clientId, source_format: fmt, assessment_year: input.assessmentYear, entry_count: parsed.entries.length, parts, sha256: fileSha256 },
      req: input.req,
    })
    if (unlocked) {
      await writeAudit({
        actorUserId: input.session.userId, action: 'aa.unlock_authorised', entityType: 'AaTds26AS', entityId: filingId,
        after: { client_id: input.clientId, filename: input.originalFilename, authorised: true }, req: input.req,
      })
    }

    return {
      filing_id: filingId, source_format: fmt, entry_count: parsed.entries.length, pan: parsed.pan ?? null,
      assessment_year: input.assessmentYear, financial_year: parsed.financialYear ?? fyLabel(input.assessmentYear),
      assessee_name: parsed.assesseeName ?? null, generated_at: parsed.generatedAt ?? null, out_of_year: outOfYear, parts,
    }
  },

  async listForClient(clientId: string, organisationId: string) {
    const rows = await prisma.aaTds26AS.findMany({
      where: { clientId, organisationId, ...alive },
      orderBy: [{ assessmentYear: 'desc' }, { createdAt: 'desc' }],
      include: { _count: { select: { entries: true, reconJobs: true } } },
    })
    return rows.map((r) => ({
      id: r.id, pan: r.pan, assessment_year: r.assessmentYear, financial_year: r.financialYear ?? fyLabel(r.assessmentYear),
      assessee_name: r.assesseeName, source_format: r.sourceFormat, original_filename: r.originalFilename,
      entry_count: r._count.entries, in_use: r._count.reconJobs, generated_at: r.tracesGeneratedAt?.toISOString() ?? null,
      created_at: r.createdAt.toISOString(),
    }))
  },

  /** Delete an uploaded 26AS (not while a reconciliation uses it); its hash is released for re-upload. */
  async remove(session: Session, organisationId: string, filingId: string, req?: Request) {
    const f = await prisma.aaTds26AS.findFirst({ where: { id: filingId, organisationId, ...alive }, include: { _count: { select: { reconJobs: true } } } })
    if (!f) throw ApiError.notFound('No such 26AS.')
    if (f._count.reconJobs) throw ApiError.conflict('in_use', 'Delete the reconciliations that use this 26AS first.')
    await prisma.aaTds26AS.update({ where: { id: f.id }, data: { deletedAt: new Date(), fileSha256: `${f.fileSha256}:deleted:${f.id}` } })
    await aaStorage.delete(f.storagePath).catch(() => undefined)
    await writeAudit({ actorUserId: session.userId, action: 'aa.tds.26as_deleted', entityType: 'AaTds26AS', entityId: f.id, after: { filename: f.originalFilename }, req })
  },
}
