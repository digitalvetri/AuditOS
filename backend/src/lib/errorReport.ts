import crypto from 'node:crypto'

/**
 * Optional error reporting with no SDK dependency. When SENTRY_DSN is set,
 * an unhandled error is POSTed to Sentry's envelope endpoint as a minimal
 * event: the error type, message, stack and the route (METHOD + path, never
 * the query string — signed-link tokens travel there — and never a body).
 *
 * Fire-and-forget: reporting must never slow down or break a response, so a
 * failed POST is dropped silently.
 */
interface Dsn { endpoint: string; auth: string }

let parsed: Dsn | null | undefined

function dsn(): Dsn | null {
  if (parsed !== undefined) return parsed
  parsed = null
  const raw = process.env.SENTRY_DSN?.trim()
  if (!raw) return parsed
  try {
    // https://<public key>@<host>[/<path>]/<project id>
    const u = new URL(raw)
    const project = u.pathname.split('/').filter(Boolean).pop()
    const prefix = u.pathname.split('/').filter(Boolean).slice(0, -1).join('/')
    if (!u.username || !project) throw new Error('bad dsn')
    parsed = {
      endpoint: `${u.protocol}//${u.host}/${prefix ? `${prefix}/` : ''}api/${project}/envelope/`,
      auth: `Sentry sentry_version=7, sentry_key=${u.username}, sentry_client=auditos-api/1.0`,
    }
  } catch {
    console.warn('[errorReport] SENTRY_DSN is not a valid DSN — error reporting is off.')
  }
  return parsed
}

export function reportError(err: unknown, route?: string): void {
  const target = dsn()
  if (!target) return
  try {
    const e = err instanceof Error ? err : new Error(String(err))
    const eventId = crypto.randomUUID().replace(/-/g, '')
    const event = {
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: 'node',
      level: 'error',
      environment: process.env.NODE_ENV ?? 'development',
      transaction: route,
      // Prisma messages quote the query's arguments (salary, bank, PAN…):
      // never send those to a third party — the error code is enough.
      exception: { values: [{ type: e.name, value: /^Prisma/.test(e.name) || /prisma\./i.test(e.message) ? `${e.name}${(e as { code?: string }).code ? ` ${(e as { code?: string }).code}` : ''}` : e.message.slice(0, 2000) }] },
      // Stack frames only (the first line repeats the message).
      extra: { stack: e.stack?.split('\n').slice(1).join('\n').slice(0, 8000) },
    }
    const body = `${JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`
    void fetch(target.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': target.auth },
      body,
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined)
  } catch {
    /* never let reporting throw */
  }
}
