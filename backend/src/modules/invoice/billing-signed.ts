/**
 * Signed-URL byte endpoints for the documents that hang off an invoice —
 * the CREDIT NOTE PDF, the PAYMENT RECEIPT and the REFUND VOUCHER. Mounted beside signedRouter,
 * BEFORE `authenticate`: the HMAC on the link is the authorization (see
 * signed.routes.ts). The link itself is issued by an authenticated
 * `…/pdf-url` / `…/receipt-url` endpoint after the scope check.
 */
import { Router, type Request } from 'express'
import { handler } from '../../lib/http.js'
import { verifyLinkToken } from '../../platform/signedUrl.js'
import { writeAudit } from '../../platform/audit.js'
import { streamCreditNotePdf } from '../credit-note/pdf.js'
import { streamReceiptPdf, streamRefundVoucherPdf } from './receipt-pdf.js'

export const billingSignedRouter = Router()

async function openLink(req: Request, resource: string, entityType: string, entityId: string) {
  const t = await verifyLinkToken(resource, req.query.t as string | undefined)
  await writeAudit({
    actorUserId: t.subject, action: 'document.download', entityType, entityId,
    after: { via: t.permanent ? 'shared_link' : 'signed_link', resource }, req,
  })
}

billingSignedRouter.get('/credit-notes/:id/pdf', handler(async (req, res) => {
  await openLink(req, `credit-note:${req.params.id}`, 'CreditNote', req.params.id)
  await streamCreditNotePdf(res, req.params.id)
}))

billingSignedRouter.get('/invoice-payments/:id/receipt', handler(async (req, res) => {
  await openLink(req, `receipt:${req.params.id}`, 'InvoicePayment', req.params.id)
  await streamReceiptPdf(res, req.params.id)
}))

billingSignedRouter.get('/invoice-refunds/:id/voucher', handler(async (req, res) => {
  await openLink(req, `refund:${req.params.id}`, 'InvoiceRefund', req.params.id)
  await streamRefundVoucherPdf(res, req.params.id)
}))
