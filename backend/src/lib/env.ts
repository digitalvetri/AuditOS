import fs from 'node:fs'
import path from 'node:path'
import { encryptionKeyProblem, secretProblem } from './secrets.js'

/**
 * Minimal .env loader — avoids a dependency for a handful of values.
 * Real environment variables always win over the file.
 */
const envPath = path.resolve(process.cwd(), '.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    // Strip surrounding quotes: DATABASE_URL="file:./dev.db" must reach
    // Prisma as file:./dev.db, not with the quotes baked into the value.
    const value = trimmed.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    if (!(key in process.env)) process.env[key] = value
  }
}

const nodeEnv = process.env.NODE_ENV ?? 'development'
const isProduction = nodeEnv === 'production'

/**
 * In production a missing secret is a boot failure, never a silent default.
 * In development we generate a per-process random secret rather than shipping
 * a well-known literal — sessions simply do not survive a restart.
 */
function secret(name: string): string {
  const value = process.env[name]
  if (isProduction) {
    if (!value) {
      throw new Error(`${name} is required in production. Set it in the environment (see .env.example).`)
    }
    // A placeholder copied from an example file is publicly known: anyone could
    // forge sessions and signed links with it. Refuse to boot.
    const problem = secretProblem(value)
    if (problem) throw new Error(`${name} ${problem}.`)
    return value
  }
  if (value) {
    const problem = secretProblem(value)
    if (problem) console.warn(`[env] ${name} ${problem} — using it anyway in development.`)
    return value
  }
  console.warn(`[env] ${name} is not set — generating an ephemeral development secret.`)
  return `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

export const env = {
  nodeEnv,
  isProduction,
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: (() => {
    const url = process.env.DATABASE_URL
    if (isProduction && !url) throw new Error('DATABASE_URL is required in production (see docker/.env.docker.example).')
    return url ?? 'file:./dev.db'
  })(),
  jwtSecret: secret('JWT_SECRET'),
  signedUrlSecret: secret('SIGNED_URL_SECRET'),
  signedUrlTtlSeconds: Number(process.env.SIGNED_URL_TTL_SECONDS ?? 300),
  // A link that is pasted into an email or WhatsApp message and opened by the
  // client weeks later. Signed with a separate secret from SIGNED_URL_SECRET
  // so that rotating one does not invalidate the other.
  permanentLinkSecret: secret('PERMANENT_LINK_SECRET'),
  /**
   * How long a shared (email / WhatsApp) document link stays valid. A year by
   * default; links can also be revoked earlier from the share dialog.
   */
  permanentLinkTtlDays: (() => {
    const n = Number(process.env.PERMANENT_LINK_TTL_DAYS ?? 365)
    return Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : 365
  })(),
  /** The absolute origin a client clicks on, e.g. https://audit.example.com. */
  publicAppUrl: process.env.PUBLIC_APP_URL?.replace(/\/$/, '') ?? null,
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 8 * 60 * 60),
  /** Comma-separated list; credentialed CORS never uses '*'. */
  webOrigins: (process.env.WEB_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  cookieName: process.env.SESSION_COOKIE_NAME ?? 'ao_access',
  /**
   * Whether the session cookie carries the `Secure` flag.
   *
   * Defaults to "on in production", which is right for a real deployment
   * behind TLS. It is overridable because the compose stack runs the
   * PRODUCTION build over plain HTTP on a LAN: a browser silently DROPS a
   * Secure cookie on an http:// origin, so login would appear to succeed and
   * then every subsequent request would come back 401. Set COOKIE_SECURE=false
   * for such a deployment — and set it back to true the moment TLS is in front.
   */
  cookieSecure: process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === 'true'
    : isProduction,
}

/**
 * Encryption keys are read lazily by the features that use them, which would
 * let a bad key surface only when a credential is first saved. In production
 * check them at boot instead. The portal-credential key is always required
 * (registration details are core); the Zoho keys only when configured.
 */
if (isProduction) {
  const keys: [string, boolean][] = [
    ['PORTAL_ACCESS_ENC_KEY', true],
    ['ZPAY_ENCRYPTION_KEY', false],
    ['ZBOOKS_ENCRYPTION_KEY', false],
  ]
  for (const [name, required] of keys) {
    const value = process.env[name]
    if (!value) {
      if (required) throw new Error(`${name} is required in production — generate one with \`openssl rand -base64 32\`.`)
      continue
    }
    const problem = encryptionKeyProblem(value)
    if (problem) throw new Error(`${name} ${problem}.`)
  }
  // The portal-autofill launch-token key. Optional (it is otherwise derived
  // from PORTAL_ACCESS_ENC_KEY), but when set it must be a real secret: it
  // authorises the release of a client's portal password.
  const autofill = process.env.PORTAL_AUTOFILL_SECRET
  if (autofill) {
    if (autofill.length < 32) throw new Error('PORTAL_AUTOFILL_SECRET must be at least 32 characters in production — generate one with `openssl rand -base64 32`.')
    const problem = secretProblem(autofill)
    if (problem) throw new Error(`PORTAL_AUTOFILL_SECRET ${problem}.`)
  }
}
