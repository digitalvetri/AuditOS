import { Router } from 'express'
import { ApiError, handler } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import type { Request } from 'express'
import { verifyLinkToken } from '../platform/signedUrl.js'
import { writeAudit } from '../platform/audit.js'
import { employeeDocStorage } from './documents.storage.js'
import { streamPayslipPdf } from './payroll/pdf.js'
import { streamQuotationPdf, QUOTATION_PDF_INCLUDE } from './quotation/pdf.js'
import { streamInvoicePdf, INVOICE_PDF_INCLUDE } from './invoice/pdf.js'
import { streamEngagementPdf } from './engagement/pdf.js'
import { INCLUDE as ENGAGEMENT_INCLUDE } from './engagement/service.js'
import { streamDocPdf } from './docs/pdf.js'
import { INCLUDE as DOC_INCLUDE } from './docs/service.js'

/**
 * SIGNED-URL BYTE ENDPOINTS.
 *
 * These are the only routes under /api that are NOT behind `authenticate`,
 * and that is deliberate: a signed URL carries its own authorization. The
 * HMAC binds the resource, the subject who requested it and an expiry, so the
 * link works in a plain browser navigation (which sends no Authorization
 * header) and stops working when it expires.
 *
 * Authorization to *issue* a link still happens on the authenticated
 * `…/download-url` endpoint. This router only honours a link already issued.
 *
 * Every successful open writes one `document.download` audit row naming the
 * user the link was issued to (and whether it was a shared link), so who
 * read what stays answerable. A shared (permanent) link is accepted only if
 * it has not been revoked — see `verifyLinkToken`.
 */
export const signedRouter = Router()

/** Verify the link and record the read. Returns the subject user id. */
async function openLink(req: Request, resource: string, entityType: string, entityId: string): Promise<string> {
  const t = await verifyLinkToken(resource, req.query.t as string | undefined)
  await writeAudit({
    actorUserId: t.subject, action: 'document.download', entityType, entityId,
    after: { via: t.permanent ? 'shared_link' : 'signed_link', resource }, req,
  })
  return t.subject
}

signedRouter.get('/documents/:id/download', handler(async (req, res) => {
  const id = req.params.id
  const subject = await openLink(req, `document:${id}`, 'EmployeeDocument', id)
  const doc = await prisma.employeeDocument.findUnique({ where: { id } })
  if (!doc || doc.deletedAt) throw ApiError.notFound('Document not found.')

  // A real uploaded file: send its bytes under its own name and type.
  if (doc.originalFilename && doc.mimeType) {
    if (!(await employeeDocStorage.exists(doc.fileKey))) throw ApiError.notFound('The file for this document is no longer stored.')
    const bytes = await employeeDocStorage.get(doc.fileKey)
    res.setHeader('Content-Type', doc.mimeType)
    res.setHeader('Content-Length', String(bytes.length))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Disposition', `attachment; filename="${doc.originalFilename.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(doc.originalFilename)}`)
    return res.send(bytes)
  }

  // Rows seeded before real storage have no file; their payload is derived
  // from the metadata so the download path still works end to end.
  const body =
    `Audit OS — document payload\n\n` +
    `id: ${doc.id}\nname: ${doc.name}\ntype: ${doc.type}\n` +
    `employee: ${doc.employeeId}\nfile_key: ${doc.fileKey}\nissued_to_user: ${subject}\n`
  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${doc.name.replace(/[^A-Za-z0-9._-]/g, '_')}.txt"`,
  )
  res.send(body)
}))

signedRouter.get('/payroll/payslips/:id/pdf', handler(async (req, res) => {
  const id = req.params.id
  await openLink(req, `payslip:${id}`, 'Payslip', id)
  const payslip = await prisma.payslip.findUnique({
    where: { id },
    include: {
      employee: { include: { department: true, designation: true } },
      payrollItem: true,
      payrollRun: true,
    },
  })
  if (!payslip || payslip.deletedAt) throw ApiError.notFound('Payslip not found.')
  streamPayslipPdf(res, payslip)
}))

/**
 * The quotation PDF a client receives. Public by signed token on purpose:
 * the link is pasted into WhatsApp or an email, and it is opened by someone
 * who has no login here.
 */
signedRouter.get('/quotations/:id/pdf', handler(async (req, res) => {
  const id = req.params.id
  await openLink(req, `quotation:${id}`, 'Quotation', id)
  const q = await prisma.quotation.findFirst({
    where: { id, deletedAt: null },
    include: QUOTATION_PDF_INCLUDE,
  })
  if (!q) throw ApiError.notFound('Quotation not found.')
  streamQuotationPdf(res, q)
}))

/**
 * The invoice PDF a client receives. Public by signed token, exactly like the
 * quotation: the link is pasted into WhatsApp or an email and opened by
 * someone who has no login here.
 */
signedRouter.get('/invoices/:id/pdf', handler(async (req, res) => {
  const id = req.params.id
  await openLink(req, `invoice:${id}`, 'Invoice', id)
  const inv = await prisma.invoice.findFirst({
    where: { id, deletedAt: null },
    include: INVOICE_PDF_INCLUDE,
  })
  if (!inv) throw ApiError.notFound('Invoice not found.')
  await streamInvoicePdf(res, inv)
}))

/** The engagement letter PDF — public by signed token, like the quotation. */
signedRouter.get('/engagement-letters/:id/pdf', handler(async (req, res) => {
  const id = req.params.id
  await openLink(req, `engagement:${id}`, 'EngagementLetter', id)
  const l = await prisma.engagementLetter.findFirst({
    where: { id, deletedAt: null },
    include: ENGAGEMENT_INCLUDE,
  })
  if (!l) throw ApiError.notFound('Engagement letter not found.')
  streamEngagementPdf(res, l)
}))

/** A Workstation document's PDF — public by signed token, like the two above. */
signedRouter.get('/workstation-docs/:id/pdf', handler(async (req, res) => {
  const id = req.params.id
  await openLink(req, `wsdoc:${id}`, 'WorkstationDoc', id)
  const d = await prisma.workstationDoc.findFirst({ where: { id, deletedAt: null }, include: DOC_INCLUDE })
  if (!d) throw ApiError.notFound('Document not found.')
  streamDocPdf(res, d)
}))
