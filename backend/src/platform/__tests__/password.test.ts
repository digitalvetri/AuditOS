import { describe, expect, it } from 'vitest'
import { passwordProblem } from '../password.js'

describe('passwordProblem', () => {
  it('accepts 8+ chars with a letter and a digit', () => {
    expect(passwordProblem('Jns@2026')).toBeNull()
    expect(passwordProblem('abcdefg1')).toBeNull()
  })
  it('rejects short passwords', () => {
    expect(passwordProblem('a1b2c3')).toBe('Password must be at least 8 characters.')
  })
  it('rejects passwords without a letter or without a digit', () => {
    expect(passwordProblem('12345678')).toBe('Password must contain letters and numbers.')
    expect(passwordProblem('abcdefgh')).toBe('Password must contain letters and numbers.')
  })
  it('rejects absurdly long passwords', () => {
    expect(passwordProblem('a1'.repeat(65))).toBe('Password must be at most 128 characters.')
  })
})
