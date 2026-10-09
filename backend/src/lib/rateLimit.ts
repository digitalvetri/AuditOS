/** In-process fixed-window rate limiter. One node, one process — sufficient here. */
const buckets = new Map<string, { count: number; resetAt: number }>()

/**
 * Keys are per IP / per user, so without eviction the map grows for the life
 * of the process. Sweep expired buckets once a minute; unref'd so it never
 * keeps the process (or a test run) alive.
 */
export function sweepRateLimits(now = Date.now()): number {
  let removed = 0
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) { buckets.delete(key); removed += 1 }
  }
  return removed
}
setInterval(() => sweepRateLimits(), 60_000).unref()

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (bucket.count >= limit) return false
  bucket.count += 1
  return true
}

/** Test hook: how many buckets are held. */
export function rateLimitBucketCount(): number {
  return buckets.size
}
