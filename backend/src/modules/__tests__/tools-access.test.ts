import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { signToken } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { setupRoles, TOOLS_LOCKDOWN_ACTION } from '../../../prisma/setup-roles.js'

/**
 * Tools access as a deployed firm has it (roles from setupRoles):
 *  - Associate and Intern see, download and delete only their own tool
 *    documents and jobs; Admin, Super Admin and Senior Associate see all.
 *  - Associate and Intern may view Books (their assigned clients) but hold
 *    no Books edit code.
 *  - A database set up before this (Books inside Tools, documents at
 *    organisation scope) is corrected by the next seed run.
 */

type Code = 'md' | 'hr_admin' | 'dept_manager' | 'employee' | 'intern'
let server: Server
let base = ''
let orgId = ''

async function api(path: string, cookie: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  const j = text ? JSON.parse(text) : null
  return { status: res.status, body: j && typeof j === 'object' && 'data' in j ? j.data : j }
}

async function user(code: Code) {
  const role = await prisma.role.findUniqueOrThrow({ where: { code } })
  const u = await prisma.user.create({ data: { id: uid('u'), organisationId: orgId, email: `${uid(code)}@x.local`, passwordHash: 'x', roleId: role.id } })
  return { id: u.id, cookie: `ao_access=${signToken(u.id)}` }
}

const TOOL_ID = 'test-tools-access'
async function ensureTool() {
  await prisma.toolCategory.upsert({ where: { id: TOOL_ID }, update: {}, create: { id: TOOL_ID, key: TOOL_ID, label: 'T', order: 99 } })
  await prisma.toolGroup.upsert({ where: { id: TOOL_ID }, update: {}, create: { id: TOOL_ID, key: TOOL_ID, label: 'T', categoryId: TOOL_ID, order: 99 } })
  await prisma.tool.upsert({ where: { id: TOOL_ID }, update: {}, create: { id: TOOL_ID, key: TOOL_ID, name: 'T', description: 'T', groupId: TOOL_ID, outputType: 'xlsx', permissionKey: 'tools.pdf_to_excel' } })
}

async function doc(userId: string) {
  const d = await prisma.toolDocument.create({
    data: {
      id: uid('doc'), organisationId: orgId, userId, kind: 'output', originalFilename: 'statement.xlsx', storedFilename: 'x.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileSize: 10, storagePath: `test/${uid('p')}`, sourceTool: 'pdf_to_excel',
    },
  })
  const job = await prisma.toolJob.create({ data: { id: uid('job'), toolId: TOOL_ID, userId, organisationId: orgId, outputDocumentId: d.id, status: 'completed' } })
  return { doc: d, job }
}

