import crypto from 'node:crypto'
import type { Request } from 'express'
import { Prisma } from '@prisma/client'
import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { writeAudit } from '../../../platform/audit.js'
import { aaStorage } from '../storage.js'
import { parseTdsBooksExcel, previewTdsBooks, type TdsBooksPreview } from '../parsers/tdsBooksExcel.js'
import { parseTdsBooksTallyXml } from '../parsers/tdsBooksTallyXml.js'
import { ayOfDate, fyLabel, type ParsedTdsBooks, type TdsBooksColumnMap } from '../parsers/tdsTypes.js'

/**
 * The client's own TDS receivable — a Tally XML voucher export, or an
 * Excel register mapped column by column. An Excel file is read twice:
 * once for a preview (nothing stored), then with the column map.
 */

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
  /** Entries dated outside the FY of the chosen AY. */
  out_of_year?: number
  /** Entries without a TAN — matched to 26AS by deductor name. */
  without_tan?: number
}

function detectFormat(bytes: Buffer, filename: string): TdsBooksFormat | null {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'excel'
  const head = bytes.subarray(0, 512).toString('utf8').replace(/^﻿/, '').trimStart()
  if (head.startsWith('<')) return 'tally_xml'
  if (/\.xml$/i.test(filename)) return 'tally_xml'
  return null
}

async function verifyClient(orgId: string, clientId: string) {
  const c = await prisma.client.findFirst({ where: { id: clientId, organisationId: orgId, deletedAt: null } })
  if (!c) throw ApiError.notFound('No such client.')
}

const PARSE_MESSAGES: Record<string, string> = {
  tds_books_tally_xml_invalid: "This isn't a readable Tally XML export.",
  tds_books_excel_invalid: "This Excel file couldn't be read.",
  tds_books_excel_empty: 'This Excel file has no sheets.',
  tds_books_column_map_incomplete: 'Map the deductor (TAN or name), the TDS amount and the date before continuing.',
}

