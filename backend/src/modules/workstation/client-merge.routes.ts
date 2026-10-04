import fs from 'node:fs/promises'
import path from 'node:path'
import { Router } from 'express'
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib'
import sharp from 'sharp'
import { z } from 'zod'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { assertCanSeeClient, requireWorkstation } from '../../platform/workstation/scope.js'
import { renderPdf } from '../../platform/pdfBuffer.js'
import { streamInvoicePdf, INVOICE_PDF_INCLUDE } from '../invoice/pdf.js'
import { streamQuotationPdf, QUOTATION_PDF_INCLUDE } from '../quotation/pdf.js'
import { streamEngagementPdf } from '../engagement/pdf.js'
import { INCLUDE as ENGAGEMENT_INCLUDE } from '../engagement/service.js'
import { streamDocPdf } from '../docs/pdf.js'
import { INCLUDE as DOC_INCLUDE } from '../docs/service.js'
import { aaStorage } from '../audit-automation/storage.js'
import { bookkeepingImportStorage } from './bookkeepingImportStorage.js'
import { convertWithLibreOffice, withTempDir } from '../tools/lib/exec.js'
import { AA_FILE, has, readVersionBytes } from './client-folders.routes.js'
import { streamEInvoicePdf, streamEwayBillPdf, streamGstFilingPdf } from './record-pdf.js'

/**
 * MERGE — several of one client's documents, of any kind, as a single PDF.
 *
 *   POST /api/clients/:id/document-folders/merge
 *   { items: [{ source, ref }], title? }  →  application/pdf
 *
 * Each item becomes PDF pages in the order given:
 *   - generated documents (invoice, quotation, letters, e-way bill…) render
 *     exactly as their own Open link does;
 *   - PDFs are copied page for page, images get a page each;
 *   - Word / Excel / text files go through LibreOffice.
 * Anything that cannot be converted (a ZIP, a file never uploaded) gets a
 * placeholder page saying so, so the merged file never silently drops one.
 */
export const clientMergeRouter = Router()

const MAX_ITEMS = 50
const Body = z.object({
  items: z.array(z.object({ source: z.string().min(1).max(40), ref: z.string().min(1).max(100) }))
    .min(2, 'Choose at least two documents to merge.')
    .max(MAX_ITEMS, `Merge at most ${MAX_ITEMS} documents at a time.`),
  title: z.string().trim().max(200).optional(),
})

type Part = { label: string; pdf: Buffer | null; note?: string }

