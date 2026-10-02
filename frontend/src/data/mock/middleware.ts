/**
 * MSW middleware that mirrors the Express chain per §4.3:
 *   authenticate → authorize(permission, scope) → validate → handle → audit
 *
 * When we swap to real Express, these compositions become Express middleware
 * with the same names. Handler bodies port over unchanged.
 */

import { HttpResponse, delay, type PathParams } from 'msw';
import type { User } from '@/data/models';
import { db, employeeOf } from './db';
import {
  hasPermission,
  type PermissionCode,
  type Scope,
} from '@/platform/rbac/matrix';

const ACCESS_COOKIE = 'ao_access';

// Simulate 150–400ms latency per §2.
async function realisticLatency(): Promise<void> {
  const ms = 150 + Math.floor(Math.random() * 250);
  await delay(ms);
}

/**
 * Read session token.
 *
 * Service workers do NOT expose the browser's Cookie header on request.headers
 * for security reasons — so we can't parse it out of request headers as we
 * would in Express. MSW v2 provides the parsed cookies via the resolver's
 * `cookies` argument, which reads from document.cookie. This is a real
 * gotcha; when we swap to Express, revert to reading request.headers.cookie.
 */
function tokenFromCookies(cookies: Record<string, string>): string | null {
  const raw = cookies[ACCESS_COOKIE];
  return raw ? decodeURIComponent(raw) : null;
}

function currentUser(cookies: Record<string, string>): User | null {
  const token = tokenFromCookies(cookies);
  if (!token) return null;
  const user = db.read().users.find((u) => u.id === token && u.is_active);
  return user ?? null;
}

export interface Ctx {
  user: User;
  employee: ReturnType<typeof employeeOf>;
  request: Request;
  params: PathParams;
}

type Resolver = (ctx: Ctx) => Response | Promise<Response>;

/** Envelope used by every handler for consistency (§9). */
export function ok<T>(data: T, init?: ResponseInit): Response {
  return HttpResponse.json({ data }, init);
}

export function err(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  return HttpResponse.json(
    { error: { code, message, details } },
    { status },
  );
}

/**
 * withAuth — requires a valid session. Returns 401 otherwise.
 * Pass to withScope, or use standalone for endpoints that only need "logged in".
 */
export function withAuth(resolver: Resolver) {
  return async ({
    request,
    params,
    cookies,
  }: {
    request: Request;
    params: PathParams;
    cookies: Record<string, string>;
  }) => {
    await realisticLatency();
    const user = currentUser(cookies);
    if (!user) {
      return err(401, 'unauthenticated', 'Sign in to continue.');
    }
    const employee = employeeOf(user);
    return resolver({ user, employee, request, params });
  };
}

/**
 * withScope — the authorize step. 403 if the caller's role doesn't grant the
 * permission at the required scope. Never 404, never empty 200 — §5 hard rule.
 *
 * `resourceScopeCheck` (optional) is called with the ctx AFTER permission
 * passes to enforce per-row scoping (e.g. "same department"). Return true to
 * allow, false to 403.
 */
export function withScope(
  permission: PermissionCode,
  scope: Scope,
  resourceScopeCheck?: (ctx: Ctx) => boolean | Promise<boolean>,
) {
  return (resolver: Resolver) =>
    withAuth(async (ctx) => {
      const role = db.read().roles.find((r) => r.id === ctx.user.role_id);
      if (!role) return err(403, 'no_role', 'Access denied.');
      if (!hasPermission(role.code, permission, scope)) {
        return err(403, 'forbidden', 'Access denied.');
      }
      if (resourceScopeCheck) {
        const passes = await resourceScopeCheck(ctx);
        if (!passes) return err(403, 'forbidden', 'Access denied.');
      }
      return resolver(ctx);
    });
}

/** audit — append-only log entry. Call from handlers on state-changing ops. */
export function audit(entry: {
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  before_json?: unknown;
  after_json?: unknown;
  request?: Request;
}): void {
  db.write((d) => {
    d.auditLog.push({
      id: `audit-${crypto.randomUUID()}`,
      actor_user_id: entry.actor_user_id,
      action: entry.action,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      before_json: entry.before_json ?? null,
      after_json: entry.after_json ?? null,
      ip: null,
      user_agent: entry.request?.headers.get('user-agent') ?? null,
      created_at: new Date().toISOString(),
    });
  });
}

/** Cookie header helpers. Mock: no signing, no expiry — swap for real JWT. */
export function setAccessCookie(userId: string): string {
  // 8h, httpOnly is set by the browser when Secure+SameSite allow it; MSW
  // sets Set-Cookie which the browser honours for our origin.
  return `${ACCESS_COOKIE}=${encodeURIComponent(userId)}; Path=/; SameSite=Lax; Max-Age=28800`;
}

export function clearAccessCookie(): string {
  // Explicit past expiry so browsers that ignore Max-Age=0 still drop it.
  return `${ACCESS_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
