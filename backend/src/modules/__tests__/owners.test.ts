import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureOwners } from '../../../prisma/owners.js'
import { passwordMatches } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'

const email = `${uid('owner')}@x.local`

beforeAll(async () => {
  await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
  await prisma.role.upsert({ where: { code: 'md' }, update: {}, create: { id: 'role-md', code: 'md', name: 'Super Admin' } })
})
afterAll(async () => { await prisma.$disconnect() })

describe('ensureOwners', () => {
  it('creates once, then leaves the password alone unless asked', async () => {
    const spec = [{ email, password: 'First1234', roleCode: 'md' as const }]
    expect((await ensureOwners(prisma, spec, { resetPasswords: false }))[0].action).toBe('created')
    const again = await ensureOwners(prisma, [{ ...spec[0], password: 'Other1234' }], { resetPasswords: false })
    expect(again[0].action).toBe('unchanged')
    let u = await prisma.user.findUniqueOrThrow({ where: { email } })
    expect(passwordMatches(u.passwordHash, 'First1234')).toBe(true)
    expect(u.employeeId).toBeNull()
    expect(u.mustChangePassword).toBe(false)

    await ensureOwners(prisma, [{ ...spec[0], password: 'Other1234' }], { resetPasswords: true })
    u = await prisma.user.findUniqueOrThrow({ where: { email } })
    expect(passwordMatches(u.passwordHash, 'Other1234')).toBe(true)
  })

  it('refuses a weak owner password', async () => {
    await expect(ensureOwners(prisma, [{ email: `${uid('o')}@x.local`, password: 'weak', roleCode: 'md' }], { resetPasswords: false }))
      .rejects.toThrow(/at least 8/)
  })
})
