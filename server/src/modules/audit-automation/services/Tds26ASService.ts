import crypto from 'node:crypto'
import type { Request } from 'express'
import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { writeAudit } from '../../../platform/audit.js'
import { aaStorage } from '../storage.js'
import { parseTds26ASText } from '../parsers/tds26ASText.js'
import { parseTds26ASExcel } from '../parsers/tds26ASExcel.js'
import type { ParsedTds26AS } from '../parsers/tdsTypes.js'

export interface Upload26ASInput {
  session: Session
  organisationId: string
  clientId: string
  assessmentYear: number
  originalFilename: string
  bytes: Buffer
  req?: Request
}
export interface Upload26ASResult {
  filing_id: string
  source_format: 'text' | 'excel'
  entry_count: number
  pan: string | null
  generated_at: string | null
}

function detectFormat(bytes: Buffer, filename: string): 'text' | 'excel' | null {
  if (bytes.length >= 4) {
    const head = bytes.subarray(0, 4)
    if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'excel'
  }
  const lower = filename.toLowerCase()
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'excel'
  if (lower.endsWith('.txt') || lower.endsWith('.csv')) return 'text'
  // Fall back: treat as text if it's printable
  const head = bytes.subarray(0, 256).toString('utf8')
  if (/[a-z0-9\s]/i.test(head)) return 'text'
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
    if (!fmt) throw ApiError.unprocessable('unsupported_type', 'Upload a Form 26AS text or Excel file.')

    const fileSha256 = crypto.createHash('sha256').update(input.bytes).digest('hex')
    const existing = await prisma.aaTds26AS.findFirst({
      where: { clientId: input.clientId, fileSha256, ...alive }, select: { id: true },
    })
    if (existing) throw ApiError.conflict('duplicate_upload', 'This 26AS is already uploaded for this client.',
      { existing_filing_id: existing.id })

    let parsed: ParsedTds26AS
    try {
      parsed = fmt === 'text' ? parseTds26ASText(input.bytes) : await parseTds26ASExcel(input.bytes)
    } catch (err) {
      throw ApiError.unprocessable((err as Error).message || 'parse_failed', 'Could not parse the 26AS file.')
    }
    if (parsed.entries.length === 0) throw ApiError.unprocessable('no_entries', 'The 26AS has no TDS entries.')

    const filingId = crypto.randomUUID()
    const storageKey = `${input.organisationId}/${input.clientId}/tds/26as/${filingId}/original.${fmt === 'text' ? 'txt' : 'xlsx'}`
    await aaStorage.put(storageKey, input.bytes)

    await prisma.aaTds26AS.create({
      data: {
        id: filingId,
        organisationId: input.organisationId,
        clientId: input.clientId,
        uploadedByUserId: input.session.userId,
        pan: parsed.pan ?? null,
        assessmentYear: input.assessmentYear,
        sourceFormat: fmt,
        originalFilename: input.originalFilename,
        fileSize: input.bytes.length,
        fileSha256,
        storagePath: storageKey,
        tracesGeneratedAt: parsed.generatedAt ? new Date(parsed.generatedAt + 'T00:00:00Z') : null,
      },
    })

    const CHUNK = 500
    for (let i = 0; i < parsed.entries.length; i += CHUNK) {
      const slice = parsed.entries.slice(i, i + CHUNK)
      await prisma.aaTds26ASEntry.createMany({
        data: slice.map((e) => ({
          filingId,
          part: e.part ?? 'part_a',
          section: e.section,
          deductorTan: e.deductorTan,
          deductorName: e.deductorName ?? null,
          quarter: e.quarter,
          amountPaid: e.amountPaid,
          tdsAmount: e.tdsAmount,
          tdsDate: e.tdsDate,
          status: e.status ?? null,
          rawJson: e.rawJson ?? null,
        })),
      })
    }

    await writeAudit({
      actorUserId: input.session.userId,
      action: 'aa.tds.26as_uploaded',
      entityType: 'AaTds26AS',
      entityId: filingId,
      after: {
        client_id: input.clientId, source_format: fmt,
        assessment_year: input.assessmentYear, entry_count: parsed.entries.length,
        sha256: fileSha256,
      },
      req: input.req,
    })

    return {
      filing_id: filingId,
      source_format: fmt,
      entry_count: parsed.entries.length,
      pan: parsed.pan ?? null,
      generated_at: parsed.generatedAt ?? null,
    }
  },

  async listForClient(clientId: string, organisationId: string) {
    const rows = await prisma.aaTds26AS.findMany({
      where: { clientId, organisationId, ...alive },
      orderBy: [{ assessmentYear: 'desc' }, { createdAt: 'desc' }],
      include: { _count: { select: { entries: true } } },
    })
    return rows.map((r) => ({
      id: r.id,
      pan: r.pan,
      assessment_year: r.assessmentYear,
      source_format: r.sourceFormat,
      original_filename: r.originalFilename,
      entry_count: r._count.entries,
      generated_at: r.tracesGeneratedAt?.toISOString() ?? null,
      created_at: r.createdAt.toISOString(),
    }))
  },
}
