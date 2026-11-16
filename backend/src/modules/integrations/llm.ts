/**
 * Provider-neutral LLM client used by every AI feature (GST Notices reply
 * drafter today). One active provider per firm:
 *
 *   1. Organisation.aiProvider, when that provider has a saved key.
 *   2. Otherwise the firm's first configured provider (oldest AiProviderConfig).
 *   3. Otherwise the server-wide GROQ_API_KEY env var (dev stacks, legacy).
 *   4. Otherwise 503 `llm_unconfigured`.
 *
 * Keys are AES-256-GCM encrypted at rest (AiProviderConfig.apiKeyCiphertext)
 * and decrypted per call; a client is built per call because the key varies
 * by organisation.
 *
 * Adapters:
 *   groq       groq-sdk chat completions (unchanged behaviour)
 *   anthropic  @anthropic-ai/sdk messages.create — no sampling params, no
 *              prefill; JSON via a system instruction + tolerant parse
 *   openai     fetch → api.openai.com chat completions (json_object mode);
 *              no temperature (GPT-5 models only accept the default)
 *   gemini     fetch → Google's OpenAI-compatible chat completions endpoint
 *
 * Every outbound request goes through one injectable fetch so tests never
 * touch the network.
 */
import Anthropic from '@anthropic-ai/sdk'
import Groq from 'groq-sdk'
import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import { decryptPortalSecret } from '../../platform/portalCrypto.js'
import { maskPersonalData } from '../notices/mask.js'

export const AI_PROVIDERS = ['anthropic', 'openai', 'gemini', 'groq'] as const
export type AiProvider = (typeof AI_PROVIDERS)[number]

export const DEFAULT_GROQ_MODEL = process.env.GROQ_MODEL?.trim() || 'openai/gpt-oss-120b'

export const PROVIDER_INFO: Record<AiProvider, { label: string; defaultModel: string; keyUrl: string }> = {
  anthropic: { label: 'Claude (Anthropic)', defaultModel: 'claude-opus-5-5', keyUrl: 'https://console.anthropic.com/settings/keys' },
  openai: { label: 'OpenAI', defaultModel: 'gpt-5', keyUrl: 'https://platform.openai.com/api-keys' },
  gemini: { label: 'Google Gemini', defaultModel: 'gemini-2.5-flash', keyUrl: 'https://aistudio.google.com/apikey' },
  groq: { label: 'Groq', defaultModel: DEFAULT_GROQ_MODEL, keyUrl: 'https://console.groq.com/keys' },
}

export function isAiProvider(v: unknown): v is AiProvider {
  return typeof v === 'string' && (AI_PROVIDERS as readonly string[]).includes(v)
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
const JSON_INSTRUCTION = 'Reply with a single JSON object only — no prose, no code fence.'

let fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a)
/** Tests swap the outbound fetch; pass null to restore the real one. */
export function __setLlmFetchForTests(f: typeof fetch | null): void {
  fetchImpl = f ?? ((...a) => globalThis.fetch(...a))
}
const outboundFetch: typeof fetch = (...a) => fetchImpl(...a)

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

type ConfigRow = { provider: string; apiKeyCiphertext: string; model: string | null }

/** The row the firm's AI features use, without decrypting it (null = none saved). */
export async function currentProviderRow(organisationId: string): Promise<ConfigRow | null> {
  const [org, rows] = await Promise.all([
    prisma.organisation.findUnique({ where: { id: organisationId }, select: { aiProvider: true } }),
    prisma.aiProviderConfig.findMany({
      where: { organisationId, active: true },
      orderBy: [{ createdAt: 'asc' }, { provider: 'asc' }],
      select: { provider: true, apiKeyCiphertext: true, model: true },
    }),
  ])
  const usable = rows.filter((r) => isAiProvider(r.provider))
  return usable.find((r) => r.provider === org?.aiProvider) ?? usable[0] ?? null
}

export interface LlmConfig {
  provider: AiProvider
  apiKey: string
  model: string
  source: 'firm' | 'env'
}

export async function resolveLlmConfig(organisationId: string): Promise<LlmConfig> {
  const row = await currentProviderRow(organisationId)
  if (row) {
    const provider = row.provider as AiProvider
    const apiKey = decryptPortalSecret(row.apiKeyCiphertext, `ai_provider.${provider}.apiKey`)
    if (apiKey) return { provider, apiKey, model: row.model?.trim() || PROVIDER_INFO[provider].defaultModel, source: 'firm' }
  }
  const envKey = process.env.GROQ_API_KEY?.trim()
  if (envKey) return { provider: 'groq', apiKey: envKey, model: DEFAULT_GROQ_MODEL, source: 'env' }
  throw new ApiError(503, 'llm_unconfigured',
    'The AI provider is not configured for this organisation. Go to Integrations → AI provider to add an API key.')
}

interface CallArgs {
  apiKey: string
  model: string
  system: string
  user: string
  temperature?: number
  json?: boolean
}

/** Error from a provider's HTTP API, carrying its own message. */
class ProviderHttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