const OFFICE_EXT = new Set(['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'csv', 'txt', 'json', 'xml', 'ppt', 'pptx'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'tif', 'tiff', 'bmp'])

/** Any stored file → PDF bytes, or a reason it could not be converted. */
async function fileToPdf(bytes: Buffer, fileName: string): Promise<{ pdf: Buffer } | { note: string }> {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase()
  if (ext === 'pdf' || bytes.subarray(0, 5).toString() === '%PDF-') return { pdf: bytes }
  if (IMAGE_EXT.has(ext)) {
    try {
      const doc = await PDFDocument.create()
      const png = await sharp(bytes).rotate().png().toBuffer()
      const img = await doc.embedPng(png)
      // A4 portrait, image fitted inside 36pt margins.
      const page = doc.addPage([595.28, 841.89])
      const scale = Math.min((595.28 - 72) / img.width, (841.89 - 72) / img.height, 1)
      const w = img.width * scale
      const h = img.height * scale
      page.drawImage(img, { x: (595.28 - w) / 2, y: (841.89 - h) / 2, width: w, height: h })
      return { pdf: Buffer.from(await doc.save()) }
    } catch {
      return { note: 'The image could not be read.' }
    }
  }
  if (OFFICE_EXT.has(ext)) {
    try {
      return await withTempDir('merge', async (dir) => {
        const input = path.join(dir, `input.${ext}`)
        await fs.writeFile(input, bytes)
        const out = await convertWithLibreOffice(input, 'pdf', dir)
        return { pdf: await fs.readFile(out) }
      })
    } catch {
      return { note: `The ${ext.toUpperCase()} file could not be converted to PDF.` }
    }
  }
  if (ext === 'zip') return { note: 'ZIP archives cannot be merged — open the archive and upload its files instead.' }
  return { note: `.${ext || 'unknown'} files cannot be converted to PDF.` }
}

async function storedPart(label: string, fileName: string, bytes: Buffer | null): Promise<Part> {
  if (!bytes) return { label, pdf: null, note: 'The file is no longer in storage.' }
  const r = await fileToPdf(bytes, fileName)
  return 'pdf' in r ? { label, pdf: r.pdf } : { label, pdf: null, note: r.note }
}

const readOrNull = (p: Promise<Buffer>) => p.catch(() => null)

/** One selected item → its PDF, after the same checks its Open link makes. */
async function partFor(session: Session, clientId: string, source: string, ref: string): Promise<Part> {
  const where = { id: ref, clientId, ...alive }
  const deny = (label: string): Part => ({ label, pdf: null, note: 'You do not have access to this document.' })
  const gone = (label: string): Part => ({ label, pdf: null, note: 'This document no longer exists.' })

  switch (source) {
    case 'invoice': {
      if (!has(session, 'workstation.invoice.read')) return deny('Invoice')
      const inv = await prisma.invoice.findFirst({ where, include: INVOICE_PDF_INCLUDE })
      if (!inv) return gone('Invoice')
      return { label: `Invoice ${inv.invoiceNumber}`, pdf: await renderPdf((res) => streamInvoicePdf(res, inv)) }
    }
    case 'quotation': {
      if (!has(session, 'workstation.quotation.read')) return deny('Quotation')
      const q = await prisma.quotation.findFirst({ where, include: QUOTATION_PDF_INCLUDE })
      if (!q) return gone('Quotation')
      return { label: `Quotation ${q.quotationCode}`, pdf: await renderPdf((res) => streamQuotationPdf(res, q)) }
    }
    case 'engagement': {
      if (!has(session, 'workstation.engagement.read')) return deny('Engagement letter')
      const l = await prisma.engagementLetter.findFirst({ where, include: ENGAGEMENT_INCLUDE })
      if (!l) return gone('Engagement letter')
      return { label: `Engagement letter ${l.letterCode}`, pdf: await renderPdf((res) => streamEngagementPdf(res, l)) }
    }
    case 'wsdoc': {
      if (!has(session, 'workstation.doc.read')) return deny('Letter')
      const d = await prisma.workstationDoc.findFirst({ where, include: DOC_INCLUDE })
      if (!d) return gone('Letter')
      return { label: d.title, pdf: await renderPdf((res) => streamDocPdf(res, d)) }
    }
    case 'eway': {
      if (!has(session, 'workstation.eway.read', 'workstation.eway.generate')) return deny('E-way bill')
      const e = await prisma.ewayBill.findFirst({ where, include: { client: true } })
      if (!e) return gone('E-way bill')
      return { label: `E-way bill ${e.ewbNo}`, pdf: await renderPdf((res) => streamEwayBillPdf(res, e)) }
    }
    case 'einvoice': {
      if (!has(session, 'workstation.eway.read', 'workstation.eway.generate')) return deny('E-invoice')
      const e = await prisma.eInvoiceIrn.findFirst({ where, include: { client: true } })
      if (!e) return gone('E-invoice')
      return { label: `E-invoice ${e.documentNo}`, pdf: await renderPdf((res) => streamEInvoicePdf(res, e)) }
    }
    case 'gst_filing': {
      if (!has(session, 'workstation.gst.read', 'workstation.gst.manage')) return deny('GST return')
      const g = await prisma.gstFiling.findFirst({
        where: { id: ref, gstProfile: { clientId }, ...alive }, include: { gstProfile: { include: { client: true } } },
      })
      if (!g) return gone('GST return')
      return { label: `${g.returnType} ${g.period}`, pdf: await renderPdf((res) => streamGstFilingPdf(res, g)) }
    }
    case 'upload': {
      const v = await prisma.clientDocumentVersion.findFirst({
        where: { id: ref, document: { clientId, ...alive } }, include: { document: true },
      })
      if (!v) return gone('Document')
      const label = v.document.name
      if (!v.mimeType) return { label, pdf: null, note: 'The original file has not been uploaded yet.' }
      return storedPart(label, v.originalName ?? v.document.name, await readVersionBytes(v.fileKey))
    }
    case 'bk_import': {
      if (!has(session, 'workstation.service.read', 'workstation.service.manage')) return deny('Bookkeeping import')
      const b = await prisma.bookkeepingImport.findFirst({ where: { id: ref, clientId } })
      if (!b) return gone('Bookkeeping import')
      return storedPart(b.originalFilename, b.originalFilename, await readOrNull(bookkeepingImportStorage.get(b.storagePath)))
    }
    case 'aa_pr': case 'aa_2b': case 'aa_26as': case 'aa_tdsbooks': {
      if (!can(session, 'tools.audit_automation.access', 'self')) return deny('Imported file')
      const f = await AA_FILE[source](ref, clientId)
      if (!f) return gone('Imported file')
      return storedPart(f.originalFilename, f.originalFilename, await readOrNull(aaStorage.get(f.storagePath)))
    }
    default:
      return { label: source, pdf: null, note: 'This kind of document cannot be merged.' }
  }
}

// ── Page furniture ────────────────────────────────────────────────────────

const INK = rgb(0.07, 0.09, 0.15)
const MUTED = rgb(0.42, 0.45, 0.5)

/** Helvetica is WinAnsi — drop what it cannot draw rather than throw. */
const safe = (s: string) => s.replace(/[—–]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7e\xa0-\xff]/g, '')

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of safe(text).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = word } else line = next
  }
  if (line) out.push(line)
  return out
}