async function grantsOf(code: Code) {
  const rows = await prisma.rolePermission.findMany({ where: { role: { code } }, include: { permission: true } })
  return new Map(rows.map((rp) => [rp.permission.code, rp.scope]))
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  await setupRoles(prisma, { force: true })
  await ensureTool()
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('Role defaults', () => {
  it('Associate and Intern: Books view only, own tool documents only; the rest: full Books, all documents', async () => {
    for (const code of ['employee', 'intern'] as const) {
      const g = await grantsOf(code)
      expect([...g.keys()].filter((c) => c.startsWith('books.')).sort(), code).toEqual(['books.access', 'books.reports'])
      expect(g.get('tools.access'), code).toBe('organisation')
      expect(g.get('tools.documents.read'), code).toBe('self')
      expect(g.get('tools.documents.manage'), code).toBe('self')
    }
    for (const code of ['md', 'hr_admin', 'dept_manager'] as const) {
      const g = await grantsOf(code)
      for (const c of ['books.access', 'books.manage', 'books.accountant', 'books.settings', 'books.reports']) expect(g.get(c), `${code} ${c}`).toBe('organisation')
      expect(g.get('tools.documents.read'), code).toBe('organisation')
      expect(g.get('tools.documents.manage'), code).toBe('organisation')
    }
  })
})

describe('Tool documents — own only for Associate and Intern', () => {
  for (const code of ['employee', 'intern'] as const) {
    it(`${code} cannot see, download or delete another user's document or job`, async () => {
      const md = await user('md')
      const me = await user(code)
      const theirs = await doc(md.id)
      const mine = await doc(me.id)

      expect((await api(`/api/tool-documents/${theirs.doc.id}`, me.cookie)).status).toBe(404)
      expect((await api(`/api/tool-documents/${theirs.doc.id}/link`, me.cookie)).status).toBe(404)
      expect((await api(`/api/tool-documents/${theirs.doc.id}/preview`, me.cookie)).status).toBe(404)
      expect((await api(`/api/tool-documents/${theirs.doc.id}`, me.cookie, { method: 'DELETE' })).status).toBe(404)
      expect((await api(`/api/tool-jobs/${theirs.job.id}`, me.cookie)).status).toBe(404)
      expect(await prisma.toolDocument.count({ where: { id: theirs.doc.id, deletedAt: null } })).toBe(1)

      const list = await api('/api/tool-documents?kind=all', me.cookie)
      expect(list.status).toBe(200)
      expect(list.body.scope).toBe('self')
      const ids = list.body.items.map((d: { id: string }) => d.id)
      expect(ids).toContain(mine.doc.id)
      expect(ids).not.toContain(theirs.doc.id)

      // The "Created by" filter cannot widen the scope.
      const filtered = await api(`/api/tool-documents?kind=all&user_id=${md.id}`, me.cookie)
      expect(filtered.status).toBe(200)
      expect(filtered.body.items.map((d: { id: string }) => d.id)).not.toContain(theirs.doc.id)

      // Their own document stays fully theirs.
      expect((await api(`/api/tool-documents/${mine.doc.id}`, me.cookie)).status).toBe(200)
      expect((await api(`/api/tool-documents/${mine.doc.id}`, me.cookie, { method: 'DELETE' })).status).toBe(204)
    })
  }

  for (const code of ['md', 'hr_admin', 'dept_manager'] as const) {
    it(`${code} sees and deletes anyone's document`, async () => {
      const intern = await user('intern')
      const boss = await user(code)
      const theirs = await doc(intern.id)
      const list = await api(`/api/tool-documents?kind=all&user_id=${intern.id}`, boss.cookie)
      expect(list.body.scope).toBe('organisation')
      expect(list.body.items.map((d: { id: string }) => d.id)).toEqual([theirs.doc.id])
      expect((await api(`/api/tool-documents/${theirs.doc.id}`, boss.cookie)).status).toBe(200)
      expect((await api(`/api/tool-jobs/${theirs.job.id}`, boss.cookie)).status).toBe(200)
      expect((await api(`/api/tool-documents/${theirs.doc.id}`, boss.cookie, { method: 'DELETE' })).status).toBe(204)
    })
  }
})

describe('Settings → Roles: module grants keep the role scope', () => {
  it('re-granting Tools in full to Associate keeps documents at self scope and reads back as full', async () => {
    const admin = await user('hr_admin')
    const employee = await prisma.role.findUniqueOrThrow({ where: { code: 'employee' } })
    expect((await api(`/api/settings/roles/${employee.id}/modules/tools`, admin.cookie, { method: 'PUT', body: { access: 'none' } })).status).toBe(200)
    expect((await api(`/api/settings/roles/${employee.id}/modules/tools`, admin.cookie, { method: 'PUT', body: { access: 'full' } })).status).toBe(200)
    const g = await grantsOf('employee')
    expect(g.get('tools.documents.read')).toBe('self')
    expect(g.get('tools.documents.manage')).toBe('self')
    expect(g.get('tools.pdf_to_excel')).toBe('organisation')
    const mods = await api('/api/settings/role-modules', admin.cookie)
    const row = mods.body.roles.find((r: { code: string }) => r.code === 'employee')
    expect(row.modules.tools).toBe('full')
    expect(row.modules.books).toBe('full')
    expect(row.modules.books_edit).toBe('none')
    expect(mods.body.modules.map((m: { code: string }) => m.code)).toEqual(expect.arrayContaining(['books', 'books_edit']))
  })
})

describe('Deploy correction for databases set up before the lock-down', () => {
  async function oldGrants() {
    // What setupRoles wrote before: Books inside Tools, everything at organisation scope.
    const perms = await prisma.permission.findMany({ where: { code: { startsWith: 'books.' } } })
    for (const code of ['employee', 'intern'] as const) {
      const role = await prisma.role.findUniqueOrThrow({ where: { code } })
      await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id, scope: 'organisation' })), skipDuplicates: true })
      await prisma.rolePermission.updateMany({ where: { roleId: role.id, permission: { code: { startsWith: 'tools.documents.' } } }, data: { scope: 'organisation' } })
      await prisma.auditLog.deleteMany({ where: { action: TOOLS_LOCKDOWN_ACTION, entityId: role.id } })
    }
  }

  it('the seed (setupRoles without force) removes Books editing and limits documents to self, once', async () => {
    await setupRoles(prisma, { force: true })
    await oldGrants()
    expect([...(await grantsOf('intern')).keys()].filter((c) => c.startsWith('books.'))).toHaveLength(5)

    await setupRoles(prisma)

    for (const code of ['employee', 'intern'] as const) {
      const g = await grantsOf(code)
      expect([...g.keys()].filter((c) => c.startsWith('books.')).sort(), code).toEqual(['books.access', 'books.reports'])
      expect(g.get('tools.documents.read'), code).toBe('self')
      expect(g.get('tools.documents.manage'), code).toBe('self')
      expect(g.get('tools.access'), code).toBe('organisation')
      expect(g.get('workstation.access'), code).toBe('organisation')
      const role = await prisma.role.findUniqueOrThrow({ where: { code } })
      expect(await prisma.auditLog.count({ where: { action: TOOLS_LOCKDOWN_ACTION, entityId: role.id } })).toBe(1)
    }
    // Other roles untouched.
    expect((await grantsOf('dept_manager')).get('books.accountant')).toBe('organisation')
    expect((await grantsOf('dept_manager')).get('tools.documents.read')).toBe('organisation')

    // Behaviourally: the intern can view Books but not change it.
    const intern = await user('intern')
    const status = await api('/api/books/status', intern.cookie)
    expect(status.status).toBe(200)
    expect(status.body.permissions).toEqual({ manage: false, accountant: false, settings: false, reports: true })

    // A later deliberate grant in Settings survives the next deploy.
    const admin = await user('hr_admin')
    const employee = await prisma.role.findUniqueOrThrow({ where: { code: 'employee' } })
    expect((await api(`/api/settings/roles/${employee.id}/modules/books_edit`, admin.cookie, { method: 'PUT', body: { access: 'full' } })).status).toBe(200)
    await setupRoles(prisma)
    expect((await grantsOf('employee')).get('books.accountant')).toBe('organisation')
    expect(await prisma.auditLog.count({ where: { action: TOOLS_LOCKDOWN_ACTION, entityId: employee.id } })).toBe(1)
  })
})
