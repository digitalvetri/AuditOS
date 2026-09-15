/**
 * Deterministic offline GSTN client for dev, seeds and tests.
 *
 * The ARN it mints looks like a real one — 15 characters, state(2) +
 * YY(2) + MM(2) + sequence(9) — because the frontend renders it in
 * lookalike widgets and a placeholder like "FAKE-ARN" would leak the
 * mock into screenshots.
 *
 * Determinism matters: the same (gstin, period, returnType) always
 * returns the same ARN, so a test can assert a specific value without
 * capturing a fresh one each run. The sequence portion is derived
 * from a stable hash rather than a counter.
 */
import crypto from 'node:crypto'
import type {
  GstnClient,
  GstnStatusResult,
  GstnSubmitInput,
  GstnSubmitResult,
} from './GstnClient.js'

const ARN_PREFIX_FOR_FAKES = ['AA', 'AB', 'AC'] as const

export class FakeGstnClient implements GstnClient {
  readonly mode = 'fake' as const

  async submitGstr1(input: GstnSubmitInput): Promise<GstnSubmitResult> {
    return this.submit(input)
  }

  async submitGstr3b(input: GstnSubmitInput): Promise<GstnSubmitResult> {
    return this.submit(input)
  }

  async getStatus(arn: string): Promise<GstnStatusResult> {
    // Any ARN whose leading two letters are in our fake-alphabet set
    // resolves to `filed`. Anything else (i.e. a real-portal ARN we
    // happen to have kept from a prior live run) reports `unknown` —
    // the fake client is not authoritative for real submissions.
    const prefix = arn.slice(0, 2).toUpperCase()
    const isOurArn = (ARN_PREFIX_FOR_FAKES as readonly string[]).includes(prefix)
    return {
      arn,
      status:  isOurArn ? 'filed' : 'unknown',
      filedAt: isOurArn ? new Date() : null,
      message: isOurArn ? null : 'ARN not minted by the fake client.',
    }
  }

  private async submit(input: GstnSubmitInput): Promise<GstnSubmitResult> {
    if (!input.gstin || input.gstin.length < 15) {
      // Mirror the shape of a real portal error rather than a bare throw.
      throw new Error(`Fake GSTN: invalid gstin '${input.gstin}'`)
    }
    if (!/^\d{4}-\d{2}$/.test(input.period)) {
      throw new Error(`Fake GSTN: invalid period '${input.period}' (expected YYYY-MM)`)
    }

    const arn = buildFakeArn(input)
    const submittedAt = new Date()
    const responseJson = JSON.stringify({
      arn,
      status: 'submitted',
      timestamp: submittedAt.toISOString(),
      mode: 'fake',
      note: 'This is a synthetic response from the offline dev/test client. Not a real GSTN acknowledgement.',
    })
    return { arn, submittedAt, responseJson }
  }
}

/**
 * ARN = 2 chars (fake-alphabet prefix, deterministic per taxpayer) +
 * 2 digits (YY from period) + 2 digits (MM from period) + 9 digits
 * (deterministic hash of {gstin, period, returnType}). No timestamp
 * mixed in, so a re-run within the same period is stable.
 */
export function buildFakeArn(input: GstnSubmitInput): string {
  const [year, month] = input.period.split('-')
  const yy = year.slice(-2)
  const mm = month
  const prefix = ARN_PREFIX_FOR_FAKES[
    parseInt(input.gstin.slice(0, 2), 10) % ARN_PREFIX_FOR_FAKES.length
  ]
  const hash = crypto
    .createHash('sha256')
    .update(`${input.gstin}|${input.period}|${input.returnType}`)
    .digest('hex')
  // Take the first 9 hex chars and convert to digits by taking mod 10.
  // Not for security — just a stable 9-digit tail that looks like a
  // sequence number without being one.
  const sequence = hash
    .slice(0, 9)
    .split('')
    .map((c) => (parseInt(c, 16) % 10).toString())
    .join('')
  return `${prefix}${yy}${mm}${sequence}`
}
