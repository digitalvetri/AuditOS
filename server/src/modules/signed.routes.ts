import { Router } from 'express'
import { ApiError, handler } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { verifyResourceToken } from '../platform/signedUrl.js'
import { streamPayslipPdf } from './payroll/pdf.js'

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
 */
export const signedRouter = Router()

signedRouter.get('/documents/:id/download', handler(async (req, res) => {
  const id = req.params.id
  const subject = verifyResourceToken(`document:${id}`, req.query.t as string | undefined)
  const doc = await prisma.employeeDocument.findUnique({ where: { id } })
  if (!doc || doc.deletedAt) throw ApiError.notFound('Document not found.')

  // No object store is wired in this phase; the payload is derived from the
  // metadata so the download path is exercised end to end.
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
  verifyResourceToken(`payslip:${id}`, req.query.t as string | undefined)
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
