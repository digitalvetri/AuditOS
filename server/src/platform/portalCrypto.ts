/**
 * AES-256-GCM helper for GST portal credentials at rest — GST-RETURNS-
 * CASE-SCREEN §9-5.
 *
 * The key comes from PORTAL_ACCESS_ENC_KEY (32 raw bytes, base64-encoded).
 * The .env.docker file carries a demo key; production must supply its own
 * via a secrets manager. Rotating the key invalidates every ciphertext —
 * there is no re-encrypt path.
 *
 * Ciphertext format on the wire and at rest is base64 of
 *   iv (12 bytes) | ciphertext (var) | authTag (16 bytes)
 * concatenated. No JSON envelope — every byte is meaningful and lifting
 * the tag off the end is trivial for the decrypt path.
 *
 * IMPORTANT — never include the plaintext, the ciphertext or the key in
 * an error message. `throw new Error('portal_access <op> failed for field='+f)`
 * is the ONLY acceptable shape. A stack trace surfaces in logs.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12  // GCM's canonical IV size
const TAG_LEN = 16 // GCM's canonical tag size

let cachedKey: Buffer | null = null
function key(): Buffer {
  if (cachedKey) return cachedKey
  const raw = process.env.PORTAL_ACCESS_ENC_KEY
  if (!raw) throw new Error('portal_access misconfigured: PORTAL_ACCESS_ENC_KEY is unset')
  const buf = Buffer.from(raw, 'base64')
  if (buf.length !== 32) throw new Error('portal_access misconfigured: PORTAL_ACCESS_ENC_KEY must decode to 32 bytes')
  cachedKey = buf
  return buf
}

/** Encrypt a plaintext string. Returns null when input is null/empty. */
export function encryptPortalSecret(plaintext: string | null | undefined, field: string): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null
  try {
    const iv = randomBytes(IV_LEN)
    const cipher = createCipheriv(ALGO, key(), iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, ct, tag]).toString('base64')
  } catch {
    // Redact — never surface plaintext or key material in the message.
    throw new Error(`portal_access encrypt failed for field=${field}`)
  }
}

/** Decrypt a ciphertext produced by {@link encryptPortalSecret}. */
export function decryptPortalSecret(ciphertext: string | null | undefined, field: string): string | null {
  if (!ciphertext) return null
  try {
    const buf = Buffer.from(ciphertext, 'base64')
    if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error('short')
    const iv = buf.subarray(0, IV_LEN)
    const tag = buf.subarray(buf.length - TAG_LEN)
    const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN)
    const decipher = createDecipheriv(ALGO, key(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    throw new Error(`portal_access decrypt failed for field=${field}`)
  }
}

/**
 * Mask a phone number to the shape '98••••4471' — first two digits, four
 * dots, last four digits. Used for registeredMobileMasked and for
 * rendering otpContactNumber in read-only summaries. Idempotent — a
 * string already containing '•' is returned as-is.
 */
export function maskPhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  if (raw.includes('•')) return raw
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 6) return raw  // too short to mask meaningfully
  return `${digits.slice(0, 2)}••••${digits.slice(-4)}`
}
