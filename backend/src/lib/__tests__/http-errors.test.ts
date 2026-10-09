import { describe, expect, it } from 'vitest'
import { errorMiddleware } from '../http.js'

function run(err: unknown) {
  const out: { status?: number; body?: any } = {}
  const res = { status(s: number) { out.status = s; return this }, json(b: unknown) { out.body = b; return this } }
  errorMiddleware(err, {} as never, res as never, () => undefined)
  return out
}

describe('errorMiddleware', () => {
  it('turns a 32-bit amount overflow into a clear 422, not a 500', () => {
    const e = new Error("Error occurred during query execution: ConversionError(\"Unable to fit integer value '3000000000' into an INT4 (32-bit signed integer).\")")
    const r = run(e)
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('amount_too_large')
    expect(r.body.error.message).toMatch(/2,14,74,836/)
  })
  it('a BIGINT overflow is a 422 without the 32-bit figure', () => {
    const r = run(new Error('bigint out of range'))
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('amount_too_large')
    expect(r.body.error.message).not.toMatch(/2,14,74,836/)
  })
  it('also catches Postgres integer out of range', () => {
    expect(run(Object.assign(new Error('integer out of range'), { code: '22003' })).status).toBe(422)
  })
  it('anything else is still a generic 500', () => {
    expect(run(new Error('boom')).status).toBe(500)
  })
})
