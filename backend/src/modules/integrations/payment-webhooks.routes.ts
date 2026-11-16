/**
 * Public gateway webhooks — POST /api/payments/webhooks/razorpay and /cashfree.
 *
 * Mounted in app.ts BEFORE the JSON / urlencoded parsers and before
 * `authenticate`, with express.raw: the signature is over the exact bytes
 * received, so the body must never be parsed and re-serialised first.
 *
 * Whose secret? The body names the link; a link we created belongs to one
 * firm, so that firm's secret must verify it. An event for a link we do not
 * know (the gateway account is used for other things too) is checked against
 * every firm's secret for that gateway: if one verifies it is acknowledged
 * with 200 and ignored; if none does it is 401.
 *
 *   bad / missing signature           → 401
 *   valid, nothing for us to do       → 200 { ignored: <why> }
 *   valid, payment recorded / repeated → 200 { ok: true, result }
 *
 * Replays are harmless: recording is idempotent on the gateway payment id
 * (payment-links.ts → applyGatewayPayment), so no timestamp window is enforced.
 */
import { Router, type Request, type Response } from 'express'
import { prisma } from '../../lib/prisma.js'
import { decryptPortalSecret } from '../../platform/portalCrypto.js'
import {
  parseCashfreeEvent, parseRazorpayEvent, verifyCashfreeSignature, verifyRazorpaySignature,
  type Gateway, type WebhookEvent,
} from './gateways.js'
import { applyGatewayPayment, secretContext, setLinkStatus, webhookSecretContext } from './payment-links.js'

export const paymentWebhooksRouter = Router()

function headerOf(req: Request, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/**
 * The body as an object. JSON is what both gateways document; Cashfree's
 * payment-link page also says "We send the webhook response in a form data
 * format", so a urlencoded body is accepted too (unverified in practice).
 */
function parseBody(raw: Buffer): Record<string, unknown> | null {
  const text = raw.toString('utf8').trim()
  if (!text) return null
  if (text.startsWith('{')) {
    try {
      const v = JSON.parse(text)
      return v && typeof v === 'object' ? v : null
    } catch { return null }
  }
  const form = new URLSearchParams(text)
  const out: Record<string, unknown> = {}
  for (const [k, v] of form) out[k] = v
  // A form body may carry the JSON event in a single field.
  for (const v of Object.values(out)) {
    if (typeof v === 'string' && v.trim().startsWith('{')) {
      try { return JSON.parse(v) } catch { /* keep looking */ }
    }
  }
  return Object.keys(out).length ? out : null
}

async function handle(gateway: Gateway, req: Request, res: Response) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('')
  const body = parseBody(raw)
  let ev: WebhookEvent = { linkId: null, linkStatus: null, payment: null, kind: 'unparsed' }
  try {
    if (body) ev = gateway === 'razorpay' ? parseRazorpayEvent(body) : parseCashfreeEvent(body)
  } catch { /* treat as unparsed */ }

  const link = ev.linkId
    ? await prisma.invoicePaymentLink.findUnique({ where: { gateway_gatewayLinkId: { gateway, gatewayLinkId: ev.linkId } } })
    : null
  const configs = await prisma.paymentGatewayConfig.findMany({
    where: { gateway, active: true, ...(link ? { organisationId: link.organisationId } : {}) },
    take: 100,
  })
  const verified = configs.some((c) => {
    if (gateway === 'razorpay') {
      const secret = c.webhookSecretCiphertext ? decryptPortalSecret(c.webhookSecretCiphertext, webhookSecretContext(gateway)) : null
      return !!secret && verifyRazorpaySignature(raw, headerOf(req, 'x-razorpay-signature'), secret)
    }
    const secret = decryptPortalSecret(c.secretCiphertext, secretContext(gateway))
    return !!secret && verifyCashfreeSignature(raw, headerOf(req, 'x-webhook-signature'), headerOf(req, 'x-webhook-timestamp'), secret)
  })
  if (!verified) {
    res.status(401).json({ error: { code: 'bad_signature', message: 'The webhook signature does not verify.' } })
    return
  }
  if (!body) { res.status(200).json({ ignored: 'unreadable_body' }); return }
  if (!link) { res.status(200).json({ ignored: ev.linkId ? 'unknown_link' : `no_link:${ev.kind}` }); return }

  let result: string | null = null
  if (ev.payment) result = await applyGatewayPayment(link.id, ev.payment, 'webhook', null)
  await setLinkStatus(link.id, ev.linkStatus)
  if (!result) { res.status(200).json({ ignored: `no_payment:${ev.kind}` }); return }
  res.status(200).json({ ok: true, result })
}

paymentWebhooksRouter.post('/razorpay', async (req, res) => {
  try { await handle('razorpay', req, res) } catch (e) {
    console.error('[webhook] razorpay', e instanceof Error ? e.message : e)
    // 500 → the gateway retries later.
    if (!res.headersSent) res.status(500).json({ error: { code: 'internal', message: 'Could not process the event.' } })
  }
})
paymentWebhooksRouter.post('/cashfree', async (req, res) => {
  try { await handle('cashfree', req, res) } catch (e) {
    console.error('[webhook] cashfree', e instanceof Error ? e.message : e)
    if (!res.headersSent) res.status(500).json({ error: { code: 'internal', message: 'Could not process the event.' } })
  }
})
// Anything else under the webhook prefix ends here rather than falling through to auth.
paymentWebhooksRouter.use((_req, res) => { res.status(404).json({ error: { code: 'not_found', message: 'No such webhook.' } }) })
