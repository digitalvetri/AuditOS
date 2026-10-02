/**
 * Origin policy for credentialed CORS.
 *
 * The dev setup proxies /api through Vite with `changeOrigin: false`, so the
 * browser's own Origin header reaches this server untouched — the allow-list
 * is enforced on proxied requests too, not only on genuinely cross-origin
 * ones. That is why opening the app on a LAN address (phone on the same
 * Wi-Fi, a second laptop, Chrome that cannot reach loopback) used to fail:
 * the machine's IP changes and WEB_ORIGIN goes stale.
 *
 * In development we therefore also accept any private / loopback address.
 * In production only the explicit WEB_ORIGIN list is ever accepted.
 */

/** 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16. */
function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  if (octets.some((n) => Number.isNaN(n) || n > 255)) return false
  const [a, b] = octets
  if (a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

/** ::1 loopback, fc00::/7 unique-local, fe80::/10 link-local. */
function isPrivateIPv6(hostname: string): boolean {
  // URL.hostname keeps IPv6 literals in brackets: [::1].
  const ip = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (ip === '::1') return true
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true
  if (/^fe[89ab][0-9a-f]:/.test(ip)) return true
  return false
}

/**
 * A LAN-local origin: loopback, a private IP, or an mDNS `.local` name.
 * Only ever consulted outside production.
 */
export function isLanOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local')) return true
  if (isPrivateIPv4(host)) return true
  if (isPrivateIPv6(host)) return true
  return false
}

/**
 * The single decision point for CORS. `allowLan` is the development
 * relaxation; production passes false so only `allowList` is honoured.
 */
export function isAllowedOrigin(
  origin: string,
  allowList: readonly string[],
  allowLan: boolean,
): boolean {
  if (allowList.includes(origin)) return true
  return allowLan && isLanOrigin(origin)
}
