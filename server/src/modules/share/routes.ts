/**
 * Send a Workstation document to a client by email, WITH the PDF attached.
 *
 * A browser's mailto: can only carry text, so the file never reached the
 * client — only a link did. Here the server renders the same PDF the signed
 * link serves and sends it through the firm's SMTP account (lib/mailer.ts).
 *
 *   GET  /api/share/email/status   { configured, from }
 *   POST /api/share/email          { kind, id, to[], cc[], subject, message }
 *
 * Access is the document's own read check (the same one its pdf-url route
 * uses), so nobody can mail a document they could not open.
 */
import { Router } from 'express'
import os from 'node:os'
import { Writable } from 'node:stream'
import QRCode from 'qrcode'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { mailConfigured, mailFrom, MailError, sendMail } from '../../lib/mailer.js'
import { sendWhatsAppDocument, whatsappConfigured, whatsappMode, WhatsAppError } from '../../lib/whatsapp.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { requireWorkstation } from '../../platform/workstation/scope.js'
import { signedLink } from '../../platform/signedUrl.js'
import { QuotationService } from '../quotation/service.js'
import { InvoiceService } from '../invoice/service.js'
import { EngagementService, INCLUDE as ENGAGEMENT_INCLUDE } from '../engagement/service.js'
import { streamQuotationPdf, QUOTATION_PDF_INCLUDE } from '../quotation/pdf.js'
import { streamInvoicePdf, INVOICE_PDF_INCLUDE } from '../invoice/pdf.js'
import { streamEngagementPdf } from '../engagement/pdf.js'

export const shareRouter = Router()

/**
 * Run a PDF writer that expects an Express Response and collect its bytes.
 * The writers only pipe into the response and set headers.
 */
export async function renderPdf(write: (res: never) => unknown): Promise<Buffer> {
  const chunks: Buffer[] = []
  const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb() } }) as Writable & { setHeader: () => void }
  sink.setHeader = () => undefined
  const done = new Promise<void>((resolve, reject) => { sink.on('finish', resolve); sink.on('error', reject) })
  await write(sink as never)
  await done
  return Buffer.concat(chunks)
}

type Kind = 'quotation' | 'invoice' | 'engagement'

/** Access check + the PDF + its file name, per document kind. */
async function documentPdf(req: Parameters<typeof requireSession>[0], kind: Kind, id: string): Promise<{ file: string; pdf: Buffer; label: string; party: string }> {
  const session = requireSession(req)
  if (kind === 'quotation') {
    await QuotationService.get(session, requireWorkstation(session, 'workstation.quotation.read'), id)
    const q = await prisma.quotation.findFirst({ where: { id, deletedAt: null }, include: QUOTATION_PDF_INCLUDE })
    if (!q) throw ApiError.notFound('Quotation not found.')
    return { file: `${q.quotationCode}.pdf`, pdf: await renderPdf((res) => streamQuotationPdf(res, q)), label: `Quotation ${q.quotationCode}`, party: q.client?.companyName ?? q.lead?.name ?? '' }
  }
  if (kind === 'invoice') {
    await InvoiceService.get(session, requireWorkstation(session, 'workstation.invoice.read'), id)
    const inv = await prisma.invoice.findFirst({ where: { id, deletedAt: null }, include: INVOICE_PDF_INCLUDE })
    if (!inv) throw ApiError.notFound('Invoice not found.')
    const no = inv.invoiceNumber ?? 'invoice'
    return { file: `${no}.pdf`, pdf: await renderPdf((res) => streamInvoicePdf(res, inv)), label: `Invoice ${no}`, party: inv.billingName ?? inv.client.companyName }
  }
  await EngagementService.get(session, requireWorkstation(session, 'workstation.engagement.read'), id)
  const l = await prisma.engagementLetter.findFirst({ where: { id, deletedAt: null }, include: ENGAGEMENT_INCLUDE })
  if (!l) throw ApiError.notFound('Engagement letter not found.')
  return { file: `${l.letterCode}.pdf`, pdf: await renderPdf((res) => streamEngagementPdf(res, l)), label: `Engagement letter ${l.letterCode}`, party: l.client?.companyName ?? l.lead?.name ?? '' }
}

shareRouter.get('/email/status', handler(async (req, res) => {
  requireSession(req)
  ok(res, { configured: mailConfigured(), from: mailConfigured() ? mailFrom() : null })
}))

const emails = z.array(z.string().trim().email('Enter valid email addresses.')).max(20)
const Body = z.object({
  kind: z.enum(['quotation', 'invoice', 'engagement']),
  id: z.string().min(1).max(100),
  to: emails.min(1, 'Add at least one recipient.'),
  cc: emails.optional().default([]),
  subject: z.string().trim().min(1, 'Subject is required.').max(250),
  message: z.string().max(20_000).default(''),
})

