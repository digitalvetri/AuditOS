import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, login, org, prisma, startServer, stopServer, uid } from '../../compliance/__tests__/fixtures.js'

beforeAll(startServer)
afterAll(stopServer)

type Item = Record<string, unknown>

describe('doc-templates read API', () => {
  it('lists the latest active version per code; detail returns clauses + variants', async () => {
    const o = await org()
    const md = await login(o, 'md')
    // Two versions of the same code — the list should return the newer one only.
    const nameV1 = uid('tpl')
    const code = `pship-${uid('c')}`
    const tplV1 = await prisma.docTemplate.create({
      data: {
        organisationId: o.id, code, version: 1, name: `${nameV1} v1`,
        outputFormats: 'pdf,docx', effectiveFrom: '2026-01-01', body: 'BODY_V1',
      },
    })
    await prisma.docTemplate.create({
      data: {
        organisationId: o.id, code, version: 2, name: `${nameV1} v2`,
        outputFormats: 'pdf,docx', effectiveFrom: '2026-06-01', body: 'BODY_V2',
      },
    })
    // Deactivated version shouldn't appear in the list — a dormant code is not draftable.
    const dormantCode = `dormant-${uid('c')}`
    await prisma.docTemplate.create({
      data: {
        organisationId: o.id, code: dormantCode, version: 1, name: 'Dormant',
        outputFormats: 'pdf', effectiveFrom: '2025-01-01', body: '', isActive: false,
      },
    })

    // ── LIST ──
    const list = await api('/api/doc-templates', { cookie: md.cookie })
    expect(list.status).toBe(200)
    const items = list.body.data as Item[]
    const picked = items.filter((i) => i.code === code)
    expect(picked.length).toBe(1)
    expect(picked[0]).toMatchObject({ code, version: 2, name: `${nameV1} v2`, output_formats: ['pdf', 'docx'] })
    expect(items.some((i) => i.code === dormantCode)).toBe(false)

    // ── DETAIL (latest) ──
    // Attach a clause with two variants to v2 so the detail payload is exercised.
    const clause = await prisma.docTemplateClause.create({
      data: { templateId: (await prisma.docTemplate.findFirst({ where: { code, version: 2 } }))!.id,
        clauseCode: 'profit-sharing', clauseTitle: 'Profit sharing', sortOrder: 1, required: true },
    })
    await prisma.docTemplateClauseVariant.create({
      data: { clauseId: clause.id, label: 'Equal shares', body: 'Profits shared equally.', isDefault: true },
    })
    await prisma.docTemplateClauseVariant.create({
      data: { clauseId: clause.id, label: 'In agreed ratio', body: 'Profits shared in agreed ratio.', isDefault: false },
    })

    const detail = await api(`/api/doc-templates/${code}`, { cookie: md.cookie })
    expect(detail.status).toBe(200)
    const d = detail.body.data as Item
    expect(d).toMatchObject({ code, version: 2, name: `${nameV1} v2`, is_active: true, body: 'BODY_V2' })
    const clauses = d.clauses as Item[]
    expect(clauses).toHaveLength(1)
    expect(clauses[0]).toMatchObject({ clause_code: 'profit-sharing', required: true, sort_order: 1 })
    const variants = (clauses[0] as { variants: Item[] }).variants
    expect(variants).toHaveLength(2)
    expect(variants.some((v) => v.label === 'Equal shares' && v.is_default === true)).toBe(true)

    // ── DETAIL (pinned-version) returns the OLD version even after activation moved on ──
    // Deactivate v2 to prove /:code/:version doesn't care about isActive.
    await prisma.docTemplate.update({ where: { id: tplV1.id }, data: { isActive: false } })
    const pinned = await api(`/api/doc-templates/${code}/1`, { cookie: md.cookie })
    expect(pinned.status).toBe(200)
    expect((pinned.body.data as Item).version).toBe(1)

    // ── 404s ──
    const missing = await api('/api/doc-templates/nope-code', { cookie: md.cookie })
    expect(missing.status).toBe(404)
    const missingPinned = await api(`/api/doc-templates/${code}/99`, { cookie: md.cookie })
    expect(missingPinned.status).toBe(404)
    const badVersion = await api(`/api/doc-templates/${code}/zero`, { cookie: md.cookie })
    expect(badVersion.status).toBe(400)
  })
})
