/**
 * Unit tests for the fake GSTN client — ARN shape, determinism, and
 * the status round-trip.
 *
 * The fake client is what dev + tests file returns through, so any
 * quirk here silently affects a lot of downstream code. Keep this file
 * tight and exhaustive.
 */
import { describe, expect, it } from 'vitest'
import { FakeGstnClient, buildFakeArn } from '../services/gstn/FakeGstnClient.js'
import type { GstnSubmitInput } from '../services/gstn/GstnClient.js'
import { resolveGstnMode, createGstnClient, resetGstnClientForTests } from '../services/gstn/index.js'

const sample: GstnSubmitInput = {
  gstin: '33AAACS1234A1Z5',
  period: '2026-08',
  returnType: 'GSTR-1',
  payloadJson: '{"whatever": true}',
}

describe('FakeGstnClient.submitGstr1', () => {
  it('mints an ARN in the 15-char format', async () => {
    const client = new FakeGstnClient()
    const { arn } = await client.submitGstr1(sample)
    expect(arn).toHaveLength(15)
    expect(arn).toMatch(/^[A-Z]{2}\d{13}$/)
  })

  it('encodes the period year and month into positions 3-6', async () => {
    const client = new FakeGstnClient()
    const { arn } = await client.submitGstr1(sample)
    expect(arn.slice(2, 4)).toBe('26')
    expect(arn.slice(4, 6)).toBe('08')
  })

  it('is deterministic — same input, same ARN', async () => {
    const client = new FakeGstnClient()
    const a = await client.submitGstr1(sample)
    const b = await client.submitGstr1(sample)
    expect(a.arn).toBe(b.arn)
  })

  it('returns different ARNs for different taxpayers', async () => {
    const client = new FakeGstnClient()
    const a = await client.submitGstr1(sample)
    const b = await client.submitGstr1({ ...sample, gstin: '29AAACB0000B1Z5' })
    expect(a.arn).not.toBe(b.arn)
  })

  it('returns different ARNs for different periods', async () => {
    const client = new FakeGstnClient()
    const a = await client.submitGstr1(sample)
    const b = await client.submitGstr1({ ...sample, period: '2026-09' })
    expect(a.arn).not.toBe(b.arn)
  })

  it('returns different ARNs for GSTR-1 vs GSTR-3B', async () => {
    const client = new FakeGstnClient()
    const a = await client.submitGstr1(sample)
    const b = await client.submitGstr3b({ ...sample, returnType: 'GSTR-3B' })
    expect(a.arn).not.toBe(b.arn)
  })

  it('rejects a malformed period', async () => {
    const client = new FakeGstnClient()
    await expect(client.submitGstr1({ ...sample, period: '2026/08' })).rejects.toThrow(/invalid period/)
  })

  it('rejects a short gstin', async () => {
    const client = new FakeGstnClient()
    await expect(client.submitGstr1({ ...sample, gstin: 'SHORT' })).rejects.toThrow(/invalid gstin/)
  })

  it('embeds fake-mode marker in responseJson', async () => {
    const client = new FakeGstnClient()
    const { responseJson } = await client.submitGstr1(sample)
    const parsed = JSON.parse(responseJson)
    expect(parsed.mode).toBe('fake')
  })
})

describe('buildFakeArn — pure ARN builder', () => {
  it('produces the same value the client would', async () => {
    const built = buildFakeArn(sample)
    const client = new FakeGstnClient()
    const { arn } = await client.submitGstr1(sample)
    expect(built).toBe(arn)
  })
})

describe('FakeGstnClient.getStatus', () => {
  it('reports filed for an ARN it minted', async () => {
    const client = new FakeGstnClient()
    const { arn } = await client.submitGstr1(sample)
    const status = await client.getStatus(arn)
    expect(status.status).toBe('filed')
    expect(status.filedAt).toBeInstanceOf(Date)
  })

  it('reports unknown for a foreign ARN', async () => {
    const client = new FakeGstnClient()
    const status = await client.getStatus('ZZ2608000000123')
    expect(status.status).toBe('unknown')
  })
})

describe('resolveGstnMode', () => {
  it('defaults to fake when GSTN_MODE is unset', () => {
    delete process.env.GSTN_MODE
    expect(resolveGstnMode()).toBe('fake')
  })

  it('accepts "live" (case-insensitive)', () => {
    process.env.GSTN_MODE = 'LIVE'
    expect(resolveGstnMode()).toBe('live')
    delete process.env.GSTN_MODE
  })

  it('falls back to fake for unknown values', () => {
    process.env.GSTN_MODE = 'sandbox'
    expect(resolveGstnMode()).toBe('fake')
    delete process.env.GSTN_MODE
  })
})

describe('createGstnClient factory', () => {
  it('returns a FakeGstnClient by default', () => {
    resetGstnClientForTests()
    delete process.env.GSTN_MODE
    const client = createGstnClient()
    expect(client.mode).toBe('fake')
  })

  it('caches the client across calls', () => {
    resetGstnClientForTests()
    const a = createGstnClient()
    const b = createGstnClient()
    expect(a).toBe(b)
  })
})
