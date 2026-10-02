/**
 * Send a Workstation document (quotation, invoice or engagement letter) to a
 * client by email or WhatsApp as a MESSAGE containing a public download link.
 *
 *   GET  /api/share/email/status      { configured, from }
 *   POST /api/share/email             { kind, id, to[], cc[], subject, message } → { sent, link, to }
 *   GET  /api/share/whatsapp/status   { configured, mode: 'template' | 'text' | null }
 *   POST /api/share/whatsapp          { kind, id, to, message } → { sent, link, to, message_id, mode }
 *   POST /api/share/public-link       { kind, id } → { url, file }
 *
 * The link is a 100-year signed URL to the document's PDF route under
 * `/api/<kind>/<id>/pdf?t=…` — see `server/src/modules/signed.routes.ts`. Those
 * routes do not require a login (signed-URL authorization), so the recipient
 * can download the PDF from any device.
 *
 * Access to ISSUE a link is still the document's read check, so nobody can
 * share a document they cannot open.
 */
import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { env } from '../../lib/env.js'
import { mailConfigured, mailFrom, MailError, sendMail } from '../../lib/mailer.js'
import { sendWhatsAppLink, whatsappConfigured, whatsappMode, WhatsAppError } from '../../lib/whatsapp.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { requireWorkstation } from '../../platform/workstation/scope.js'
import { permanentLink } from '../../platform/signedUrl.js'
import { QuotationService } from '../quotation/service.js'
import { InvoiceService } from '../invoice/service.js'
import { EngagementService } from '../engagement/service.js'

export const shareRouter = Router()

type Kind = 'quotation' | 'invoice' | 'engagement'

/** Access check + public URL + friendly file label + recipient party, per kind. */
async function publicPdfLink(req: Parameters<typeof requireSession>[0], kind: Kind, id: string): Promise<{ url: string; file: string; party: string }> {
  const session = requireSession(req)
  if (!env.publicAppUrl) {
    throw new ApiError(503, 'config_missing', 'The server does not know its public URL. Ask an administrator to set PUBLIC_APP_URL in server/.env to the address clients will use (e.g. https://audit.example.com).')
  }
  if (kind === 'quotation') {
    const q = await QuotationService.get(session, requireWorkstation(session, 'workstation.quotation.read'), id)
    const file = `${q.quotation_code}.pdf`
    const { url } = permanentLink(`${env.publicAppUrl}/api/quotations/${id}/pdf`, `quotation:${id}`, session.userId)
    return { url, file, party: q.party_name ?? '' }
  }
  if (kind === 'invoice') {
    const inv = await InvoiceService.get(session, requireWorkstation(session, 'workstation.invoice.read'), id)
    const file = `${inv.invoice_number ?? 'invoice'}.pdf`
    const { url } = permanentLink(`${env.publicAppUrl}/api/invoices/${id}/pdf`, `invoice:${id}`, session.userId)
    return { url, file, party: inv.billing_name ?? '' }
  }
  const l = await EngagementService.get(session, requireWorkstation(session, 'workstation.engagement.read'), id)
  const file = `${l.letter_code}.pdf`
  const { url } = permanentLink(`${env.publicAppUrl}/api/engagement-letters/${id}/pdf`, `engagement:${id}`, session.userId)
  return { url, file, party: l.party_name ?? '' }
}

const PublicLinkBody = z.object({
  kind: z.enum(['quotation', 'invoice', 'engagement']),
  id: z.string().min(1).max(100),
})

shareRouter.post('/public-link', handler(async (req, res) => {
  requireSession(req)
  const parsed = PublicLinkBody.safeParse(req.body)
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid request.')
  const { kind, id } = parsed.data
  // No audit here: the dialog opens this on every mount. The actual send
  // (/share/email, /share/whatsapp) logs the link under `after.link`.
  const link = await publicPdfLink(req, kind, id)
  ok(res, { url: link.url, file: link.file })
}))

shareRouter.get('/email/status', handler(async (req, res) => {
  requireSession(req)
  ok(res, { configured: mailConfigured(), from: mailConfigured() ? mailFrom() : null })
}))

