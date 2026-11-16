import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createHmac, randomBytes } from 'node:crypto'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, setFirmGstin, uid } from '../../../__tests__/helpers.js'
import { istToday } from '../../../lib/dates.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { decryptPortalSecret } from '../../../platform/portalCrypto.js'
import { __setGatewayFetchForTests, rupeesToPaise, verifyCashfreeSignature, verifyRazorpaySignature } from '../gateways.js'

/**
 * Integrations → Payment gateways (Razorpay, Cashfree): firm keys, invoice
 * payment links, and the webhooks / "Check status" that record the money on
 * the invoice — once per gateway payment, never above the balance due.
 * Every gateway call goes through an injectable fetch; nothing hits the network.
 */

let server: Server
let base = ''
let orgId = ''
let adminCookie = ''
let staffCookie = ''
let clientId = ''
let wsId = ''

type Call = { url: string; method: string; headers: Headers; body: any }
let calls: Call[] = []
let reply: (url: string, method: string) => Response = () => new Response('{}', { status: 500 })

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const mockFetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(String(init.body)) : null
  calls.push({ url, method, headers: new Headers(init?.headers), body })
  return reply(url, method)
}) as typeof fetch

async function api(p: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${p}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: opts.cookie ?? adminCookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body: body && typeof body === 'object' && 'data' in body ? body.data : body }
}

