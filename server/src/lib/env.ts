import fs from 'node:fs'
import path from 'node:path'

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
  if (value && value.length >= 16) return value
  if (isProduction) {
    throw new Error(
      `${name} is required in production. Set it in the environment (see .env.example).`,
    )
  }
  if (value) {
    console.warn(`[env] ${name} is shorter than 16 characters — using it anyway in development.`)
    return value
  }
  console.warn(`[env] ${name} is not set — generating an ephemeral development secret.`)
  return `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

export const env = {
  nodeEnv,
  isProduction,
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'file:./dev.db',
  jwtSecret: secret('JWT_SECRET'),
  signedUrlSecret: secret('SIGNED_URL_SECRET'),
  signedUrlTtlSeconds: Number(process.env.SIGNED_URL_TTL_SECONDS ?? 300),
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