const emails = z.array(z.string().trim().email('Enter valid email addresses.')).max(20)
const EmailBody = z.object({
  kind: z.enum(['quotation', 'invoice', 'engagement']),
  id: z.string().min(1).max(100),
  to: emails.min(1, 'Add at least one recipient.'),
  cc: emails.optional().default([]),
  subject: z.string().trim().min(1, 'Subject is required.').max(250),
  message: z.string().max(20_000).default(''),
})

shareRouter.post('/email', handler(async (req, res) => {
  const session = requireSession(req)
  const parsed = EmailBody.safeParse(req.body)
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid request.')
  const b = parsed.data
  if (!mailConfigured()) throw new ApiError(503, 'mail_not_configured', 'Email is not configured on the server. Add SMTP_HOST, SMTP_USER and SMTP_PASS to server/.env.')

  const link = await publicPdfLink(req, b.kind, b.id)
  const body = `${b.message.trimEnd()}\n\nDownload ${link.file}:\n${link.url}\n`
  try {
    await sendMail({ to: b.to, cc: b.cc.length ? b.cc : undefined, replyTo: session.email, subject: b.subject, text: body })
  } catch (e) {
    if (e instanceof MailError) throw new ApiError(502, 'mail_failed', e.message)
    throw e
  }
  await writeAudit({ actorUserId: session.userId, action: `${b.kind}.emailed`, entityType: b.kind, entityId: b.id, after: { to: b.to, cc: b.cc, link: link.url, file: link.file }, req })
  ok(res, { sent: true, link: link.url, file: link.file, to: b.to })
}))

/** The number WhatsApp needs: digits with country code. 10-digit Indian numbers get 91. */
function waDigits(raw: string): string | null {
  const trimmed = raw.trim()
  let d = trimmed.replace(/[^0-9]/g, '')
  if (!trimmed.startsWith('+')) {
    if (d.length === 10) d = `91${d}`
    else if (d.length === 11 && d.startsWith('0')) d = `91${d.slice(1)}`
  }
  if (d.startsWith('91')) return /^91[6-9]\d{9}$/.test(d) ? d : null
  return d.length >= 8 && d.length <= 15 ? d : null
}

shareRouter.get('/whatsapp/status', handler(async (req, res) => {
  requireSession(req)
  ok(res, { configured: whatsappConfigured(), mode: whatsappMode() })
}))

const WaBody = z.object({
  kind: z.enum(['quotation', 'invoice', 'engagement']),
  id: z.string().min(1).max(100),
  to: z.string().min(1, 'Enter a WhatsApp number.').max(30),
  message: z.string().max(1000).default(''),
})

shareRouter.post('/whatsapp', handler(async (req, res) => {
  const session = requireSession(req)
  const parsed = WaBody.safeParse(req.body)
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid request.')
  const b = parsed.data
  if (!whatsappConfigured()) throw new ApiError(503, 'whatsapp_not_configured', 'WhatsApp Business API is not configured on the server. Add WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID to server/.env.')
  const to = waDigits(b.to)
  if (!to) throw ApiError.badRequest('That is not a valid mobile number. Use a 10-digit Indian mobile, or + and the country code.')

  const link = await publicPdfLink(req, b.kind, b.id)
  const body = `${b.message.trimEnd()}\n\n${link.url}`
  let result
  try {
    result = await sendWhatsAppLink({ to, link: link.url, body, recipientName: link.party || 'Sir/Madam' })
  } catch (e) {
    if (e instanceof WhatsAppError) throw new ApiError(502, 'whatsapp_failed', e.message)
    throw e
  }
  await writeAudit({ actorUserId: session.userId, action: `${b.kind}.whatsapped`, entityType: b.kind, entityId: b.id, after: { to, link: link.url, file: link.file, message_id: result.messageId, mode: result.mode }, req })
  ok(res, { sent: true, link: link.url, file: link.file, to, message_id: result.messageId, mode: result.mode })
}))
