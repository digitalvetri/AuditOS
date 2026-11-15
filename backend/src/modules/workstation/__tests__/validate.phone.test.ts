import { describe, expect, it } from 'vitest'
import { FieldErrors } from '../validate.js'

function phone(input: unknown, required = true): { value: string | undefined; error: string | undefined } {
  const v = new FieldErrors()
  const value = v.phone('contact_number', input, required)
  return { value, error: v.fields.contact_number }
}

describe('v.phone — accept landlines (POST-DELIVERY-CHANGES §B2)', () => {
  // Mobile paths — unchanged
  it.each([
    ['9876543210',    '9876543210'],
    ['+91 98765 43210', '9876543210'],
    ['098765 43210',  '9876543210'],
    ['98765-43210',   '9876543210'],
    ['(9876) 543210', '9876543210'],
    ['9123456789',    '9123456789'], // starts with 9
    ['6123456789',    '6123456789'], // starts with 6
  ])('mobile %j → %j', (input, expected) => {
    const r = phone(input)
    expect(r.error).toBeUndefined()
    expect(r.value).toBe(expected)
  })

  // Landlines — NEWLY accepted
  it.each([
    ['022 12345678',   '2212345678'],   // Mumbai STD
    ['044-12345678',   '4412345678'],   // Chennai STD
    ['+91 80 12345678','8012345678'],   // Bangalore STD with +91
    ['0 44 2345 6789', '4423456789'],   // mix of STD + local with strays
    ['04212345678',    '4212345678'],   // 4-digit STD + 7 digits
    ['04142 234567',   '4142234567'],   // 5-digit STD + 6 digits
  ])('landline %j → %j', (input, expected) => {
    const r = phone(input)
    expect(r.error).toBeUndefined()
    expect(r.value).toBe(expected)
  })

  // Rejections — bad input stays bad
  it.each([
    ['12345',          'too short'],
    ['123456789012',   'too long (>11 after trim)'],
    ['0000000000',     'all zeros'],
    ['abcdefghij',     'not digits'],
  ])('rejects %j (%s)', (input) => {
    const r = phone(input)
    expect(r.error).toBeDefined()
    expect(r.value).toBeUndefined()
  })

  it('required=false accepts an empty string → undefined, no error', () => {
    const r = phone('', false)
    expect(r.error).toBeUndefined()
    expect(r.value).toBeUndefined()
  })
})
