/**
 * Sliding-window rate limit, in-memory. Per-key (usually user_id).
 * Used by check-in/out (10/min/user per §9).
 *
 * Real backend swaps this for Redis / a proper limiter.
 */

const windows = new Map<string, number[]>();

export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;
  const bucket = (windows.get(key) ?? []).filter((t) => t > cutoff);
  if (bucket.length >= max) {
    windows.set(key, bucket);
    return false;
  }
  bucket.push(now);
  windows.set(key, bucket);
  return true;
}

/** Test / verify helper — reset all buckets. Never call in production. */
export function __rateLimitReset(): void {
  windows.clear();
}