async function hook(gateway: 'razorpay' | 'cashfree', raw: string, headers: Record<string, string>) {
  const res = await fetch(`${base}/api/payments/webhooks/${gateway}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function user(code: string) {
  const role = await prisma.role.findUniqueOrThrow({ where: { code } })
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('PG'), firstName: 'P', lastName: code, fullName: `P ${code} ${uid('n')}`, email: `${uid('pg')}@x.local`, joiningDate: '2020-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  return `ao_access=${signToken(u.id)}`
}

/** A sent invoice of ₹11,800 (₹10,000 + 18% GST) for the test client. */
async function sentInvoice() {
  const d = await api('/api/invoices', {
    method: 'POST',
    body: { client_id: clientId, invoice_date: istToday(), terms: 'net_15', place_of_supply: 'Tamil Nadu', items: [{ item_name: 'Audit fee', hsn_sac: '998221', quantity_centi: 100, rate_paise: 10_000_00, gst_rate_percent: 18 }] },
  })
  expect(d.status).toBe(201)
  const s = await api(`/api/invoices/${d.body.id}/send`, { method: 'POST' })
  expect(s.status).toBe(200)
  return s.body as { id: string; invoice_number: string; total_paise: number }
}

const RZP_SECRET = 'rzp_webhook_secret_123'
const CF_SECRET = 'cfsk_ma_test_secret_value_1234'

async function saveRazorpay(cookie = adminCookie) {
  return api('/api/integrations/payment-gateways', {
    method: 'PUT', cookie,
    body: { gateway: 'razorpay', mode: 'test', key_id: 'rzp_test_abc123', key_secret: 'rzp_secret_value_xyz', webhook_secret: RZP_SECRET },
  })
}
async function saveCashfree() {
  return api('/api/integrations/payment-gateways', {
    method: 'PUT',
    body: { gateway: 'cashfree', mode: 'test', key_id: 'TEST1234APPID', key_secret: CF_SECRET },
  })
}

let plinkSeq = 0
/** Default gateway replies: Razorpay create returns a fresh plink; Cashfree echoes the link_id. */
function defaultReply(url: string, method: string): Response {
  if (url === 'https://api.razorpay.com/v1/payment_links' && method === 'POST') {
    const last = calls[calls.length - 1]
    plinkSeq++
    return json(200, { id: `plink_T${plinkSeq}${uid('x')}`, short_url: 'https://rzp.io/i/abc', status: 'created', amount: last.body.amount, amount_paid: 0 })
  }
  if (url === 'https://sandbox.cashfree.com/pg/links' && method === 'POST') {
    const last = calls[calls.length - 1]
    return json(200, { cf_link_id: 1, link_id: last.body.link_id, link_status: 'ACTIVE', link_url: 'https://payments-test.cashfree.com/links/x', link_amount: last.body.link_amount, link_amount_paid: 0 })
  }
  return json(500, { error: { description: `unexpected ${method} ${url}` } })
}

function rzpEvent(event: string, linkId: string, payment: { id: string; amount: number; method?: string; status?: string } | null, linkStatus = 'paid') {
  return JSON.stringify({
    entity: 'event', event, contains: ['payment_link', 'payment'],
    payload: {
      payment_link: { entity: { id: linkId, status: linkStatus, amount_paid: payment?.amount ?? 0 } },
      ...(payment ? { payment: { entity: { id: payment.id, amount: payment.amount, method: payment.method ?? 'upi', status: payment.status ?? 'captured', created_at: Math.floor(Date.parse('2026-10-05T06:00:00Z') / 1000) } } } : {}),
    },
    created_at: 1749618371,
  })
}
const rzpSig = (raw: string, secret = RZP_SECRET) => createHmac('sha256', secret).update(raw).digest('hex')

function cfEvent(linkId: string, order: { order_id: string; order_amount: string; transaction_id?: number; transaction_status?: string } | null, linkStatus = 'PAID') {
  return JSON.stringify({
    data: {
      cf_link_id: 1576977, link_id: linkId, link_status: linkStatus, link_currency: 'INR',
      link_amount: '11800.00', link_amount_paid: order?.order_amount ?? '0.00',
      order: order ? { order_amount: order.order_amount, order_id: order.order_id, transaction_id: order.transaction_id ?? 1021206, transaction_status: order.transaction_status ?? 'SUCCESS' } : null,
    },
    type: 'PAYMENT_LINK_EVENT', version: 1, event_time: '2026-10-05T12:55:06+05:30',
  })
}
function cfHeaders(raw: string, secret = CF_SECRET) {
  const ts = String(Date.now())
  return { 'x-webhook-timestamp': ts, 'x-webhook-signature': createHmac('sha256', secret).update(ts + raw).digest('base64') }
}

async function createLink(invoiceId: string, gateway?: string) {
  return api(`/api/invoices/${invoiceId}/payment-links`, { method: 'POST', body: gateway ? { gateway } : {} })
}
const livePayments = (invoiceId: string) => prisma.invoicePayment.findMany({ where: { invoiceId, deletedAt: null } })

beforeAll(async () => {
  process.env.PORTAL_ACCESS_ENC_KEY ??= randomBytes(32).toString('base64')
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const a = server.address()
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
  // Invoices belong to the deployment's (first) organisation — the firm is
  // single-tenant — so the gateway keys must be saved by a user of that one.
  orgId = (await prisma.organisation.findFirst({ select: { id: true } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Gateway Firm' } })).id
  await prisma.paymentGatewayConfig.deleteMany({ where: { organisationId: orgId } })
  wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  await setFirmGstin()
  adminCookie = await user('md')
  staffCookie = await user('employee')
  const manager = await prisma.user.findFirstOrThrow({ where: { organisationId: orgId, employeeId: { not: null } } })
  clientId = (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Link Co', email: 'pay@link.co', accountManagerId: manager.employeeId!, contactPerson: 'P', contactNumber: '9876543210', onboardingDate: '2026-01-01' } })).id
})
beforeEach(() => {
  calls = []
  reply = defaultReply
  __setGatewayFetchForTests(mockFetch)
})
afterEach(() => { __setGatewayFetchForTests(null) })
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('helpers', () => {
  it('converts rupee strings and numbers to paise without float error', () => {
    expect(rupeesToPaise('22.00')).toBe(2200)
    expect(rupeesToPaise('200.12')).toBe(20012)
    expect(rupeesToPaise(22)).toBe(2200)
    expect(rupeesToPaise(1.1)).toBe(110)
    expect(rupeesToPaise('0.5')).toBe(50)
    expect(rupeesToPaise('abc')).toBeNull()
    expect(rupeesToPaise('-1')).toBeNull()
  })

  it('verifies Razorpay (hex HMAC of the raw body) and Cashfree (base64 HMAC of timestamp + raw body) signatures', () => {
    const raw = Buffer.from('{"a":1}')
    expect(verifyRazorpaySignature(raw, createHmac('sha256', 's').update(raw).digest('hex'), 's')).toBe(true)
    expect(verifyRazorpaySignature(raw, 'deadbeef', 's')).toBe(false)
    expect(verifyRazorpaySignature(raw, undefined, 's')).toBe(false)
    const sig = createHmac('sha256', 'k').update('123' + raw.toString()).digest('base64')
    expect(verifyCashfreeSignature(raw, sig, '123', 'k')).toBe(true)
    expect(verifyCashfreeSignature(raw, sig, '124', 'k')).toBe(false)
    expect(verifyCashfreeSignature(raw, sig, undefined, 'k')).toBe(false)
  })
})

describe('gateway settings', () => {
  it('needs integrations.access', async () => {
    expect((await api('/api/integrations/payment-gateways', { cookie: staffCookie })).status).toBe(403)
    expect((await saveRazorpay(staffCookie)).status).toBe(403)
  })

  it('validates the body', async () => {
    expect((await api('/api/integrations/payment-gateways', { method: 'PUT', body: { gateway: 'paypal', mode: 'live', key_id: 'x', key_secret: 'y' } })).status).toBe(400)
    expect((await api('/api/integrations/payment-gateways', { method: 'PUT', body: { gateway: 'razorpay', mode: 'prod', key_id: 'rzp_test_1', key_secret: 'abcdefgh' } })).status).toBe(400)
    // First save needs the secret.
    expect((await api('/api/integrations/payment-gateways', { method: 'PUT', body: { gateway: 'cashfree', mode: 'test', key_id: 'APPID' } })).status).toBe(400)
  })

  it('saves keys encrypted, never returns them, and the first gateway becomes the default', async () => {
    const r = await saveRazorpay()
    expect(r.status).toBe(200)
    const rzp = r.body.gateways.find((g: any) => g.gateway === 'razorpay')
    expect(rzp).toMatchObject({ configured: true, mode: 'test', key_id: 'rzp_test_abc123', has_webhook_secret: true, is_default: true })
    expect(JSON.stringify(r.body)).not.toContain('rzp_secret_value_xyz')
    expect(JSON.stringify(r.body)).not.toContain(RZP_SECRET)
    expect(r.body.webhook_urls.razorpay).toMatch(/\/api\/payments\/webhooks\/razorpay$/)
    expect(r.body.webhook_urls.cashfree).toMatch(/\/api\/payments\/webhooks\/cashfree$/)

    const row = await prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { organisationId_gateway: { organisationId: orgId, gateway: 'razorpay' } } })
    expect(row.secretCiphertext).not.toContain('rzp_secret_value_xyz')
    expect(decryptPortalSecret(row.secretCiphertext, 'payment_gateway.razorpay.secret')).toBe('rzp_secret_value_xyz')
    expect(decryptPortalSecret(row.webhookSecretCiphertext!, 'payment_gateway.razorpay.webhookSecret')).toBe(RZP_SECRET)

    const c = await saveCashfree()
    expect(c.status).toBe(200)
    expect(c.body.gateways.find((g: any) => g.gateway === 'cashfree')).toMatchObject({ configured: true, is_default: false })

    // Updating without a secret keeps the saved one.
    const again = await api('/api/integrations/payment-gateways', { method: 'PUT', body: { gateway: 'cashfree', mode: 'test', key_id: 'TEST1234APPID' } })
    expect(again.status).toBe(200)
    const cf = await prisma.paymentGatewayConfig.findUniqueOrThrow({ where: { organisationId_gateway: { organisationId: orgId, gateway: 'cashfree' } } })
    expect(decryptPortalSecret(cf.secretCiphertext, 'payment_gateway.cashfree.secret')).toBe(CF_SECRET)
  })

  it('one default per firm; removing the default hands over', async () => {
    await saveRazorpay(); await saveCashfree()
    const d = await api('/api/integrations/payment-gateways/cashfree/default', { method: 'POST' })
    expect(d.status).toBe(200)
    expect(d.body.gateways.filter((g: any) => g.is_default).map((g: any) => g.gateway)).toEqual(['cashfree'])
    expect((await api('/api/integrations/payment-gateways/cashfree', { method: 'DELETE' })).status).toBe(204)
    const g = await api('/api/integrations/payment-gateways')
    expect(g.body.gateways.find((x: any) => x.gateway === 'razorpay').is_default).toBe(true)
    expect(g.body.gateways.find((x: any) => x.gateway === 'cashfree').configured).toBe(false)
    await saveCashfree()
  })

  it('Test proves the keys with an authenticated read call', async () => {
    await saveRazorpay(); await saveCashfree()
    reply = (url) => (url.startsWith('https://api.razorpay.com/v1/payment_links') ? json(200, { entity: 'collection', count: 0, payment_links: [] }) : json(500, {}))
    const ok = await api('/api/integrations/payment-gateways/test', { method: 'POST', body: { gateway: 'razorpay' } })
    expect(ok.status).toBe(200)
    expect(calls[0].method).toBe('GET')
    // Fetch-all documents only payment_id / reference_id filters — no unlisted params.
    expect(calls[0].url).toBe('https://api.razorpay.com/v1/payment_links')
    expect(calls[0].headers.get('authorization')).toBe(`Basic ${Buffer.from('rzp_test_abc123:rzp_secret_value_xyz').toString('base64')}`)

    reply = () => json(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'The api key provided is invalid' } })
    const bad = await api('/api/integrations/payment-gateways/test', { method: 'POST', body: { gateway: 'razorpay' } })
    expect(bad.status).toBe(400)
    expect(bad.body.error.message).toMatch(/rejected the keys.*api key provided is invalid/)

    // Cashfree: an unknown link → 404 means the keys passed authentication.
    calls = []
    reply = () => json(404, { message: 'link does not exist', code: 'link_not_found', type: 'invalid_request_error' })
    const cfOk = await api('/api/integrations/payment-gateways/test', { method: 'POST', body: { gateway: 'cashfree' } })
    expect(cfOk.status).toBe(200)
    expect(calls[0].url).toMatch(/^https:\/\/sandbox\.cashfree\.com\/pg\/links\//)
    expect(calls[0].headers.get('x-client-id')).toBe('TEST1234APPID')
    expect(calls[0].headers.get('x-client-secret')).toBe(CF_SECRET)
    expect(calls[0].headers.get('x-api-version')).toBe('2026-01-01')
    reply = () => json(401, { message: 'authentication Failed', code: 'request_failed', type: 'authentication_error' })
    expect((await api('/api/integrations/payment-gateways/test', { method: 'POST', body: { gateway: 'cashfree' } })).status).toBe(400)
  })
})

describe('creating a payment link', () => {
  beforeAll(async () => {
    calls = []; reply = defaultReply; __setGatewayFetchForTests(mockFetch)
    await saveRazorpay(); await saveCashfree()
    await api('/api/integrations/payment-gateways/razorpay/default', { method: 'POST' })
  })

  it('Razorpay: a link for the balance due at the default gateway', async () => {
    const inv = await sentInvoice()
    const r = await createLink(inv.id)
    expect(r.status).toBe(200)
    expect(r.body.link).toMatchObject({ gateway: 'razorpay', url: 'https://rzp.io/i/abc', amount_paise: 11_800_00, status: 'created' })
    const c = calls[0]
    expect(c.url).toBe('https://api.razorpay.com/v1/payment_links')
    expect(c.method).toBe('POST')
    expect(c.headers.get('authorization')).toBe(`Basic ${Buffer.from('rzp_test_abc123:rzp_secret_value_xyz').toString('base64')}`)
    expect(c.body).toMatchObject({ amount: 11_800_00, currency: 'INR', accept_partial: false, notify: { sms: false, email: false } })
    expect(c.body.reference_id.length).toBeLessThanOrEqual(40)
    expect(c.body.reference_id).toContain(inv.invoice_number)
    expect(c.body.customer).toMatchObject({ name: 'Link Co', email: 'pay@link.co', contact: '9876543210' })

    // Pressing it again with the same balance returns the same open link.
    const again = await createLink(inv.id)
    expect(again.body.link.id).toBe(r.body.link.id)
    expect(calls.length).toBe(1)

    const list = await api(`/api/invoices/${inv.id}/payment-links`)
    expect(list.status).toBe(200)
    expect(list.body.items).toHaveLength(1)
    expect(list.body.default_gateway).toBe('razorpay')
  })

  it('Cashfree: amount in rupees, link_id within its charset, phone required', async () => {
    const inv = await sentInvoice()
    await prisma.invoicePayment.deleteMany({ where: { invoiceId: inv.id } })
    // Part-paid first: the link is for what is still due.
    expect((await api(`/api/invoices/${inv.id}/payments`, { method: 'POST', body: { amount_paise: 1_800_00, paid_on: '2026-10-02' } })).status).toBe(200)
    const r = await createLink(inv.id, 'cashfree')
    expect(r.status).toBe(200)
    const c = calls[0]
    expect(c.url).toBe('https://sandbox.cashfree.com/pg/links')
    expect(c.headers.get('x-api-version')).toBe('2026-01-01')
    expect(c.body).toMatchObject({ link_amount: 10000, link_currency: 'INR', link_partial_payments: false, customer_details: { customer_phone: '9876543210', customer_email: 'pay@link.co', customer_name: 'Link Co' } })
    expect(c.body.link_id).toMatch(/^[A-Za-z0-9_-]{1,50}$/)
    expect(r.body.link).toMatchObject({ gateway: 'cashfree', gateway_link_id: c.body.link_id, amount_paise: 10_000_00 })

    // No phone on the client → a clear 400, no gateway call.
    const noPhone = await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'No Phone', accountManagerId: (await prisma.user.findFirstOrThrow({ where: { organisationId: orgId, employeeId: { not: null } } })).employeeId!, contactPerson: 'P', contactNumber: '', onboardingDate: '2026-01-01' } })
    const d = await api('/api/invoices', { method: 'POST', body: { client_id: noPhone.id, invoice_date: '2026-10-01', terms: 'net_15', place_of_supply: 'Tamil Nadu', items: [{ item_name: 'Fee', hsn_sac: '998221', quantity_centi: 100, rate_paise: 1000_00, gst_rate_percent: 18 }] } })
    await api(`/api/invoices/${d.body.id}/send`, { method: 'POST' })
    calls = []
    const refused = await createLink(d.body.id, 'cashfree')
    expect(refused.status).toBe(400)
    expect(refused.body.error.message).toMatch(/phone/i)
    expect(calls).toHaveLength(0)
  })

  it('refuses drafts, cancelled and fully paid invoices, and unconfigured gateways', async () => {
    const d = await api('/api/invoices', { method: 'POST', body: { client_id: clientId, invoice_date: '2026-10-01', terms: 'net_15', place_of_supply: 'Tamil Nadu', items: [{ item_name: 'Fee', hsn_sac: '998221', quantity_centi: 100, rate_paise: 1000_00, gst_rate_percent: 18 }] } })
    expect((await createLink(d.body.id)).status).toBe(409)

    const c = await sentInvoice()
    expect((await api(`/api/invoices/${c.id}/cancel`, { method: 'POST', body: { reason: 'wrong' } })).status).toBe(200)
    const cancelled = await createLink(c.id)
    expect(cancelled.status).toBe(409)
    expect(cancelled.body.error.code).toBe('invoice_cancelled')

    const p = await sentInvoice()
    await api(`/api/invoices/${p.id}/payments`, { method: 'POST', body: { amount_paise: p.total_paise, paid_on: '2026-10-02' } })
    expect((await createLink(p.id)).status).toBe(409)

    const other = await sentInvoice()
    await prisma.paymentGatewayConfig.updateMany({ where: { organisationId: orgId, gateway: 'cashfree' }, data: { active: false } })
    expect((await createLink(other.id, 'cashfree')).status).toBe(400)
    await prisma.paymentGatewayConfig.updateMany({ where: { organisationId: orgId, gateway: 'cashfree' }, data: { active: true } })
    expect(calls).toHaveLength(0)
  })

  it('a gateway error comes back readable', async () => {
    const inv = await sentInvoice()
    reply = () => json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'customer contact is invalid' } })
    const r = await createLink(inv.id, 'razorpay')
    expect(r.status).toBe(502)
    expect(r.body.error.message).toMatch(/Razorpay.*customer contact is invalid/)
  })

  it('needs the invoice payment permission', async () => {
    const inv = await sentInvoice()
    // Staff without the firm-wide invoice permission cannot see it (404) or act on it (403).
    expect([403, 404]).toContain((await api(`/api/invoices/${inv.id}/payment-links`, { method: 'POST', cookie: staffCookie, body: {} })).status)
    expect(calls).toHaveLength(0)
  })
})

describe('Razorpay webhook', () => {
  let inv: { id: string; total_paise: number }
  let link: { id: string; gateway_link_id: string }
  beforeEach(async () => {
    await saveRazorpay()
    inv = await sentInvoice()
    link = (await createLink(inv.id, 'razorpay')).body.link
  })

  it('rejects a bad or missing signature with 401', async () => {
    const raw = rzpEvent('payment_link.paid', link.gateway_link_id, { id: `pay_${uid('p')}`, amount: inv.total_paise })
    expect((await hook('razorpay', raw, { 'x-razorpay-signature': rzpSig(raw, 'wrong') })).status).toBe(401)
    expect((await hook('razorpay', raw, {})).status).toBe(401)
    expect(await livePayments(inv.id)).toHaveLength(0)
  })

  it('a paid event records exactly one payment; a replay records nothing more', async () => {
    const payId = `pay_${uid('p')}`
    const raw = rzpEvent('payment_link.paid', link.gateway_link_id, { id: payId, amount: inv.total_paise, method: 'card' })
    const r1 = await hook('razorpay', raw, { 'x-razorpay-signature': rzpSig(raw) })
    expect(r1.status).toBe(200)
    const r2 = await hook('razorpay', raw, { 'x-razorpay-signature': rzpSig(raw) })
    expect(r2.status).toBe(200)
    const rows = await livePayments(inv.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ amountPaise: inv.total_paise, mode: 'card', reference: payId, externalPaymentId: `razorpay:${payId}`, paidOn: '2026-10-05' })
    const i = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })
    expect(i.status).toBe('paid')
    expect(i.balanceDuePaise).toBe(0)
    const l = await prisma.invoicePaymentLink.findUniqueOrThrow({ where: { id: link.id } })
    expect(l).toMatchObject({ status: 'paid', paidPaise: inv.total_paise, recordedPaymentIds: [payId] })
  })

  it('a partial payment leaves the invoice partly paid; an uncaptured one is ignored', async () => {
    const raw = rzpEvent('payment_link.partially_paid', link.gateway_link_id, { id: `pay_${uid('p')}`, amount: 5_000_00 }, 'partially_paid')
    expect((await hook('razorpay', raw, { 'x-razorpay-signature': rzpSig(raw) })).status).toBe(200)
    const auth = rzpEvent('payment_link.paid', link.gateway_link_id, { id: `pay_${uid('p')}`, amount: 6_800_00, status: 'authorized' })
    expect((await hook('razorpay', auth, { 'x-razorpay-signature': rzpSig(auth) })).status).toBe(200)
    const i = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })
    expect(i.status).toBe('partially_paid')
    expect(i.balanceDuePaise).toBe(6_800_00)
    expect(await livePayments(inv.id)).toHaveLength(1)
  })

  it('never records above the balance due; the excess is flagged on the link', async () => {
    // ₹10,000 typed in by hand meanwhile; then the full ₹11,800 arrives online.
    await api(`/api/invoices/${inv.id}/payments`, { method: 'POST', body: { amount_paise: 10_000_00, paid_on: '2026-10-02' } })
    const payId = `pay_${uid('p')}`
    const raw = rzpEvent('payment_link.paid', link.gateway_link_id, { id: payId, amount: inv.total_paise })
    expect((await hook('razorpay', raw, { 'x-razorpay-signature': rzpSig(raw) })).status).toBe(200)
    const rows = await livePayments(inv.id)
    expect(rows.map((r) => r.amountPaise).sort((a, b) => a - b)).toEqual([1_800_00, 10_000_00])
    const l = await prisma.invoicePaymentLink.findUniqueOrThrow({ where: { id: link.id } })
    expect(l.paidPaise).toBe(1_800_00)
    expect(l.excessPaise).toBe(10_000_00)
    // Replay: nothing more, no double-flag.
    await hook('razorpay', raw, { 'x-razorpay-signature': rzpSig(raw) })
    expect((await prisma.invoicePaymentLink.findUniqueOrThrow({ where: { id: link.id } })).excessPaise).toBe(10_000_00)
  })

  it('a removed gateway payment is not re-recorded by a replay', async () => {
    const payId = `pay_${uid('p')}`
    const raw = rzpEvent('payment_link.paid', link.gateway_link_id, { id: payId, amount: inv.total_paise })
    await hook('razorpay', raw, { 'x-razorpay-signature': rzpSig(raw) })
    const [row] = await livePayments(inv.id)
    expect((await api(`/api/invoices/${inv.id}/payments/${row.id}`, { method: 'DELETE' })).status).toBe(200)
    await hook('razorpay', raw, { 'x-razorpay-signature': rzpSig(raw) })
    expect(await livePayments(inv.id)).toHaveLength(0)
  })

  it('valid-signature events for unknown links or other event types are acknowledged and ignored', async () => {
    const unknown = rzpEvent('payment_link.paid', `plink_${uid('nope')}`, { id: `pay_${uid('p')}`, amount: 100_00 })
    const r = await hook('razorpay', unknown, { 'x-razorpay-signature': rzpSig(unknown) })
    expect(r.status).toBe(200)
    expect(r.body.ignored).toBeTruthy()
    // Unknown link AND a signature no firm's secret produces → 401.
    expect((await hook('razorpay', unknown, { 'x-razorpay-signature': rzpSig(unknown, 'nobody') })).status).toBe(401)

    const other = JSON.stringify({ entity: 'event', event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', amount: 1 } } } })
    expect((await hook('razorpay', other, { 'x-razorpay-signature': rzpSig(other) })).status).toBe(200)

    const expired = rzpEvent('payment_link.expired', link.gateway_link_id, null, 'expired')
    expect((await hook('razorpay', expired, { 'x-razorpay-signature': rzpSig(expired) })).status).toBe(200)
    expect((await prisma.invoicePaymentLink.findUniqueOrThrow({ where: { id: link.id } })).status).toBe('expired')
  })

  it('a paid event for a cancelled invoice records nothing and flags the money', async () => {
    const c = await sentInvoice()
    const l = (await createLink(c.id, 'razorpay')).body.link
    expect((await api(`/api/invoices/${c.id}/cancel`, { method: 'POST', body: { reason: 'dup' } })).status).toBe(200)
    const raw = rzpEvent('payment_link.paid', l.gateway_link_id, { id: `pay_${uid('p')}`, amount: c.total_paise })
    expect((await hook('razorpay', raw, { 'x-razorpay-signature': rzpSig(raw) })).status).toBe(200)
    expect(await livePayments(c.id)).toHaveLength(0)
    expect((await prisma.invoicePaymentLink.findUniqueOrThrow({ where: { id: l.id } })).excessPaise).toBe(c.total_paise)
  })

  it('a malformed body with no signature match is 400/401, never 500', async () => {
    const r = await hook('razorpay', 'not json', { 'x-razorpay-signature': rzpSig('not json') })
    expect([200, 400]).toContain(r.status)
    expect((await hook('razorpay', 'not json', { 'x-razorpay-signature': 'x' })).status).toBe(401)
  })

  it('Check status records captured payments once — also after the webhook already did', async () => {
    const payId = `pay_${uid('p')}`
    const raw = rzpEvent('payment_link.partially_paid', link.gateway_link_id, { id: payId, amount: 5_000_00 }, 'partially_paid')
    await hook('razorpay', raw, { 'x-razorpay-signature': rzpSig(raw) })
    const pay2 = `pay_${uid('p')}`
    reply = (url) => (url === `https://api.razorpay.com/v1/payment_links/${link.gateway_link_id}`
      ? json(200, {
        id: link.gateway_link_id, status: 'paid', amount: inv.total_paise, amount_paid: inv.total_paise,
        payments: [
          { payment_id: payId, amount: 5_000_00, method: 'upi', status: 'captured', created_at: 1759644000 },
          { payment_id: pay2, amount: 6_800_00, method: 'netbanking', status: 'captured', created_at: 1759644000 },
          { payment_id: `pay_${uid('f')}`, amount: 100, method: 'card', status: 'failed', created_at: 1759644000 },
        ],
      })
      : json(500, {}))
    const r1 = await api(`/api/invoices/${inv.id}/payment-links/${link.id}/check`, { method: 'POST' })
    expect(r1.status).toBe(200)
    expect(r1.body.recorded).toBe(1)
    expect(r1.body.link.status).toBe('paid')
    const r2 = await api(`/api/invoices/${inv.id}/payment-links/${link.id}/check`, { method: 'POST' })
    expect(r2.body.recorded).toBe(0)
    const rows = await livePayments(inv.id)
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.reference === pay2)?.mode).toBe('bank_transfer')
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('paid')
  })

  it('concurrent webhook deliveries of the same payment record it once', async () => {
    const raw = rzpEvent('payment_link.paid', link.gateway_link_id, { id: `pay_${uid('p')}`, amount: inv.total_paise })
    const rs = await Promise.all([1, 2, 3].map(() => hook('razorpay', raw, { 'x-razorpay-signature': rzpSig(raw) })))
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200])
    expect(await livePayments(inv.id)).toHaveLength(1)
  })
})

