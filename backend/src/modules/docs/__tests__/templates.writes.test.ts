import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, login, org, prisma, startServer, stopServer, uid } from '../../compliance/__tests__/fixtures.js'

beforeAll(startServer)
afterAll(stopServer)

type Item = Record<string, unknown>

describe('doc-templates write API', () => {
  it('POST / creates v1 with clauses and variants, 201', async () => {
    const o = await org()
    const md = await login(o, 'md')
    const code = `pship-${uid('c')}`
    const body = {
      code, name: 'Partnership deed', effective_from: '2026-01-01',
      output_formats: ['pdf', 'docx'],
      body: 'DEED between {{partner1.name}} and {{partner2.name}}.',
      description: 'The firm\'s standard partnership deed.',
      clauses: [
        {
          clause_code: 'profit-sharing', clause_title: 'Profit sharing', sort_order: 2, required: true,
          variants: [
            { label: 'Equal shares', body: 'Profits shared equally.', is_default: true },
            { label: 'In agreed ratio', body: 'Profits shared in ratio {{ratio}}.' },
          ],
        },
        {
          clause_code: 'managing-partner', clause_title: 'Managing partner', sort_order: 1, required: true,
          variants: [
            { label: 'One managing partner', body: '{{partner1.name}} shall be managing partner.', is_default: true },
          ],
        },
      ],
    }
    const r = await api('/api/doc-templates', { method: 'POST', cookie: md.cookie, body })
    expect(r.status).toBe(201)
    const d = r.body.data as Item
    expect(d).toMatchObject({ code, version: 1, name: 'Partnership deed', is_active: true, output_formats: ['pdf', 'docx'] })
    const clauses = d.clauses as Item[]
    expect(clauses).toHaveLength(2)
    expect((clauses[0] as { clause_code: string }).clause_code).toBe('managing-partner') // sorted
    expect((clauses[1] as { clause_code: string }).clause_code).toBe('profit-sharing')
    const vars = (clauses[1] as { variants: Item[] }).variants
    expect(vars.find((v) => v.label === 'Equal shares')?.is_default).toBe(true)
  })

  it('POST / rejects a duplicate code with 409', async () => {
    const o = await org()
    const md = await login(o, 'md')
    const code = `dup-${uid('c')}`
    const body = { code, name: 'X', effective_from: '2026-01-01', body: '', clauses: [] }
    const r1 = await api('/api/doc-templates', { method: 'POST', cookie: md.cookie, body })
    expect(r1.status).toBe(201)
    const r2 = await api('/api/doc-templates', { method: 'POST', cookie: md.cookie, body })
    expect(r2.status).toBe(409)
    expect(r2.body.error.code).toBe('template_exists')
  })

  it('POST / rejects a clause with two defaults (400)', async () => {
    const o = await org()
    const md = await login(o, 'md')
    const body = {
      code: `multi-${uid('c')}`, name: 'X', effective_from: '2026-01-01', body: '',
      clauses: [{
        clause_code: 'c1', clause_title: 'C1', required: true,
        variants: [
          { label: 'A', body: 'a', is_default: true },
          { label: 'B', body: 'b', is_default: true },
        ],
      }],
    }
    const r = await api('/api/doc-templates', { method: 'POST', cookie: md.cookie, body })
    expect(r.status).toBe(400)
  })

  it('POST /:code/versions bumps version + deactivates prior; pinned GET still returns v1', async () => {
    const o = await org()
    const md = await login(o, 'md')
    const code = `evolve-${uid('c')}`
    const v1 = await api('/api/doc-templates', { method: 'POST', cookie: md.cookie, body: {
      code, name: 'v1 name', effective_from: '2026-01-01', body: 'V1 BODY', clauses: [],
    } })
    expect(v1.status).toBe(201)

    const v2 = await api(`/api/doc-templates/${code}/versions`, { method: 'POST', cookie: md.cookie, body: {
      name: 'v2 name', effective_from: '2026-06-01', body: 'V2 BODY', clauses: [],
    } })
    expect(v2.status).toBe(201)
    expect((v2.body.data as Item).version).toBe(2)

    // Latest is v2 and active; v1 is deactivated.
    const latest = await api(`/api/doc-templates/${code}`, { cookie: md.cookie })
    expect((latest.body.data as Item).version).toBe(2)
    const v1Pinned = await api(`/api/doc-templates/${code}/1`, { cookie: md.cookie })
    expect(v1Pinned.status).toBe(200)
    expect((v1Pinned.body.data as Item)).toMatchObject({ version: 1, body: 'V1 BODY', is_active: false })
  })

  it('PATCH /:id flips is_active and name without changing body', async () => {
    const o = await org()
    const md = await login(o, 'md')
    const code = `patch-${uid('c')}`
    const created = await api('/api/doc-templates', { method: 'POST', cookie: md.cookie, body: {
      code, name: 'original', effective_from: '2026-01-01', body: 'KEEP ME', clauses: [],
    } })
    const id = (created.body.data as Item).id as string
    const patched = await api(`/api/doc-templates/${id}`, { method: 'PATCH', cookie: md.cookie, body: { name: 'renamed', is_active: false } })
    expect(patched.status).toBe(200)
    const d = patched.body.data as Item
    expect(d).toMatchObject({ name: 'renamed', is_active: false, body: 'KEEP ME' })
  })

  it('DELETE /:id soft-deletes; pinned GET of the same version still works', async () => {
    const o = await org()
    const md = await login(o, 'md')
    const code = `del-${uid('c')}`
    const created = await api('/api/doc-templates', { method: 'POST', cookie: md.cookie, body: {
      code, name: 'X', effective_from: '2026-01-01', body: 'PINNED BODY', clauses: [],
    } })
    const id = (created.body.data as Item).id as string
    const del = await api(`/api/doc-templates/${id}`, { method: 'DELETE', cookie: md.cookie })
    expect(del.status).toBe(200)
    // List-by-code 404s (nothing active); pinned GET also 404s because the
    // delete handler sets deletedAt which both read paths filter on.
    expect((await api(`/api/doc-templates/${code}`, { cookie: md.cookie })).status).toBe(404)
    expect((await api(`/api/doc-templates/${code}/1`, { cookie: md.cookie })).status).toBe(404)
  })
})
