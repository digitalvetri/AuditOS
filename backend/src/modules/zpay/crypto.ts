/**
 * AES-256-GCM helper for Zoho tokens.
 *
 * Ciphertext format is a single base64 string that packs `iv | tag | ct`:
 *
 *   bytes  0..11    96-bit random IV (never reused for the same key)
 *   bytes 12..27    128-bit auth tag
 *   bytes 28..end   ciphertext
 *
 * A single string is what the DB column stores; the parser rejects
 * anything that does not fit the header lengths so a truncated or
 * mis-typed value fails loudly rather than silently decrypting to garbage.
 *
 * NEVER log plaintext or ciphertext, NEVER embed either in an error message.
 * The functions here throw ZpayCryptoError with a generic message when
 * something goes wrong.
 */
import crypto from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16
const HEADER_LEN = IV_LEN + TAG_LEN

export class ZpayCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZpayCryptoError'
  }
}

export function encryptToken(plaintext: string, key: Buffer): string {
  if (key.length !== 32) {
    throw new ZpayCryptoError('encryption key must be 32 bytes')
  }
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct]).toString('base64')
}

export function decryptToken(ciphertext: string, key: Buffer): string {
  if (key.length !== 32) {
    throw new ZpayCryptoError('encryption key must be 32 bytes')
  }
  let buf: Buffer
  try {
    buf = Buffer.from(ciphertext, 'base64')
  } catch {
    throw new ZpayCryptoError('ciphertext is not valid base64')
  }
  if (buf.length <= HEADER_LEN) {
    throw new ZpayCryptoError('ciphertext is too short')
  }
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, HEADER_LEN)
  const ct = buf.subarray(HEADER_LEN)
  const decipher = crypto.createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return pt.toString('utf8')
  } catch {
    // Tag mismatch means the key changed, the ciphertext was tampered with,
    // or the wrong DB column is being decrypted. Never surface which.
    throw new ZpayCryptoError('failed to decrypt ciphertext')
  }
}
