/**
 * Groq client wrapper. Keys are resolved per-request:
 *   1. The organisation's own AiProviderConfig.apiKey (encrypted at rest),
 *      set by the firm from Integrations → AI provider.
 *   2. The server-wide GROQ_API_KEY env var, as a fallback for firms that
 *      haven't configured their own yet (so the Notices feature works out
 *      of the box in a dev stack).
 * The model follows the same precedence: AiProviderConfig.model, else env
 * GROQ_MODEL, else the hard-coded default.
 *
 * We create a Groq client per call rather than caching one, because the key
 * can change per organisation and the SDK bakes it in at construction.
 */
import Groq from 'groq-sdk'
import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import { decryptPortalSecret } from '../../platform/portalCrypto.js'
import { maskPersonalData } from './mask.js'

export const AI_DISABLED_MESSAGE = 'AI drafting is switched off for this firm.'

/**
 * Organisation.aiExternalProcessing — the firm's switch for sending client
 * text to an outside AI service. Off → 409 `ai_disabled`.
 */
export async function assertAiAllowed(organisationId: string): Promise<void> {
  const org = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { aiExternalProcessing: true } })
  // Fail closed: no firm row means no consent to send anything out.
  if (!org || !org.aiExternalProcessing) throw ApiError.conflict('ai_disabled', AI_DISABLED_MESSAGE)
}

export const DEFAULT_GROQ_MODEL = process.env.GROQ_MODEL?.trim() || 'openai/gpt-oss-120b'

export async function resolveGroqConfig(organisationId: string): Promise<{ apiKey: string; model: string }> {
  const row = await prisma.aiProviderConfig.findFirst({
    where: { organisationId, provider: 'groq', active: true },
    select: { apiKeyCiphertext: true, model: true },
  })
  if (row) {
    const apiKey = decryptPortalSecret(row.apiKeyCiphertext, 'ai_provider.groq.apiKey')
    if (apiKey) return { apiKey, model: row.model?.trim() || DEFAULT_GROQ_MODEL }
  }
  const envKey = process.env.GROQ_API_KEY?.trim()
  if (envKey) return { apiKey: envKey, model: DEFAULT_GROQ_MODEL }
  throw new ApiError(503, 'llm_unconfigured',
    'The LLM is not configured for this organisation. Go to Integrations → AI provider to add a Groq API key.')
}

/** JSON-mode completion. Response is the parsed body — caller validates shape. */
export async function complete<T = unknown>(args: {
  organisationId: string
  system: string
  user: string
  temperature?: number
  json?: boolean
}): Promise<{ content: T; model: string }> {
  await assertAiAllowed(args.organisationId)
  const cfg = await resolveGroqConfig(args.organisationId)
  const groq = new Groq({ apiKey: cfg.apiKey })
  const r = await groq.chat.completions.create({
    model: cfg.model,
    temperature: args.temperature ?? 0.2,
    response_format: args.json ? { type: 'json_object' } : undefined,
    messages: [
      { role: 'system', content: args.system },
      // PAN, GSTIN, Aadhaar, phone and email never leave the server.
      { role: 'user', content: maskPersonalData(args.user) },
    ],
  })
  const raw = r.choices[0]?.message?.content ?? ''
  if (!raw) throw new ApiError(502, 'llm_empty', 'The LLM returned an empty response.')
  if (args.json) {
    try {
      return { content: JSON.parse(raw) as T, model: cfg.model }
    } catch {
      throw new ApiError(502, 'llm_bad_json', 'The LLM response was not valid JSON.')
    }
  }
  return { content: raw as unknown as T, model: cfg.model }
}

/** Ping-test — one tiny completion to confirm the key resolves to a working provider. */
export async function testGroqKey(apiKey: string, model: string): Promise<{ ok: true; model: string }> {
  const groq = new Groq({ apiKey })
  const r = await groq.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: 8,
    messages: [{ role: 'user', content: 'ping' }],
  })
  const content = r.choices[0]?.message?.content ?? ''
  if (!content) throw new Error('empty_response')
  return { ok: true, model }
}
