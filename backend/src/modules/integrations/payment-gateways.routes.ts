/**
 * Integrations → Payment gateways (Razorpay, Cashfree).
 *
 * One row per (organisation, gateway); the secret key and the Razorpay
 * webhook secret are AES-256-GCM encrypted (encryptPortalSecret) and never
 * returned. One gateway is the firm's default — the one the invoice
 * "Payment link" button uses.
 *
 * Routes (mounted at /api/integrations/payment-gateways):
 *   GET    /                    every gateway + webhook URLs to paste in the gateway dashboard
 *   PUT    /                    upsert { gateway, mode, key_id, key_secret?, webhook_secret? };
 *                               key_secret is required the first time; the firm's first gateway becomes default
 *   POST   /test                authenticated read call { gateway, mode?, key_id?, key_secret? } (saved keys when omitted)
 *   POST   /:gateway/default    make it the default
 *   DELETE /:gateway            remove; if it was the default the other one (if any) takes over
 *
 * Zoho Payments is NOT offered here: its links are made for invoices imported
 * from Zoho Books (ZpayExternalInvoice) and its payments only reach our
 * invoices through the sync + matcher, so it keeps its own page.
 *
 * Permission: integrations.access@organisation.
 */
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { env } from '../../lib/env.js'
import { ApiError, handler, noContent, ok } from '../../lib/http.js'
import { requirePermission, requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { encryptPortalSecret } from '../../platform/portalCrypto.js'
import { GATEWAYS, GATEWAY_INFO, GATEWAY_MODES, GatewayError, isGateway, testCredentials, type Gateway, type GatewayMode } from './gateways.js'
import { credsOf, secretContext, webhookSecretContext, webhookUrl } from './payment-links.js'

export const paymentGatewaysRouter = Router()

paymentGatewaysRouter.use(requirePermission('integrations.access', 'organisation'))

async function orgIdFor(userId: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { organisationId: true } })
  return user.organisationId
}

function assertGateway(v: unknown): Gateway {
  if (!isGateway(v)) throw ApiError.badRequest(`gateway must be one of: ${GATEWAYS.join(', ')}`)
  return v
}

async function overview(orgId: string) {
  const rows = await prisma.paymentGatewayConfig.findMany({ where: { organisationId: orgId, active: true } })
  return {
    public_url_configured: !!env.publicAppUrl,
    webhook_urls: { razorpay: webhookUrl('razorpay'), cashfree: webhookUrl('cashfree') },
    gateways: GATEWAYS.map((gateway) => {
      const row = rows.find((r) => r.gateway === gateway)
      return {
        gateway,
        label: GATEWAY_INFO[gateway].label,
        key_id_label: GATEWAY_INFO[gateway].keyIdLabel,
        dashboard_url: GATEWAY_INFO[gateway].dashboardUrl,
        configured: !!row,
        mode: (row?.mode as GatewayMode | undefined) ?? null,
        key_id: row?.keyId ?? null,
        has_webhook_secret: !!row?.webhookSecretCiphertext,
        is_default: !!row?.isDefault,
        updated_at: row?.updatedAt ?? null,
      }
    }),
  }
}

const saveSchema = z.object({
  gateway: z.enum(GATEWAYS),
  mode: z.enum(GATEWAY_MODES),
  key_id: z.string().trim().min(4, 'Enter the key / app id.').max(200),
  key_secret: z.string().trim().min(8, 'That secret looks too short.').max(500).optional().or(z.literal('').transform(() => undefined)),
  webhook_secret: z.string().trim().min(4, 'That webhook secret looks too short.').max(500).optional().or(z.literal('').transform(() => undefined)),
})

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, message: string): z.infer<T> {
  const r = schema.safeParse(data)
  if (!r.success) throw ApiError.badRequest(message, r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
  return r.data
}

function encrypt(value: string, context: string): string {
  const c = encryptPortalSecret(value, context)
  if (!c) throw new ApiError(500, 'encrypt_failed', 'Could not encrypt the secret.')
  return c
}

paymentGatewaysRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  ok(res, await overview(await orgIdFor(session.userId)))
}))

