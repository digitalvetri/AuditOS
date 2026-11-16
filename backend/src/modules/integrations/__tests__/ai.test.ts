import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { encryptPortalSecret } from '../../../platform/portalCrypto.js'
import { __setLlmFetchForTests, complete, resolveLlmConfig, testProviderKey } from '../llm.js'
import { complete as completeViaNotices } from '../../notices/groq.js'

/**
 * Integrations → AI provider: Groq, Claude (Anthropic), OpenAI and Gemini.
 * One active provider per firm; provider calls go through an injectable
 * fetch so no test touches the network.
 */

let server: Server
let base = ''
let orgId = ''
let adminCookie = ''
let staffCookie = ''

type Call = { url: string; headers: Headers; body: any }
let calls: Call[] = []
let reply: (url: string) => Response = () => new Response('{}', { status: 500 })

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function chat(content: string) {
  return json(200, { id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] })
}
function claude(text: string, stop_reason = 'end_turn') {
  return json(200, {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason, stop_sequence: null,
    content: text ? [{ type: 'text', text }] : [], usage: { input_tokens: 1, output_tokens: 1 },
  })
}

/** The SDK sends the key as x-api-key or as a Bearer token depending on version. */
function claudeKey(c: Call) {
  return c.headers.get('x-api-key') ?? c.headers.get('authorization')?.replace(/^Bearer /, '') ?? null
}

const mockFetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const body = init?.body ? JSON.parse(String(init.body)) : null
  calls.push({ url, headers: new Headers(init?.headers), body })
  return reply(url)
}) as typeof fetch

async function api(p: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${p}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: opts.cookie ?? adminCookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function user(code: string) {
  const role = await prisma.role.findUniqueOrThrow({ where: { code } })
  const ws = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('AI'), firstName: 'A', lastName: code, fullName: `A ${code} ${uid('n')}`, email: `${uid('ai')}@x.local`, joiningDate: '2020-01-01', workScheduleId: ws } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  return `ao_access=${signToken(u.id)}`
}

async function newOrg() {
  return (await prisma.organisation.create({ data: { id: uid('org'), name: 'AI Firm' } })).id
}
async function addKey(org: string, provider: string, key: string, model: string | null = null, createdAt?: Date) {
  return prisma.aiProviderConfig.create({
    data: { organisationId: org, provider, apiKeyCiphertext: encryptPortalSecret(key, `ai_provider.${provider}.apiKey`)!, model, ...(createdAt ? { createdAt } : {}) },
  })
}

const savedGroqEnv = process.env.GROQ_API_KEY