export const TdsBooksService = {
  async upload(input: UploadTdsBooksInput): Promise<UploadTdsBooksResult> {
    await verifyClient(input.organisationId, input.clientId)
    const fmt = detectFormat(input.bytes, input.originalFilename)
    if (!fmt) {
      throw ApiError.unprocessable('unsupported_type', /\.xls$/i.test(input.originalFilename)
        ? 'Old .xls files cannot be read — save it as .xlsx and upload again.'
        : 'Upload the TDS receivable as Excel (.xlsx) or a Tally XML export.')
    }

    const fileSha256 = crypto.createHash('sha256').update(input.bytes).digest('hex')
    const existing = await prisma.aaTdsBooks.findFirst({ where: { clientId: input.clientId, fileSha256, ...alive }, select: { id: true } })
    if (existing) throw ApiError.conflict('duplicate_upload', 'This TDS book is already uploaded for this client.', { existing_books_id: existing.id })

    let parsed: ParsedTdsBooks
    try {
      if (fmt === 'excel' && !input.columnMap) {
        return { books_id: null, source_format: 'excel', preview: await previewTdsBooks(input.bytes) }
      }
      parsed = fmt === 'excel' ? await parseTdsBooksExcel(input.bytes, input.columnMap!) : parseTdsBooksTallyXml(input.bytes)
    } catch (err) {
      const raw = (err as Error).message || ''
      const code = /^[a-z0-9_]+$/.test(raw) ? raw : 'parse_failed'
      if (code === 'parse_failed') console.error('[aa] TDS books parse failed:', err)
      throw ApiError.unprocessable(code, PARSE_MESSAGES[code] ?? 'Could not read the TDS book.')
    }
    if (parsed.entries.length === 0) {
      throw ApiError.unprocessable('no_entries', fmt === 'tally_xml'
        ? 'No TDS receivable entries were found. Export the vouchers (receipts / journals) that debit a TDS receivable ledger.'
        : 'No TDS entries were found with this column mapping.')
    }

    const booksId = crypto.randomUUID()
    const storageKey = `${input.organisationId}/${input.clientId}/tds/books/${booksId}/original.${fmt === 'excel' ? 'xlsx' : 'xml'}`
    await aaStorage.put(storageKey, input.bytes)
    try {
      await prisma.$transaction(async (tx) => {
        await tx.aaTdsBooks.create({
          data: {
            id: booksId, organisationId: input.organisationId, clientId: input.clientId, uploadedByUserId: input.session.userId,
            assessmentYear: input.assessmentYear, sourceFormat: fmt, originalFilename: input.originalFilename,
            fileSize: input.bytes.length, fileSha256, storagePath: storageKey,
            columnMapJson: input.columnMap ? JSON.stringify(input.columnMap) : null,
          },
        })
        for (let i = 0; i < parsed.entries.length; i += 500) {
          await tx.aaTdsBooksEntry.createMany({
            data: parsed.entries.slice(i, i + 500).map((e) => ({
              booksId, section: e.section, deductorTan: e.deductorTan, deductorName: e.deductorName ?? null,
              quarter: e.quarter, amountPaid: e.amountPaid, tdsAmount: e.tdsAmount, tdsDate: e.tdsDate,
              glCode: e.glCode ?? null, reference: e.reference ?? null, voucherType: e.voucherType ?? null, rawJson: e.rawJson ?? null,
            })),
          })
        }
      }, { timeout: 60_000 })
    } catch (err) {
      await aaStorage.delete(storageKey).catch(() => undefined)
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw ApiError.conflict('duplicate_upload', 'This TDS book is already uploaded for this client.')
      }
      throw err
    }

    const outOfYear = parsed.entries.filter((e) => e.tdsDate && ayOfDate(e.tdsDate) !== input.assessmentYear).length
    const withoutTan = parsed.entries.filter((e) => !e.deductorTan).length
    await writeAudit({
      actorUserId: input.session.userId, action: 'aa.tds.books_uploaded', entityType: 'AaTdsBooks', entityId: booksId,
      after: { client_id: input.clientId, source_format: fmt, assessment_year: input.assessmentYear, entry_count: parsed.entries.length, sha256: fileSha256 },
      req: input.req,
    })
    return { books_id: booksId, source_format: fmt, entry_count: parsed.entries.length, out_of_year: outOfYear, without_tan: withoutTan }
  },

  async listForClient(clientId: string, organisationId: string) {
    const rows = await prisma.aaTdsBooks.findMany({
      where: { clientId, organisationId, ...alive },
      orderBy: [{ assessmentYear: 'desc' }, { createdAt: 'desc' }],
      include: { _count: { select: { entries: true, reconJobs: true } } },
    })
    return rows.map((r) => ({
      id: r.id, assessment_year: r.assessmentYear, financial_year: fyLabel(r.assessmentYear), source_format: r.sourceFormat,
      original_filename: r.originalFilename, entry_count: r._count.entries, in_use: r._count.reconJobs, created_at: r.createdAt.toISOString(),
    }))
  },

  /** Delete an uploaded TDS book (not while a reconciliation uses it); its hash is released for re-upload. */
  async remove(session: Session, organisationId: string, booksId: string, req?: Request) {
    const b = await prisma.aaTdsBooks.findFirst({ where: { id: booksId, organisationId, ...alive }, include: { _count: { select: { reconJobs: true } } } })
    if (!b) throw ApiError.notFound('No such TDS book.')
    if (b._count.reconJobs) throw ApiError.conflict('in_use', 'Delete the reconciliations that use this TDS book first.')
    await prisma.aaTdsBooks.update({ where: { id: b.id }, data: { deletedAt: new Date(), fileSha256: `${b.fileSha256}:deleted:${b.id}` } })
    await aaStorage.delete(b.storagePath).catch(() => undefined)
    await writeAudit({ actorUserId: session.userId, action: 'aa.tds.books_deleted', entityType: 'AaTdsBooks', entityId: b.id, after: { filename: b.originalFilename }, req })
  },
}
