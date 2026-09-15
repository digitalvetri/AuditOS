/**
 * GSTN client factory. Reads `GSTN_MODE` from the environment (default
 * `fake`) and returns the concrete client. The factory is cached in
 * module state so every route resolves the same instance per process.
 *
 * Bring a real submission online:
 *   GSTN_MODE=live
 *   GSTN_BASE_URL=https://gsp.example.com
 *   GSTN_GSP_USERNAME=...
 *   GSTN_GSP_PASSWORD=...
 *
 * With any of those missing when `GSTN_MODE=live`, boot fails — a
 * silent fallback to the fake client on a production box would let
 * real work quietly file into a synthetic ARN.
 */
import { FakeGstnClient } from './FakeGstnClient.js'
import { LiveGstnClient, type LiveGstnConfig } from './LiveGstnClient.js'
import type { GstnClient, GstnMode } from './GstnClient.js'

let cached: GstnClient | null = null

export function resolveGstnMode(): GstnMode {
  const raw = (process.env.GSTN_MODE ?? 'fake').toLowerCase()
  return raw === 'live' ? 'live' : 'fake'
}

export function createGstnClient(): GstnClient {
  if (cached) return cached
  const mode = resolveGstnMode()
  if (mode === 'live') {
    const config: LiveGstnConfig = {
      baseUrl:  process.env.GSTN_BASE_URL  ?? '',
      username: process.env.GSTN_GSP_USERNAME ?? '',
      password: process.env.GSTN_GSP_PASSWORD ?? '',
    }
    cached = new LiveGstnClient(config)
  } else {
    cached = new FakeGstnClient()
  }
  return cached
}

/** Reset the cached client. Test-only. */
export function resetGstnClientForTests(): void {
  cached = null
}

export type { GstnClient, GstnMode, GstnStatus, GstnStatusResult, GstnSubmitInput, GstnSubmitResult } from './GstnClient.js'
export { GstnError } from './GstnClient.js'
export { FakeGstnClient } from './FakeGstnClient.js'
export { LiveGstnClient } from './LiveGstnClient.js'
