import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.CLIENT_DOC_STORAGE_ROOT = `${process.env.TMPDIR ?? '/tmp'}/auditos-test-version-sniff-${process.pid}`
})

import { prisma, uid } from '../../../__tests__/helpers.js'
import { startHarness, type Harness, type Staff } from './ws-harness.js'

/** A new document version is held to the same content check as the folder and portal uploads. */
let h: Harness
let md: Staff
let docId = ''

beforeAll(async () => {
  h = await startHarness()
  md = await h.staff('md')
  const c = await h.client(md.emp.id)
  const cat = await prisma.documentCategory.create({ data: { organisationId: h.orgId, code: uid('cat'), name: 'Bank' } })
  docId = (await prisma.clientDocument.create({ data: { clientId: c.id, categoryId: cat.id, name: 'Statement', status: 'requested' } })).id
})
afterAll(() => h?.close())

describe('POST /api/client-documents/:id/versions', () => {
  it('refuses an executable or HTML page named .pdf, and stores nothing', async () => {
    const exe = await h.upload(`/api/client-documents/${docId}/versions`, md.cookie, Buffer.from('MZ\x90\x00\x03\x00\x00\x00 this is a program'), 'statement.pdf')
    expect(exe.status).toBe(422)
    expect(exe.body?.error?.code ?? exe.body?.code).toBe('file_content')
    const html = await h.upload(`/api/client-documents/${docId}/versions`, md.cookie, Buffer.from('<html><script>alert(1)</script></html>'), 'x.pdf')
    expect(html.status).toBe(422)
    expect(await prisma.clientDocumentVersion.count({ where: { documentId: docId } })).toBe(0)
  })

  it('accepts a real PDF', async () => {
    const r = await h.upload(`/api/client-documents/${docId}/versions`, md.cookie, Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n'), 'statement.pdf')
    expect(r.status).toBe(201)
  })
})