describe('Cashfree webhook', () => {
  let inv: { id: string; total_paise: number }
  let link: { id: string; gateway_link_id: string }
  beforeEach(async () => {
    await saveCashfree()
    inv = await sentInvoice()
    link = (await createLink(inv.id, 'cashfree')).body.link
  })

  it('rejects a bad signature', async () => {
    const raw = cfEvent(link.gateway_link_id, { order_id: `CFPay_${uid('o')}`, order_amount: '11800.00' })
    expect((await hook('cashfree', raw, cfHeaders(raw, 'wrong'))).status).toBe(401)
    expect((await hook('cashfree', raw, {})).status).toBe(401)
    expect(await livePayments(inv.id)).toHaveLength(0)
  })

  it('a SUCCESS order records once, keyed on the order id; replay is a no-op', async () => {
    const orderId = `CFPay_${uid('o')}`
    const raw = cfEvent(link.gateway_link_id, { order_id: orderId, order_amount: '5000.50', transaction_id: 99887766 }, 'PARTIALLY_PAID')
    expect((await hook('cashfree', raw, cfHeaders(raw))).status).toBe(200)
    expect((await hook('cashfree', raw, cfHeaders(raw))).status).toBe(200)
    const rows = await livePayments(inv.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ amountPaise: 5_000_50, reference: '99887766', externalPaymentId: `cashfree:${orderId}`, paidOn: '2026-10-05' })
    const l = await prisma.invoicePaymentLink.findUniqueOrThrow({ where: { id: link.id } })
    expect(l.status).toBe('partially_paid')
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('partially_paid')

    // Check status afterwards sees the same order → nothing new.
    reply = (url) => {
      if (url === `https://sandbox.cashfree.com/pg/links/${link.gateway_link_id}`) return json(200, { link_id: link.gateway_link_id, link_status: 'PARTIALLY_PAID', link_amount: 11800, link_amount_paid: 5000.5 })
      if (url === `https://sandbox.cashfree.com/pg/links/${link.gateway_link_id}/orders?status=PAID`) return json(200, [{ order_id: orderId, order_amount: 5000.5, order_status: 'PAID', created_at: '2026-10-05T12:00:00+05:30' }])
      return json(500, {})
    }
    const chk = await api(`/api/invoices/${inv.id}/payment-links/${link.id}/check`, { method: 'POST' })
    expect(chk.status).toBe(200)
    expect(chk.body.recorded).toBe(0)
    expect(await livePayments(inv.id)).toHaveLength(1)
  })

  it('ignores non-SUCCESS transactions and unknown links (valid signature → 200)', async () => {
    const failed = cfEvent(link.gateway_link_id, { order_id: `CFPay_${uid('o')}`, order_amount: '11800.00', transaction_status: 'FAILED' })
    expect((await hook('cashfree', failed, cfHeaders(failed))).status).toBe(200)
    const unknown = cfEvent(`AOS_${uid('nope')}`, { order_id: `CFPay_${uid('o')}`, order_amount: '1.00' })
    const r = await hook('cashfree', unknown, cfHeaders(unknown))
    expect(r.status).toBe(200)
    expect(r.body.ignored).toBeTruthy()
    expect(await livePayments(inv.id)).toHaveLength(0)
  })

  it('Check status records PAID orders once', async () => {
    const o1 = `CFPay_${uid('o')}`
    reply = (url) => {
      if (url === `https://sandbox.cashfree.com/pg/links/${link.gateway_link_id}`) return json(200, { link_id: link.gateway_link_id, link_status: 'PAID', link_amount: 11800, link_amount_paid: 11800 })
      if (url === `https://sandbox.cashfree.com/pg/links/${link.gateway_link_id}/orders?status=PAID`) return json(200, [{ order_id: o1, order_amount: 11800, order_status: 'PAID', created_at: '2026-10-06T10:00:00+05:30' }])
      return json(500, {})
    }
    const r1 = await api(`/api/invoices/${inv.id}/payment-links/${link.id}/check`, { method: 'POST' })
    expect(r1.status).toBe(200)
    expect(r1.body.recorded).toBe(1)
    expect(calls.every((c) => c.headers.get('x-client-secret') === CF_SECRET)).toBe(true)
    const r2 = await api(`/api/invoices/${inv.id}/payment-links/${link.id}/check`, { method: 'POST' })
    expect(r2.body.recorded).toBe(0)
    const rows = await livePayments(inv.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ amountPaise: 11_800_00, paidOn: '2026-10-06', externalPaymentId: `cashfree:${o1}` })
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('paid')
  })
})