shareRouter.post('/email', handler(async (req, res) => {
  const session = requireSession(req)
  const parsed = Body.safeParse(req.body)
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid request.')
  const b = parsed.data
  if (!mailConfigured()) throw new ApiError(503, 'mail_not_configured', 'Email is not configured on the server. Add SMTP_HOST, SMTP_USER and SMTP_PASS to server/.env.')

  const doc = await documentPdf(req, b.kind, b.id)
  try {
    await sendMail({
      to: b.to, cc: b.cc.length ? b.cc : undefined, replyTo: session.email, subject: b.subject, text: b.message,
      attachments: [{ filename: doc.file, content: doc.pdf, contentType: 'application/pdf' }],
    })
  } catch (e) {
    if (e instanceof MailError) throw new ApiError(502, 'mail_failed', e.message)
    throw e
  }
  await writeAudit({ actorUserId: session.userId, action: `${b.kind}.emailed`, entityType: b.kind, entityId: b.id, after: { to: b.to, cc: b.cc, attachment: doc.file }, req })
  ok(res, { sent: true, attachment: doc.file, to: b.to })
}))

// ── WhatsApp (Business Cloud API) ────────────────────────────────────────
//   GET  /api/share/whatsapp/status  { configured, mode: 'template' | 'document' | null }
//   POST /api/share/whatsapp         { kind, id, to, message }

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

  const doc = await documentPdf(req, b.kind, b.id)
  let result
  try {
    result = await sendWhatsAppDocument({
      to, pdf: doc.pdf, filename: doc.file,
      recipientName: doc.party || 'Sir/Madam', documentLabel: doc.label, caption: b.message,
    })
  } catch (e) {
    if (e instanceof WhatsAppError) throw new ApiError(502, 'whatsapp_failed', e.message)
    throw e
  }
  await writeAudit({ actorUserId: session.userId, action: `${b.kind}.whatsapped`, entityType: b.kind, entityId: b.id, after: { to, attachment: doc.file, message_id: result.messageId, mode: result.mode }, req })
  ok(res, { sent: true, attachment: doc.file, to, message_id: result.messageId, mode: result.mode })
}))

// ── Phone handoff: WhatsApp WITHOUT the Business API ──────────────────────
//   POST /api/share/phone-link { kind, id, note } → { url, qr, expires_at }
//
// A desktop browser (Linux especially) cannot attach a file to WhatsApp. A
// phone can: its share sheet hands WhatsApp the real PDF. So the desktop
// shows a QR code; the phone opens /send (public page, signed link), and
// the PDF goes to WhatsApp from there, attached.

const PHONE_LINK_TTL = 30 * 60

/**
 * The address a phone on the same network can open. PUBLIC_APP_URL wins
 * (a deployment with a real domain). Otherwise the browser's own origin,
 * with localhost swapped for this machine's LAN address.
 */
function phoneOrigin(req: Parameters<typeof requireSession>[0]): string {
  if (process.env.PUBLIC_APP_URL) return process.env.PUBLIC_APP_URL.replace(/\/$/, '')
  const origin = (req.headers.origin as string | undefined) ?? (req.headers.referer ? new URL(req.headers.referer as string).origin : `http://${req.headers.host}`)
  const u = new URL(origin)
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    // Skip Docker / VM bridges; they are not reachable from a phone.
    const lan = Object.entries(os.networkInterfaces())
      .filter(([name]) => !/^(docker|br-|virbr|veth|vboxnet|vmnet|lo)/.test(name))
      .flatMap(([, addrs]) => addrs ?? [])
      .find((a) => a.family === 'IPv4' && !a.internal)
    if (lan) u.hostname = lan.address
  }
  return u.origin
}

const PhoneBody = z.object({
  kind: z.enum(['quotation', 'invoice', 'engagement']),
  id: z.string().min(1).max(100),
  note: z.string().max(1000).default(''),
})

shareRouter.post('/phone-link', handler(async (req, res) => {
  const session = requireSession(req)
  const parsed = PhoneBody.safeParse(req.body)
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid request.')
  const { kind, id, note } = parsed.data

  let file: string
  let pdf: string
  if (kind === 'quotation') {
    const q = await QuotationService.get(session, requireWorkstation(session, 'workstation.quotation.read'), id)
    file = `${q.quotation_code}.pdf`
    pdf = signedLink(`/api/quotations/${id}/pdf`, `quotation:${id}`, session.userId, PHONE_LINK_TTL).url
  } else if (kind === 'invoice') {
    const inv = await InvoiceService.get(session, requireWorkstation(session, 'workstation.invoice.read'), id)
    file = `${inv.invoice_number ?? 'invoice'}.pdf`
    pdf = signedLink(`/api/invoices/${id}/pdf`, `invoice:${id}`, session.userId, PHONE_LINK_TTL).url
  } else {
    const l = await EngagementService.get(session, requireWorkstation(session, 'workstation.engagement.read'), id)
    file = `${l.letter_code}.pdf`
    pdf = signedLink(`/api/engagement-letters/${id}/pdf`, `engagement:${id}`, session.userId, PHONE_LINK_TTL).url
  }

  const url = `${phoneOrigin(req)}/send?${new URLSearchParams({ pdf, name: file, note })}`
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 280, errorCorrectionLevel: 'L' })
  await writeAudit({ actorUserId: session.userId, action: `${kind}.phone_share_link`, entityType: kind, entityId: id, after: { file }, req })
  ok(res, { url, qr, file, expires_at: new Date(Date.now() + PHONE_LINK_TTL * 1000).toISOString() })
}))