beforeAll(async () => {
  process.env.PORTAL_ACCESS_ENC_KEY ??= randomBytes(32).toString('base64')
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const a = server.address()
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
  orgId = await newOrg()
  await setupRoles(prisma, { force: true })
  adminCookie = await user('md')
  staffCookie = await user('employee')
})
beforeEach(() => {
  calls = []
  delete process.env.GROQ_API_KEY
  __setLlmFetchForTests(mockFetch)
})
afterEach(() => {
  __setLlmFetchForTests(null)
  if (savedGroqEnv === undefined) delete process.env.GROQ_API_KEY
  else process.env.GROQ_API_KEY = savedGroqEnv
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('provider selection', () => {
  it('nothing configured and no env key → 503 llm_unconfigured', async () => {
    const org = await newOrg()
    await expect(resolveLlmConfig(org)).rejects.toMatchObject({ status: 503, code: 'llm_unconfigured' })
  })

  it('falls back to the GROQ_API_KEY env var', async () => {
    const org = await newOrg()
    process.env.GROQ_API_KEY = 'gsk_env_key_for_tests_000000'
    expect(await resolveLlmConfig(org)).toMatchObject({ provider: 'groq', apiKey: 'gsk_env_key_for_tests_000000', source: 'env' })
  })

  it('with no explicit choice, uses the first configured provider', async () => {
    const org = await newOrg()
    process.env.GROQ_API_KEY = 'gsk_env_key_for_tests_000000'
    await addKey(org, 'openai', 'sk-openai-0000000000000000000', null, new Date('2026-01-01'))
    await addKey(org, 'anthropic', 'sk-ant-00000000000000000000000', null, new Date('2026-02-01'))
    expect(await resolveLlmConfig(org)).toMatchObject({ provider: 'openai', apiKey: 'sk-openai-0000000000000000000', model: 'gpt-5', source: 'firm' })
  })

  it('uses the firm\'s chosen provider and its model override', async () => {
    const org = await newOrg()
    await addKey(org, 'openai', 'sk-openai-0000000000000000000', null, new Date('2026-01-01'))
    await addKey(org, 'gemini', 'AIza-gemini-000000000000000000', 'gemini-2.5-pro')
    await prisma.organisation.update({ where: { id: org }, data: { aiProvider: 'gemini' } })
    expect(await resolveLlmConfig(org)).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-pro' })
  })

  it('a chosen provider whose key was removed falls back to what is left', async () => {
    const org = await newOrg()
    await addKey(org, 'groq', 'gsk_firm_key_000000000000000000')
    await prisma.organisation.update({ where: { id: org }, data: { aiProvider: 'anthropic' } })
    expect(await resolveLlmConfig(org)).toMatchObject({ provider: 'groq', model: expect.any(String) })
  })
})

describe('provider adapters', () => {
  async function orgWith(provider: string, key: string) {
    const org = await newOrg()
    await addKey(org, provider, key)
    return org
  }

  it('Claude: SDK call with max_tokens, system prompt, no sampling params; JSON fence stripped; PAN masked', async () => {
    const org = await orgWith('anthropic', 'sk-ant-test-key-000000000000')
    reply = () => claude('```json\n{"a": 1}\n```')
    const r = await complete<{ a: number }>({ organisationId: org, system: 'Extract.', user: 'PAN ABCDE1234F', temperature: 0.1, json: true })
    expect(r).toEqual({ content: { a: 1 }, model: 'claude-opus-5-5', provider: 'anthropic' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages')
    expect(claudeKey(calls[0])).toBe('sk-ant-test-key-000000000000')
    const b = calls[0].body
    expect(b).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16000 })
    expect(b.system).toContain('Extract.')
    expect(b.system).toContain('Reply with a single JSON object only')
    expect(b.messages).toEqual([{ role: 'user', content: expect.not.stringContaining('ABCDE1234F') }])
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking']) expect(b).not.toHaveProperty(k)
  })

  it('Claude: text blocks are joined; plain text mode returns the text', async () => {
    const org = await orgWith('anthropic', 'sk-ant-test-key-000000000000')
    reply = () => json(200, {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: 'Dear ' }, { type: 'text', text: 'Sir' }], usage: { input_tokens: 1, output_tokens: 1 },
    })
    const r = await complete<string>({ organisationId: org, system: 's', user: 'u' })
    expect(r.content).toBe('Dear Sir')
    expect(calls[0].body.system).toBe('s')
  })

  it('Claude: a refusal is a 502 llm_refused', async () => {
    const org = await orgWith('anthropic', 'sk-ant-test-key-000000000000')
    reply = () => claude('', 'refusal')
    await expect(complete({ organisationId: org, system: 's', user: 'u' })).rejects.toMatchObject({ status: 502, code: 'llm_refused' })
  })

  it('OpenAI: chat completions with json_object, Bearer key, no temperature', async () => {
    const org = await orgWith('openai', 'sk-openai-test-key-0000000000')
    reply = () => chat('{"ok": true}')
    const r = await complete({ organisationId: org, system: 'Extract.', user: 'hello', temperature: 0.1, json: true })
    expect(r).toEqual({ content: { ok: true }, model: 'gpt-5', provider: 'openai' })
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions')
    expect(calls[0].headers.get('authorization')).toBe('Bearer sk-openai-test-key-0000000000')
    expect(calls[0].body).toMatchObject({ model: 'gpt-5', response_format: { type: 'json_object' } })
    expect(calls[0].body).not.toHaveProperty('temperature')
    expect(calls[0].body.messages[0]).toMatchObject({ role: 'system' })
    expect(calls[0].body.messages[0].content).toContain('JSON')
  })

  it('Gemini: OpenAI-compatible endpoint with a Bearer key', async () => {
    const org = await orgWith('gemini', 'AIza-gemini-test-key-00000000')
    reply = () => chat('Drafted reply')
    const r = await complete<string>({ organisationId: org, system: 's', user: 'u', temperature: 0.3 })
    expect(r).toEqual({ content: 'Drafted reply', model: 'gemini-2.5-flash', provider: 'gemini' })
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
    expect(calls[0].headers.get('authorization')).toBe('Bearer AIza-gemini-test-key-00000000')
    expect(calls[0].body).toMatchObject({ model: 'gemini-2.5-flash', temperature: 0.3 })
  })

  it('Groq: still works through the notices re-export, with the env fallback', async () => {
    const org = await newOrg()
    process.env.GROQ_API_KEY = 'gsk_env_key_for_tests_000000'
    reply = () => chat('{"x": 2}')
    const r = await completeViaNotices({ organisationId: org, system: 'Return json.', user: 'u', temperature: 0.1, json: true })
    expect(r).toMatchObject({ content: { x: 2 }, provider: 'groq' })
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(calls[0].headers.get('authorization')).toBe('Bearer gsk_env_key_for_tests_000000')
    expect(calls[0].body).toMatchObject({ temperature: 0.1, response_format: { type: 'json_object' } })
  })

  it('empty → llm_empty, unparseable JSON → llm_bad_json, provider error → 502', async () => {
    const org = await orgWith('openai', 'sk-openai-test-key-0000000000')
    reply = () => chat('')
    await expect(complete({ organisationId: org, system: 's', user: 'u' })).rejects.toMatchObject({ status: 502, code: 'llm_empty' })
    reply = () => chat('not json')
    await expect(complete({ organisationId: org, system: 's', user: 'u', json: true })).rejects.toMatchObject({ status: 502, code: 'llm_bad_json' })
    reply = () => json(429, { error: { message: 'Rate limit reached' } })
    await expect(complete({ organisationId: org, system: 's', user: 'u' })).rejects.toMatchObject({ status: 502, code: 'llm_failed' })
  })

  it('the AI switch still blocks every provider before any call', async () => {
    const org = await orgWith('anthropic', 'sk-ant-test-key-000000000000')
    await prisma.organisation.update({ where: { id: org }, data: { aiExternalProcessing: false } })
    await expect(complete({ organisationId: org, system: 's', user: 'u' })).rejects.toMatchObject({ status: 409, code: 'ai_disabled' })
    expect(calls).toHaveLength(0)
  })

  it('testProviderKey: a bad Claude key surfaces the provider message', async () => {
    reply = () => json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
    await expect(testProviderKey('anthropic', 'sk-ant-bad-000000000000000', null)).rejects.toThrow(/invalid x-api-key/)
  })
})