function placeholderPage(doc: PDFDocument, fonts: { reg: PDFFont; bold: PDFFont }, label: string, note: string) {
  const page = doc.addPage([595.28, 841.89])
  page.drawText(safe(label).slice(0, 80), { x: 48, y: 780, size: 16, font: fonts.bold, color: INK })
  let y = 750
  for (const l of wrap(`This document could not be included in the merged file. ${note}`, fonts.reg, 11, 499)) {
    page.drawText(l, { x: 48, y, size: 11, font: fonts.reg, color: MUTED })
    y -= 16
  }
}

/**
 * Merge items, each of which names its own client, into one PDF. Used by the
 * single-client merge and by the organization merge (items across several
 * clients). Every item goes through `partFor`, which re-checks the module
 * permission and that `ref` really belongs to that client; the CALLER must
 * already have checked each client is in the caller's scope.
 */
export async function mergeDocuments(
  session: Session, items: { clientId: string; source: string; ref: string }[], title: string,
): Promise<{ bytes: Buffer; pageCount: number; skipped: number }> {
  // Sequential: LibreOffice runs one conversion at a time anyway.
  const parts: Part[] = []
  for (const it of items) parts.push(await partFor(session, it.clientId, it.source, it.ref))

  const body = await PDFDocument.create()
  const bodyFonts = { reg: await body.embedFont(StandardFonts.Helvetica), bold: await body.embedFont(StandardFonts.HelveticaBold) }
  let skipped = 0
  for (const p of parts) {
    let note = p.note
    if (p.pdf) {
      try {
        const src = await PDFDocument.load(p.pdf, { ignoreEncryption: true })
        const pages = await body.copyPages(src, src.getPageIndices())
        pages.forEach((pg) => body.addPage(pg))
      } catch {
        note = 'The PDF is damaged or password-protected.'
      }
    }
    if (note) placeholderPage(body, bodyFonts, p.label, note)
    if (note) skipped++
  }

  body.setTitle(safe(title))
  body.setProducer('Audit OS')
  return { bytes: Buffer.from(await body.save()), pageCount: body.getPageCount(), skipped }
}

/** Send a merged PDF as a download. */
export function sendMergedPdf(res: import('express').Response, bytes: Buffer, fileName: string, skipped: number) {
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
  res.setHeader('X-Merged-Skipped', String(skipped))
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Merged-Skipped')
  res.send(bytes)
}

clientMergeRouter.post('/:id/document-folders/merge', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.read', 'workstation.document.manage')
  const clientId = req.params.id
  await assertCanSeeClient(session, scope, clientId)

  const parsed = Body.safeParse(req.body)
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid request.')
  const client = await prisma.client.findFirst({ where: { id: clientId, ...alive } })
  if (!client) throw ApiError.notFound('Client not found.')

  const title = parsed.data.title || 'Combined documents'
  const { bytes, pageCount, skipped } = await mergeDocuments(
    session, parsed.data.items.map((it) => ({ clientId, ...it })), `${title} - ${client.companyName}`,
  )
  await writeAudit({
    actorUserId: session.userId, action: 'client_document.merge', entityType: 'Client', entityId: clientId,
    after: { items: parsed.data.items, pages: pageCount, skipped }, req,
  })

  sendMergedPdf(res, bytes, `${client.clientCode}-combined-${new Date().toISOString().slice(0, 10)}.pdf`, skipped)
}))
