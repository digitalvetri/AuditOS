import { describe, expect, it } from 'vitest'
import { encryptionKeyProblem, secretProblem } from '../secrets.js'

describe('secretProblem (production signing secrets)', () => {
  it('accepts a long random value', () => {
    expect(secretProblem('9f2c1d7e0b4a8c6f5e3d2b1a0c9e8d7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d')).toBeNull()
  })
  it('rejects the example placeholders even though they are long enough', () => {
    expect(secretProblem('change-me-openssl-rand-hex-32')).toMatch(/placeholder/)
    expect(secretProblem('changeme-changeme-changeme-changeme')).toMatch(/placeholder/)
    expect(secretProblem('your-secret-here-your-secret-here-1234')).toMatch(/placeholder/)
  })
  it('requires at least 32 characters', () => {
    expect(secretProblem('a1b2c3d4e5f6a7b8c9d0')).toMatch(/32/)
  })
  it('rejects a single repeated character', () => {
    expect(secretProblem('a'.repeat(64))).toMatch(/random/)
  })
})

describe('encryptionKeyProblem (AES-256 keys, base64 of 32 bytes)', () => {
  it('accepts a real key', () => {
    expect(encryptionKeyProblem(Buffer.alloc(32, 7).toString('base64'))).toBeNull()
  })
  it('rejects the example placeholder (wrong length)', () => {
    expect(encryptionKeyProblem('change-me-openssl-rand-base64-32')).not.toBeNull()
  })
  it('rejects a key of the wrong size', () => {
    expect(encryptionKeyProblem(Buffer.alloc(24, 1).toString('base64'))).toMatch(/32 bytes/)
  })
})
