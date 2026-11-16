import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readdirSync } from 'node:fs'
import path from 'node:path'

const env = vi.hoisted(() => {
  const root = `${process.env.TMPDIR ?? '/tmp'}/auditos-test-gst-notices-${process.pid}-${Date.now()}`
  process.env.GST_NOTICE_STORAGE_ROOT = root
  return { root }
})
const llm = vi.hoisted(() => ({ fail: null as Error | null }))
vi.mock('../extract.js', () => ({
  isSupportedNoticeMime: () => true,
  extractNoticeText: async () => ({ text: 'SHOW CAUSE NOTICE u/s 73 for FY 2023-24', source: 'pdf-parse' }),
}))
vi.mock('../groq.js', () => ({
  complete: async ({ json }: { json: boolean }) => {
    if (llm.fail) throw llm.fail
    return { content: json ? { reference_no: 'ZD330926000001', notice_date: '2026-09-20' } : 'Draft text', model: 'test', provider: 'test' }
  },
}))

import { api, client, login, org, prisma, startServer, stopServer } from '../../compliance/__tests__/fixtures.js'

beforeAll(startServer)
afterAll(stopServer)

const upload = (clientId: string) => {
  const form = new FormData()
  form.set('clientId', clientId)
  form.set('kind', 'DRC01')
  form.set('file', new Blob([Buffer.from('%PDF-1.4\n%fake notice\n')], { type: 'application/pdf' }), 'scn.pdf')
  return form
}

describe('GST notice upload', () => {
  it('the original notice file can be downloaded again', async () => {
    llm.fail = null
    const o = await org()
    const md = await login(o, 'md')
    const c = await client(o, 'Oscar Traders')
    const r = await api('/api/notices', { method: 'POST', cookie: md.cookie, form: upload(c.id) })
    expect(r.status).toBe(201)
    const file = await api(`/api/notices/${r.body.data.id}/file`, { cookie: md.cookie })
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe('application/pdf')
    expect(file.raw.subarray(0, 4).toString()).toBe('%PDF')
  })

  it('an AI failure (timeout, 429, 5xx) still saves the notice with its file — no 500, nothing orphaned', async () => {
    llm.fail = new Error('upstream timeout')
    try {
      const o = await org()
      const md = await login(o, 'md')
      const c = await client(o, 'Papa Traders')
      const r = await api('/api/notices', { method: 'POST', cookie: md.cookie, form: upload(c.id) })
      expect(r.status).toBe(201)
      expect(r.body.data).toMatchObject({ status: 'draft', draft_content: null, ai_error: expect.any(String) })
      const row = await prisma.gstNotice.findUniqueOrThrow({ where: { id: r.body.data.id } })
      expect(row.uploadedFileKey).toBeTruthy()
      expect(row.extractedText).toMatch(/SHOW CAUSE/)
      expect(readdirSync(path.join(env.root, c.id))).toHaveLength(1)
      expect((await api(`/api/notices/${row.id}/file`, { cookie: md.cookie })).status).toBe(200)
    } finally {
      llm.fail = null
    }
  })
})

describe('closing a GST notice', () => {
  it('needs the reply to have been sent, or a reason for closing without one', async () => {
    const o = await org()
    const md = await login(o, 'md')
    const c = await client(o, 'Quebec Traders')
    const n = await prisma.gstNotice.create({ data: { organisationId: o.id, clientId: c.id, kind: 'ASMT10', status: 'review' } })
    const refused = await api(`/api/notices/${n.id}`, { method: 'PATCH', cookie: md.cookie, body: { status: 'closed' } })
    expect(refused.status).toBe(400)
    expect((await prisma.gstNotice.findUniqueOrThrow({ where: { id: n.id } })).status).toBe('review')
    const closed = await api(`/api/notices/${n.id}`, { method: 'PATCH', cookie: md.cookie, body: { status: 'closed', closed_without_reply_reason: 'Proceedings dropped' } })
    expect(closed.status).toBe(200)
    expect(closed.body.data).toMatchObject({ status: 'closed', closed_without_reply_reason: 'Proceedings dropped' })
    const sent = await prisma.gstNotice.create({ data: { organisationId: o.id, clientId: c.id, kind: 'ASMT10', status: 'sent' } })
    expect((await api(`/api/notices/${sent.id}`, { method: 'PATCH', cookie: md.cookie, body: { status: 'closed' } })).status).toBe(200)
  })
})
