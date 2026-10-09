import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { assertFilesClean, scanBuffer } from '../virusScan.js'
import { createApp } from '../../app.js'
import { signToken } from '../auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { setupRoles } from '../../../prisma/setup-roles.js'

/**
 * clamd INSTREAM against a fake clamd: it reassembles the length-prefixed
 * chunks and answers FOUND when the stream holds the EICAR marker.
 */

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
let clamd: net.Server
let clamPort = 0
let received: Buffer[] = []
let mode: 'normal' | 'hang' | 'error' = 'normal'

function startFakeClamd(): Promise<void> {
  clamd = net.createServer((sock) => {
    let buf = Buffer.alloc(0)
    let gotCommand = false
    const body: Buffer[] = []
    sock.on('data', (d) => {
      if (mode === 'hang') return
      buf = Buffer.concat([buf, d])
      if (!gotCommand) {
        const z = buf.indexOf(0)
        if (z < 0) return
        expect(buf.subarray(0, z).toString()).toBe('zINSTREAM')
        buf = buf.subarray(z + 1)
        gotCommand = true
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0)
        if (len === 0) {
          const all = Buffer.concat(body)
          received.push(all)
          if (mode === 'error') sock.end('INSTREAM size limit exceeded. ERROR\0')
          else sock.end(all.includes(Buffer.from('EICAR-STANDARD')) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0')
          return
        }
        if (buf.length < 4 + len) return
        body.push(buf.subarray(4, 4 + len))
        buf = buf.subarray(4 + len)
      }
    })
  })
  return new Promise((r) => clamd.listen(0, '127.0.0.1', () => { clamPort = (clamd.address() as AddressInfo).port; r() }))
}

function useClamd(extra: Record<string, string> = {}) {
  process.env.CLAMAV_HOST = '127.0.0.1'
  process.env.CLAMAV_PORT = String(clamPort)
  Object.assign(process.env, extra)
}

beforeAll(startFakeClamd)
afterEach(() => {
  delete process.env.CLAMAV_HOST; delete process.env.CLAMAV_PORT; delete process.env.CLAMAV_REQUIRED; delete process.env.CLAMAV_TIMEOUT_MS
  mode = 'normal'; received = []
})
afterAll(() => new Promise<void>((r) => clamd.close(() => r())))

describe('scanBuffer (clamd INSTREAM)', () => {
  it('is disabled without CLAMAV_HOST', async () => {
    expect(await scanBuffer(Buffer.from('x'))).toEqual({ status: 'disabled' })
  })

  it('streams the whole file in length-prefixed chunks and reports clean', async () => {
    useClamd()
    const big = Buffer.alloc(200 * 1024, 7) // several 64 KB chunks
    expect(await scanBuffer(big)).toEqual({ status: 'clean' })
    expect(received[0].equals(big)).toBe(true)
  })

  it('reports an infected file with its signature', async () => {
    useClamd()
    expect(await scanBuffer(Buffer.from(EICAR))).toEqual({ status: 'infected', signature: 'Eicar-Test-Signature' })
  })

  it('reports unreachable, timed-out and erroring scanners as unavailable', async () => {
    process.env.CLAMAV_HOST = '127.0.0.1'
    process.env.CLAMAV_PORT = '1' // nothing listens there
    expect((await scanBuffer(Buffer.from('x'))).status).toBe('unavailable')

    useClamd({ CLAMAV_TIMEOUT_MS: '200' })
    mode = 'hang'
    const t = await scanBuffer(Buffer.from('x'))
    expect(t).toMatchObject({ status: 'unavailable' })
    expect((t as { reason: string }).reason).toContain('timed out')

    mode = 'error'
    expect((await scanBuffer(Buffer.from('x'))).status).toBe('unavailable')
  })
})

describe('assertFilesClean', () => {
  it('422 for an infected upload; fail-open when unreachable unless CLAMAV_REQUIRED=true', async () => {
    useClamd()
    await expect(assertFilesClean([{ buffer: Buffer.from(EICAR), originalname: 'eicar.pdf' }]))
      .rejects.toMatchObject({ status: 422, code: 'virus_detected', message: 'This file failed the virus scan.' })
    await expect(assertFilesClean([{ buffer: Buffer.from('fine') }])).resolves.toBeUndefined()

    process.env.CLAMAV_PORT = '1'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(assertFilesClean([{ buffer: Buffer.from('fine') }])).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('upload allowed without a scan'))
    warn.mockRestore()

    process.env.CLAMAV_REQUIRED = 'true'
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(assertFilesClean([{ buffer: Buffer.from('fine') }])).rejects.toMatchObject({ status: 503 })
    err.mockRestore()
  })
})

describe('upload routes run the scan', () => {
  let server: Server
  let base = ''
  let cookie = ''
  let clientId = ''
  beforeAll(async () => {
    server = createApp().listen(0)
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Scan Firm' } })).id
    await setupRoles(prisma, { force: true })
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'md' } })
    const ws = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
    const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('AO'), firstName: 'V', lastName: 'S', fullName: `V S ${uid('n')}`, email: `${uid('vs')}@x.local`, joiningDate: '2020-01-01', workScheduleId: ws } })
    const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
    cookie = `ao_access=${signToken(u.id)}`
    clientId = (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Scan Co', contactPerson: 'P', contactNumber: '9876543210', accountManagerId: emp.id, onboardingDate: '2026-01-01' } })).id
  })
  afterAll(() => { server.close() })

  async function folderUpload(bytes: Buffer) {
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: 'text/plain' }), 'note.txt')
    const res = await fetch(`${base}/api/clients/${clientId}/document-folders/uploads:kyc/upload`, { method: 'POST', headers: { Cookie: cookie }, body: form })
    return { status: res.status, body: await res.json() as any }
  }

  it('a client-folder upload carrying EICAR is refused with 422 before it is stored', async () => {
    useClamd()
    const r = await folderUpload(Buffer.from(EICAR))
    expect(r.status).toBe(422)
    expect(r.body.error).toMatchObject({ code: 'virus_detected', message: 'This file failed the virus scan.' })
    expect(received).toHaveLength(1)
  })
})