describe('routes', () => {
  it('unknown provider and short key are 400; staff without the permission get 403', async () => {
    expect((await api('/api/integrations/ai', { method: 'PUT', body: { provider: 'mistral', api_key: 'x'.repeat(30) } })).status).toBe(400)
    expect((await api('/api/integrations/ai', { method: 'PUT', body: { provider: 'anthropic', api_key: 'short' } })).status).toBe(400)
    expect((await api('/api/integrations/ai/mistral/activate', { method: 'POST' })).status).toBe(400)
    expect((await api('/api/integrations/ai', { cookie: staffCookie })).status).toBe(403)
  })

  it('first saved key becomes current; "use this provider" switches; removing the current one falls back', async () => {
    let g = await api('/api/integrations/ai')
    expect(g.status).toBe(200)
    expect(g.body.data.current_provider).toBeNull()
    expect(g.body.data.providers.map((p: any) => p.provider)).toEqual(['anthropic', 'openai', 'gemini', 'groq'])
    expect(g.body.data.providers.find((p: any) => p.provider === 'anthropic')).toMatchObject({ configured: false, is_current: false, default_model: 'claude-opus-5-5' })

    const put = await api('/api/integrations/ai', { method: 'PUT', body: { provider: 'anthropic', api_key: 'sk-ant-real-looking-key-0000000' } })
    expect(put.status).toBe(200)
    expect(JSON.stringify(put.body)).not.toContain('sk-ant-real-looking-key')
    expect((await prisma.organisation.findUniqueOrThrow({ where: { id: orgId } })).aiProvider).toBe('anthropic')

    await api('/api/integrations/ai', { method: 'PUT', body: { provider: 'openai', api_key: 'sk-openai-real-looking-key-000', model: 'gpt-5-mini' } })
    g = await api('/api/integrations/ai')
    expect(JSON.stringify(g.body)).not.toContain('real-looking-key')
    expect(g.body.data.current_provider).toBe('anthropic')
    expect(g.body.data.providers.find((p: any) => p.provider === 'openai')).toMatchObject({ configured: true, is_current: false, model: 'gpt-5-mini' })

    expect((await api('/api/integrations/ai/gemini/activate', { method: 'POST' })).status).toBe(400)
    const act = await api('/api/integrations/ai/openai/activate', { method: 'POST' })
    expect(act.status).toBe(200)
    expect(act.body.data.current_provider).toBe('openai')
    expect((await resolveLlmConfig(orgId)).provider).toBe('openai')

    expect((await api('/api/integrations/ai/openai', { method: 'DELETE' })).status).toBe(204)
    g = await api('/api/integrations/ai')
    expect(g.body.data.current_provider).toBe('anthropic')
    expect((await resolveLlmConfig(orgId)).provider).toBe('anthropic')
  })

  it('test endpoint: typed key for any provider; stored key when none typed; rejection message', async () => {
    reply = () => chat('OK')
    const t = await api('/api/integrations/ai/test', { method: 'POST', body: { provider: 'gemini', api_key: 'AIza-typed-key-0000000000000' } })
    expect(t.status).toBe(200)
    expect(t.body.data).toEqual({ ok: true, provider: 'gemini', model: 'gemini-2.5-flash' })

    reply = () => claude('OK')
    const stored = await api('/api/integrations/ai/test', { method: 'POST', body: { provider: 'anthropic' } })
    expect(stored.status).toBe(200)
    expect(claudeKey(calls.at(-1)!)).toBe('sk-ant-real-looking-key-0000000')

    expect((await api('/api/integrations/ai/test', { method: 'POST', body: { provider: 'groq' } })).status).toBe(400)

    reply = () => json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
    const bad = await api('/api/integrations/ai/test', { method: 'POST', body: { provider: 'anthropic', api_key: 'sk-ant-bad-key-000000000000' } })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('provider_rejected')
    expect(bad.body.error.message).toMatch(/^The provider rejected the key: .*invalid x-api-key/)
  })
})
