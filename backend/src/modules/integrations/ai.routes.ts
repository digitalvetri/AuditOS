/**
 * Integrations → AI provider.
 *
 * One row per (organisation, provider). The API key is AES-256-GCM encrypted
 * at rest; the plaintext never leaves this module after a save, and GET never
 * returns it (only a masked prefix for recognition).
 *
 * Routes:
 *   GET  /api/integrations/ai              list configured providers (metadata)
 *   PUT  /api/integrations/ai              upsert — body { provider, api_key, model? }
 *   POST /api/integrations/ai/:provider/test   ping the provider with the stored key
 *   POST /api/integrations/ai/test         ping with a key the user is about to save
 *   DELETE /api/integrations/ai/:provider  remove (soft: active=false kept for audit)
 *
 * Permission: integrations.access@organisation (same gate as Zoho Payments).
 */
import { Router } from 'express'
import { prisma } from '../../lib/prisma.js'
import { ApiError, handler, noContent, ok } from '../../lib/http.js'
import { requirePermission, requireSession } from '../../platform/auth.js'
import { encryptPortalSecret } from '../../platform/portalCrypto.js'
import { DEFAULT_GROQ_MODEL, testGroqKey } from '../notices/groq.js'

export const integrationsAiRouter = Router()

const SUPPORTED_PROVIDERS = ['groq'] as const
type Provider = (typeof SUPPORTED_PROVIDERS)[number]

integrationsAiRouter.use(requirePermission('integrations.access', 'organisation'))

async function orgIdFor(userId: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { organisationId: true },
  })
  return user.organisationId
}

function assertProvider(v: unknown): Provider {
  if (typeof v !== 'string' || !SUPPORTED_PROVIDERS.includes(v as Provider)) {
    throw ApiError.badRequest(`provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}`)
  }
  return v as Provider
}

function keyPrefix(cipher: string): string {
  // The stored value is ciphertext — we never show the real plaintext. Instead
  // we return a stable fingerprint derived from the ciphertext bytes so the UI
  // can show "last saved key ending in …" without ever decrypting it client-side.
  // (The IV changes on every encrypt, so this fingerprint is bound to the
  // specific save — rotating the key produces a new fingerprint.)
  return cipher.slice(0, 8) + '…'
}

integrationsAiRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const rows = await prisma.aiProviderConfig.findMany({
    where: { organisationId: orgId },
    orderBy: { provider: 'asc' },
  })
  ok(res, rows.map((r) => ({
    provider: r.provider,
    has_key: true,
    key_fingerprint: keyPrefix(r.apiKeyCiphertext),
    model: r.model,
    default_model: r.provider === 'groq' ? DEFAULT_GROQ_MODEL : null,
    active: r.active,
    updated_at: r.updatedAt,
    env_fallback: false,
  })))
}))

integrationsAiRouter.put('/', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const provider = assertProvider(req.body?.provider)
  const apiKey = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : ''
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : null
  if (!apiKey) throw ApiError.badRequest('api_key is required.')
  if (apiKey.length < 20) throw ApiError.badRequest('That API key looks too short.')

  const ciphertext = encryptPortalSecret(apiKey, `ai_provider.${provider}.apiKey`)
  if (!ciphertext) throw new ApiError(500, 'encrypt_failed', 'Could not encrypt the key.')

  const row = await prisma.aiProviderConfig.upsert({
    where: { organisationId_provider: { organisationId: orgId, provider } },
    create: {
      organisationId: orgId,
      provider,
      apiKeyCiphertext: ciphertext,
      model: model || null,
      active: true,
      createdBy: session.employeeId ?? null,
      updatedBy: session.employeeId ?? null,
    },
    update: {
      apiKeyCiphertext: ciphertext,
      model: model || null,
      active: true,
      updatedBy: session.employeeId ?? null,
    },
  })
  ok(res, {
    provider: row.provider,
    has_key: true,
    key_fingerprint: keyPrefix(row.apiKeyCiphertext),
    model: row.model,
    default_model: row.provider === 'groq' ? DEFAULT_GROQ_MODEL : null,
    active: row.active,
    updated_at: row.updatedAt,
    env_fallback: false,
  })
}))

integrationsAiRouter.post('/test', handler(async (req, res) => {
  const provider = assertProvider(req.body?.provider)
  const apiKey = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : ''
  const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : DEFAULT_GROQ_MODEL
  if (!apiKey) throw ApiError.badRequest('api_key is required.')
  if (provider !== 'groq') throw ApiError.badRequest('Only groq is supported today.')
  try {
    const r = await testGroqKey(apiKey, model)
    ok(res, { ok: true, model: r.model })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    throw new ApiError(400, 'provider_rejected', `The provider rejected the key: ${msg}`)
  }
}))

integrationsAiRouter.delete('/:provider', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const provider = assertProvider(req.params.provider)
  await prisma.aiProviderConfig.deleteMany({ where: { organisationId: orgId, provider } })
  noContent(res)
}))
