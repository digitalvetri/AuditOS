/**
 * Integrations → AI provider.
 *
 * Providers: Claude (anthropic), OpenAI, Google Gemini and Groq. One row per
 * (organisation, provider); the API key is AES-256-GCM encrypted at rest and
 * GET never returns it (only a fingerprint of the ciphertext for recognition).
 * One provider is current per firm (Organisation.aiProvider) — see
 * ./llm.ts for how it is resolved, including the GROQ_API_KEY env fallback.
 *
 * Routes:
 *   GET    /api/integrations/ai                      every provider + which one is current
 *   PUT    /api/integrations/ai                      upsert — body { provider, api_key, model? };
 *                                                    the firm's first key becomes current
 *   POST   /api/integrations/ai/test                 "reply with OK" ping — body { provider, api_key?, model? };
 *                                                    without api_key the saved key is used
 *   POST   /api/integrations/ai/:provider/activate   "Use this provider"
 *   DELETE /api/integrations/ai/:provider            remove; if it was current, the next saved one takes over
 *
 * Permission: integrations.access@organisation (same gate as Zoho Payments).
 */
import { Router } from 'express'
import { prisma } from '../../lib/prisma.js'
import { ApiError, handler, noContent, ok } from '../../lib/http.js'
import { requirePermission, requireSession } from '../../platform/auth.js'
import { decryptPortalSecret, encryptPortalSecret } from '../../platform/portalCrypto.js'
import {
  AI_PROVIDERS, PROVIDER_INFO, currentProviderRow, isAiProvider, testProviderKey, type AiProvider,
} from './llm.js'

export const integrationsAiRouter = Router()

integrationsAiRouter.use(requirePermission('integrations.access', 'organisation'))

async function orgIdFor(userId: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { organisationId: true },
  })
  return user.organisationId
}

function assertProvider(v: unknown): AiProvider {
  if (!isAiProvider(v)) throw ApiError.badRequest(`provider must be one of: ${AI_PROVIDERS.join(', ')}`)
  return v
}

function keyPrefix(cipher: string): string {
  // The stored value is ciphertext — we never show the real plaintext. Instead
  // we return a stable fingerprint derived from the ciphertext bytes so the UI
  // can show "last saved key …" without ever decrypting it client-side.
  // (The IV changes on every encrypt, so rotating the key changes it.)
  return cipher.slice(0, 8) + '…'
}

/** The page's whole state: every provider, configured or not, and the current one. */
async function overview(orgId: string) {
  const [rows, current] = await Promise.all([
    prisma.aiProviderConfig.findMany({ where: { organisationId: orgId, active: true } }),
    currentProviderRow(orgId),
  ])
  const envFallback = !current && !!process.env.GROQ_API_KEY?.trim()
  const currentProvider = (current?.provider as AiProvider | undefined) ?? (envFallback ? 'groq' : null)
  return {
    current_provider: currentProvider,
    env_fallback: envFallback,
    providers: AI_PROVIDERS.map((provider) => {
      const row = rows.find((r) => r.provider === provider)
      return {
        provider,
        label: PROVIDER_INFO[provider].label,
        key_url: PROVIDER_INFO[provider].keyUrl,
        default_model: PROVIDER_INFO[provider].defaultModel,
        configured: !!row,
        key_fingerprint: row ? keyPrefix(row.apiKeyCiphertext) : null,
        model: row?.model ?? null,
        is_current: provider === currentProvider,
        updated_at: row?.updatedAt ?? null,
      }
    }),
  }
}

integrationsAiRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  ok(res, await overview(await orgIdFor(session.userId)))
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

  // The firm's first key becomes the current provider.
  const hadProvider = !!(await currentProviderRow(orgId))
  await prisma.$transaction(async (tx) => {
    await tx.aiProviderConfig.upsert({
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
        // A key rotation without a model field keeps the saved model.
        ...(model ? { model } : {}),
        active: true,
        updatedBy: session.employeeId ?? null,
      },
    })
    if (!hadProvider) await tx.organisation.update({ where: { id: orgId }, data: { aiProvider: provider } })
  })
  ok(res, await overview(orgId))
}))

integrationsAiRouter.post('/test', handler(async (req, res) => {
  const session = requireSession(req)
  const provider = assertProvider(req.body?.provider)
  let apiKey = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : ''
  let model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : null
  if (!apiKey) {
    // No key typed → test the saved one.
    const orgId = await orgIdFor(session.userId)
    const row = await prisma.aiProviderConfig.findFirst({ where: { organisationId: orgId, provider, active: true } })
    const saved = row ? decryptPortalSecret(row.apiKeyCiphertext, `ai_provider.${provider}.apiKey`) : null
    if (!saved) throw ApiError.badRequest('Enter an API key to test, or save one first.')
    apiKey = saved
    model = model ?? row?.model ?? null
  }
  try {
    const r = await testProviderKey(provider, apiKey, model)
    ok(res, { ok: true, provider, model: r.model })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    throw new ApiError(400, 'provider_rejected', `The provider rejected the key: ${msg}`)
  }
}))

integrationsAiRouter.post('/:provider/activate', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const provider = assertProvider(req.params.provider)
  const row = await prisma.aiProviderConfig.findFirst({ where: { organisationId: orgId, provider, active: true }, select: { id: true } })
  if (!row) throw ApiError.badRequest(`Save a ${PROVIDER_INFO[provider].label} API key before using it.`)
  await prisma.organisation.update({ where: { id: orgId }, data: { aiProvider: provider } })
  ok(res, await overview(orgId))
}))

integrationsAiRouter.delete('/:provider', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const provider = assertProvider(req.params.provider)
  await prisma.$transaction(async (tx) => {
    await tx.aiProviderConfig.deleteMany({ where: { organisationId: orgId, provider } })
    const org = await tx.organisation.findUnique({ where: { id: orgId }, select: { aiProvider: true } })
    if (org?.aiProvider === provider) {
      // The removed provider was current: hand over to the next saved one (or none → env fallback).
      const next = await tx.aiProviderConfig.findFirst({
        where: { organisationId: orgId, active: true, provider: { in: [...AI_PROVIDERS] } },
        orderBy: [{ createdAt: 'asc' }, { provider: 'asc' }],
        select: { provider: true },
      })
      await tx.organisation.update({ where: { id: orgId }, data: { aiProvider: next?.provider ?? null } })
    }
  })
  noContent(res)
}))
