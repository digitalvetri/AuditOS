/**
 * The one shape a submission client must satisfy. Every route that
 * pushes a return to a portal talks through this interface — never
 * through a concrete class — so switching between `fake` and `live`
 * is a factory flip, not a code change.
 *
 * The fake client (used in dev + tests) mints synthetic ARNs and
 * returns immediately. The live client (scaffolded in this PR, not
 * wired) shapes real GSP API calls. Adding a stub for a new portal
 * (say, GSTR-7 submission for TDS-under-GST) means writing another
 * class against this interface — nothing else changes.
 */

export type GstnMode = 'fake' | 'live'

export interface GstnSubmitInput {
  /** GSTIN of the taxpayer. Encoded in the ARN state prefix. */
  gstin:      string
  /** 'YYYY-MM' return period. */
  period:     string
  /** GSTR-1 | GSTR-3B | GSTR-9 */
  returnType: string
  /** The composed payload — passed through verbatim. */
  payloadJson: string
}

export interface GstnSubmitResult {
  /** The 15-character Acknowledgement Reference Number the portal
   * returned. The fake client mints one deterministically from the
   * input so a re-run in the same period is byte-stable. */
  arn:         string
  /** Wall clock the portal accepted the payload. */
  submittedAt: Date
  /** Verbatim response envelope for the audit trail. */
  responseJson: string
}

export type GstnStatus = 'submitted' | 'filed' | 'rejected' | 'unknown'

export interface GstnStatusResult {
  arn:     string
  status:  GstnStatus
  filedAt: Date | null
  /** Rejection reason surfaced by the portal, if any. */
  message: string | null
}

/**
 * A submission client. Kept small on purpose: submit and status. The
 * two operations that matter after "compose" until we add the
 * DSC/EVC step in a later slice.
 */
export interface GstnClient {
  mode: GstnMode
  submitGstr1(input: GstnSubmitInput): Promise<GstnSubmitResult>
  submitGstr3b(input: GstnSubmitInput): Promise<GstnSubmitResult>
  getStatus(arn: string): Promise<GstnStatusResult>
}

export interface GstnClientError {
  code:    'unauthorized' | 'rejected' | 'network' | 'unavailable'
  message: string
  detail?: unknown
}

export class GstnError extends Error implements GstnClientError {
  constructor(
    public code: GstnClientError['code'],
    message: string,
    public detail?: unknown,
  ) {
    super(message)
    this.name = 'GstnError'
  }
}
