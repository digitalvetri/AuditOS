import crypto from 'node:crypto'
import type { Request } from 'express'
import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { writeAudit } from '../../../platform/audit.js'
import { aaStorage } from '../storage.js'
import {
  parseTdsBooksExcel, previewTdsBooks, type TdsBooksPreview,
} from '../parsers/tdsBooksExcel.js'
import { parseTdsBooksTallyXml } from '../parsers/tdsBooksTallyXml.js'
import type { TdsBooksColumnMap } from '../parsers/tdsTypes.js'

export type TdsBooksFormat = 'excel' | 'tally_xml'

export interface UploadTdsBooksInput {
  session: Session
  organisationId: string
  clientId: string
  assessmentYear: number
  originalFilename: string
  bytes: Buffer
  columnMap?: TdsBooksColumnMap
  req?: Request
}
export interface UploadTdsBooksResult {
  books_id: string | null
  source_format: TdsBooksFormat
  preview?: TdsBooksPreview
  entry_count?: number
}

function detectFormat(bytes: Buffer, filename: string): TdsBooksFormat | null {
  if (bytes.length >= 4) {
    const head = bytes.subarray(0, 4)
    if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'excel'
    if (head[0] === 0x3c) return 'tally_xml'
  }
  const lower = filename.toLowerCase()
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'excel'
  if (lower.endsWith('.xml')) return 'tally_xml'
  return null
}

async function verifyClient(orgId: string, clientId: string) {
  const c = await prisma.client.findFirst({ where: { id: clientId, organisationId: orgId, deletedAt: null } })
  if (!c) throw ApiError.notFound('No such client.')
}

export const TdsBooksService = {
  async upload(input: UploadTdsBooksInput): Promise<UploadTdsBooksResult> {
    await verifyClient(input.organisationId, input.clientId)
    const fmt = detectFormat(input.bytes, input.originalFilename)
    if (!fmt) throw ApiError.unprocessable('unsupported_type', 'Upload a TDS book as Excel or Tally XML.')

    const fileSha256 = crypto.createHash('sha256').update(input.bytes).digest('hex')
    const existing = await prisma.aaTdsBooks.findFirst({
      where: { clientId: input.clientId, fileSha256, ...alive }, select: { id: true },
    })
    if (existing) throw ApiError.conflict('duplicate_upload', 'This TDS book is already uploaded for this client.',
      { existing_books_id: existing.id })

    if (fmt === 'excel' && !input.columnMap) {
      const preview = await previewTdsBooks(input.bytes)
      const scratchKey = `${input.organisationId}/${input.clientId}/tds/books-scratch/${fileSha256}.xlsx`
      await aaStorage.put(scratchKey, input.bytes)
      return { books_id: null, source_format: 'excel', preview }
    }

    const parsed = fmt === 'excel'
      ? await parseTdsBooksExcel(input.bytes, input.columnMap!)
      : parseTdsBooksTallyXml(input.bytes)
    if (parsed.entries.length === 0) throw ApiError.unprocessable('no_entries', 'The TDS book has no entries.')

    const booksId = crypto.randomUUID()
    const storageKey = `${input.organisationId}/${input.clientId}/tds/books/${booksId}/original.${fmt === 'excel' ? 'xlsx' : 'xml'}`
    await aaStorage.put(storageKey, input.bytes)

    await prisma.aaTdsBooks.create({
      data: {
        id: booksId,
        organisationId: input.organisationId,
        clientId: input.clientId,
        uploadedByUserId: input.session.userId,
        assessmentYear: input.assessmentYear,
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
      await prisma.aaTdsBooksEntry.createMany({
        data: slice.map((e) => ({
          booksId,
          section: e.section,
          deductorTan: e.deductorTan,
          deductorName: e.deductorName ?? null,
          quarter: e.quarter,
          amountPaid: e.amountPaid,
          tdsAmount: e.tdsAmount,
          tdsDate: e.tdsDate,
          glCode: e.glCode ?? null,
          rawJson: e.rawJson ?? null,
        })),
      })
    }

    await writeAudit({
      actorUserId: input.session.userId,
      action: 'aa.tds.books_uploaded',
      entityType: 'AaTdsBooks',
      entityId: booksId,
      after: {
        client_id: input.clientId, source_format: fmt,
        assessment_year: input.assessmentYear, entry_count: parsed.entries.length,
        sha256: fileSha256,
      },
      req: input.req,
    })

    return { books_id: booksId, source_format: fmt, entry_count: parsed.entries.length }
  },

  async listForClient(clientId: string, organisationId: string) {
    const rows = await prisma.aaTdsBooks.findMany({
      where: { clientId, organisationId, ...alive },
      orderBy: [{ assessmentYear: 'desc' }, { createdAt: 'desc' }],
      include: { _count: { select: { entries: true } } },
    })
    return rows.map((r) => ({
      id: r.id,
      assessment_year: r.assessmentYear,
      source_format: r.sourceFormat,
      original_filename: r.originalFilename,
      entry_count: r._count.entries,
      created_at: r.createdAt.toISOString(),
    }))
  },
}
