/**
 * Production checks for secrets and encryption keys. Pure functions so they
 * can be tested; lib/env.ts runs them at boot and refuses to start on a bad
 * value — a copied-and-forgotten example value must never sign real sessions.
 */

// Shapes the example files and tutorials use. A value containing any of these
// was never generated for this deployment.
const PLACEHOLDER = /(change[-_ ]?me|changeme|your[-_ ]?(secret|key)|placeholder|example|replace[-_ ]?me)/i

/** Why `value` is not acceptable as a signing secret, or null when it is. */
export function secretProblem(value: string): string | null {
  if (PLACEHOLDER.test(value)) return 'is still a placeholder from an example file — generate one with `openssl rand -hex 32`'
  if (value.length < 32) return 'must be at least 32 characters — generate one with `openssl rand -hex 32`'
  if (new Set(value).size < 8) return 'does not look random — generate one with `openssl rand -hex 32`'
  return null
}

/** Why `value` is not a usable AES-256 key (base64 of 32 bytes), or null. */
export function encryptionKeyProblem(value: string): string | null {
  if (PLACEHOLDER.test(value)) return 'is still a placeholder from an example file — generate one with `openssl rand -base64 32`'
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return 'must be base64 — generate one with `openssl rand -base64 32`'
  const bytes = Buffer.from(value, 'base64').length
  if (bytes !== 32) return `must decode to 32 bytes (got ${bytes}) — generate one with \`openssl rand -base64 32\``
  return null
}