paymentGatewaysRouter.put('/', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const b = parse(saveSchema, req.body, 'Check the gateway keys.')
  const existing = await prisma.paymentGatewayConfig.findUnique({ where: { organisationId_gateway: { organisationId: orgId, gateway: b.gateway } } })
  if (!b.key_secret && !existing) throw ApiError.badRequest(`Enter the ${GATEWAY_INFO[b.gateway].label} secret key.`)
  if (b.gateway === 'razorpay' && !b.key_id.startsWith('rzp_')) throw ApiError.badRequest('A Razorpay Key ID starts with rzp_test_ or rzp_live_.')
  await prisma.$transaction(async (tx) => {
    const hasDefault = !!(await tx.paymentGatewayConfig.findFirst({ where: { organisationId: orgId, active: true, isDefault: true, gateway: { not: b.gateway } }, select: { id: true } }))
    const data = {
      mode: b.mode,
      keyId: b.key_id,
      ...(b.key_secret ? { secretCiphertext: encrypt(b.key_secret, secretContext(b.gateway)) } : {}),
      ...(b.webhook_secret ? { webhookSecretCiphertext: encrypt(b.webhook_secret, webhookSecretContext(b.gateway)) } : {}),
      active: true,
      updatedBy: session.employeeId ?? null,
    }
    if (existing) {
      await tx.paymentGatewayConfig.update({ where: { id: existing.id }, data: { ...data, ...(hasDefault ? {} : { isDefault: true }) } })
    } else {
      await tx.paymentGatewayConfig.create({
        data: {
          ...data, organisationId: orgId, gateway: b.gateway, secretCiphertext: data.secretCiphertext!,
          isDefault: !hasDefault, createdBy: session.employeeId ?? null,
        },
      })
    }
  })
  await writeAudit({
    actorUserId: session.userId, action: 'payment_gateway.saved', entityType: 'PaymentGatewayConfig', entityId: `${orgId}:${b.gateway}`,
    after: { gateway: b.gateway, mode: b.mode, key_id: b.key_id, secret_changed: !!b.key_secret, webhook_secret_changed: !!b.webhook_secret }, req,
  })
  ok(res, await overview(orgId))
}))

paymentGatewaysRouter.post('/test', handler(async (req, res) => {
  const session = requireSession(req)
  const gateway = assertGateway(req.body?.gateway)
  const typedSecret = typeof req.body?.key_secret === 'string' ? req.body.key_secret.trim() : ''
  const typedKey = typeof req.body?.key_id === 'string' ? req.body.key_id.trim() : ''
  const typedMode = (GATEWAY_MODES as readonly string[]).includes(req.body?.mode) ? (req.body.mode as GatewayMode) : null
  const row = await prisma.paymentGatewayConfig.findFirst({ where: { organisationId: await orgIdFor(session.userId), gateway, active: true } })
  let creds
  if (typedSecret) {
    if (!typedKey) throw ApiError.badRequest('Enter the key / app id too.')
    creds = { gateway, mode: typedMode ?? (row?.mode as GatewayMode | undefined) ?? 'live', keyId: typedKey, secret: typedSecret }
  } else {
    if (!row) throw ApiError.badRequest('Enter the keys to test, or save them first.')
    creds = { ...credsOf(row), ...(typedMode ? { mode: typedMode } : {}), ...(typedKey ? { keyId: typedKey } : {}) }
  }
  try {
    await testCredentials(creds)
  } catch (e) {
    if (e instanceof GatewayError) throw new ApiError(400, 'gateway_rejected', `${GATEWAY_INFO[gateway].label} rejected the keys: ${e.message}`)
    throw e
  }
  ok(res, { ok: true, gateway, mode: creds.mode })
}))

paymentGatewaysRouter.post('/:gateway/default', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const gateway = assertGateway(req.params.gateway)
  const row = await prisma.paymentGatewayConfig.findFirst({ where: { organisationId: orgId, gateway, active: true }, select: { id: true } })
  if (!row) throw ApiError.badRequest(`Save the ${GATEWAY_INFO[gateway].label} keys first.`)
  await prisma.$transaction([
    prisma.paymentGatewayConfig.updateMany({ where: { organisationId: orgId, id: { not: row.id } }, data: { isDefault: false } }),
    prisma.paymentGatewayConfig.update({ where: { id: row.id }, data: { isDefault: true } }),
  ])
  ok(res, await overview(orgId))
}))

paymentGatewaysRouter.delete('/:gateway', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const gateway = assertGateway(req.params.gateway)
  await prisma.$transaction(async (tx) => {
    const row = await tx.paymentGatewayConfig.findUnique({ where: { organisationId_gateway: { organisationId: orgId, gateway } } })
    if (!row) return
    await tx.paymentGatewayConfig.delete({ where: { id: row.id } })
    if (row.isDefault) {
      const next = await tx.paymentGatewayConfig.findFirst({ where: { organisationId: orgId, active: true }, orderBy: { createdAt: 'asc' } })
      if (next) await tx.paymentGatewayConfig.update({ where: { id: next.id }, data: { isDefault: true } })
    }
  })
  await writeAudit({ actorUserId: session.userId, action: 'payment_gateway.removed', entityType: 'PaymentGatewayConfig', entityId: `${orgId}:${gateway}`, req })
  noContent(res)
}))
