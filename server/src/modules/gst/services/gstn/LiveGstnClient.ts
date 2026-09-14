/**
 * Real-GSTN client — SCAFFOLD ONLY.
 *
 * Every method throws `GstnError('unavailable')` today. The class exists so
 * the factory can select it via `GSTN_MODE=live` and downstream code can
 * type against `GstnClient` without conditional imports.
 *
 * Wiring the real endpoints requires:
 *   - a GSP contract (Cygnet / Masters / TaxPro / etc.)
 *   - GSTN_BASE_URL, GSTN_GSP_USERNAME, GSTN_GSP_PASSWORD
 *   - per-taxpayer OTP / API session tokens
 *   - the GSTN public-key rotation flow for the encrypted payload
 *
 * When those land, replace the throws with real HTTP calls. Nothing
 * outside this file needs to change.
 */
import type {
  GstnClient,
  GstnStatusResult,
  GstnSubmitInput,
  GstnSubmitResult,
} from './GstnClient.js'
import { GstnError } from './GstnClient.js'

export interface LiveGstnConfig {
  baseUrl:  string
  username: string
  password: string
}

export class LiveGstnClient implements GstnClient {
  readonly mode = 'live' as const

  constructor(private readonly config: LiveGstnConfig) {
    if (!config.baseUrl || !config.username || !config.password) {
      throw new GstnError('unauthorized', 'LiveGstnClient requires baseUrl, username, password.')
    }
  }

  async submitGstr1(_input: GstnSubmitInput): Promise<GstnSubmitResult> {
    throw new GstnError('unavailable', 'LiveGstnClient.submitGstr1 not implemented yet.')
  }

  async submitGstr3b(_input: GstnSubmitInput): Promise<GstnSubmitResult> {
    throw new GstnError('unavailable', 'LiveGstnClient.submitGstr3b not implemented yet.')
  }

  async getStatus(_arn: string): Promise<GstnStatusResult> {
    throw new GstnError('unavailable', 'LiveGstnClient.getStatus not implemented yet.')
  }
}