async function chatCompletionsFetch(url: string, a: CallArgs, extra: Record<string, unknown>): Promise<string> {
  const res = await outboundFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.apiKey}` },
    body: JSON.stringify({
      model: a.model,
      messages: [{ role: 'system', content: a.system }, { role: 'user', content: a.user }],
      ...extra,
    }),
  })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { /* non-JSON error page */ }
  if (!res.ok) {
    // OpenAI → { error: { message } }; Gemini compat → [{ error: { message } }] or { error: { message } }.
    const err = Array.isArray(body) ? body[0]?.error : body?.error
    throw new ProviderHttpError(res.status, `${res.status} ${err?.message ?? (text.slice(0, 200) || res.statusText)}`)
  }
  return body?.choices?.[0]?.message?.content ?? ''
}

const adapters: Record<AiProvider, (a: CallArgs) => Promise<string>> = {
  async groq(a) {
    const groq = new Groq({ apiKey: a.apiKey, fetch: outboundFetch })
    const r = await groq.chat.completions.create({
      model: a.model,
      temperature: a.temperature ?? 0.2,
      response_format: a.json ? { type: 'json_object' } : undefined,
      messages: [{ role: 'system', content: a.system }, { role: 'user', content: a.user }],
    })
    return r.choices[0]?.message?.content ?? ''
  },

  async anthropic(a) {
    const client = new Anthropic({ apiKey: a.apiKey, fetch: outboundFetch })
    const r = await client.messages.create({
      model: a.model,
      max_tokens: 16000,
      system: a.system,
      messages: [{ role: 'user', content: a.user }],
    })
    if (r.stop_reason === 'refusal') throw new ApiError(502, 'llm_refused', 'The AI provider declined to answer this request.')
    return r.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  },

  async openai(a) {
    return chatCompletionsFetch(OPENAI_URL, a, a.json ? { response_format: { type: 'json_object' } } : {})
  },

  async gemini(a) {
    return chatCompletionsFetch(GEMINI_URL, a, a.temperature === undefined ? {} : { temperature: a.temperature })
  },
}

/** Parse a JSON reply, tolerating a ```json … ``` fence around it. */
export function parseJsonReply(raw: string): unknown {
  const trimmed = raw.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return JSON.parse(fenced ? fenced[1] : trimmed)
}

function providerMessage(err: unknown): string {
  // The SDK's message is "<status> <raw JSON>"; the nested error.message reads better.
  const sdkMessage = (e: InstanceType<typeof Anthropic.APIError>) =>
    (e.error as { error?: { message?: string } } | undefined)?.error?.message ?? e.message
  if (err instanceof Anthropic.AuthenticationError) return `invalid API key (${sdkMessage(err)})`
  if (err instanceof Anthropic.APIError) return sdkMessage(err)
  if (err instanceof Error) return err.message
  return 'unknown error'
}

async function callProvider(provider: AiProvider, a: CallArgs): Promise<string> {
  const system = a.json ? `${a.system}\n\n${JSON_INSTRUCTION}` : a.system
  return adapters[provider]({ ...a, system })
}

/** Completion against the firm's active provider. JSON mode returns the parsed body — caller validates shape. */
export async function complete<T = unknown>(args: {
  organisationId: string
  system: string
  user: string
  temperature?: number
  json?: boolean
}): Promise<{ content: T; model: string; provider: AiProvider }> {
  await assertAiAllowed(args.organisationId)
  const cfg = await resolveLlmConfig(args.organisationId)
  let raw: string
  try {
    raw = await callProvider(cfg.provider, {
      apiKey: cfg.apiKey,
      model: cfg.model,
      system: args.system,
      // PAN, GSTIN, Aadhaar, phone and email never leave the server.
      user: maskPersonalData(args.user),
      temperature: args.temperature,
      json: args.json,
    })
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError(502, 'llm_failed', `The AI provider returned an error: ${providerMessage(err)}`)
  }
  if (!raw.trim()) throw new ApiError(502, 'llm_empty', 'The LLM returned an empty response.')
  if (args.json) {
    try {
      return { content: parseJsonReply(raw) as T, model: cfg.model, provider: cfg.provider }
    } catch {
      throw new ApiError(502, 'llm_bad_json', 'The LLM response was not valid JSON.')
    }
  }
  return { content: raw as unknown as T, model: cfg.model, provider: cfg.provider }
}

/**
 * Ping-test — one tiny "reply with OK" completion to confirm a key works.
 * No token cap: reasoning models can spend a small budget before answering.
 * Throws an Error whose message is the provider's own explanation.
 */
export async function testProviderKey(provider: AiProvider, apiKey: string, model: string | null): Promise<{ ok: true; model: string }> {
  const m = model?.trim() || PROVIDER_INFO[provider].defaultModel
  let content: string
  try {
    content = await callProvider(provider, { apiKey, model: m, system: 'You are a connectivity check.', user: 'Reply with OK.', temperature: 0 })
  } catch (err) {
    throw new Error(providerMessage(err))
  }
  if (!content.trim()) throw new Error('the provider returned an empty response')
  return { ok: true, model: m }
}
