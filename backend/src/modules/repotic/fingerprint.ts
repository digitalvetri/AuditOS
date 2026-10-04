/**
 * Marketplace adapter fingerprinting — REPOTIC-MODULE.md §2.1.
 *
 * When a file lands, we match its header row against every active
 * adapter version for the given marketplace × report_kind, pick the
 * best match, and classify the outcome:
 *
 *   matched   — every expected header is present, order is close
 *   drifted   — expected set overlaps enough to call it the same
 *               format, but new columns appeared or an expected
 *               column is missing. UI flags loudly, parsing still runs
 *   no_match  — overlap is below threshold. The upload is refused and
 *               the operator is offered manual column mapping
 *
 * Scoring is lenient on reordering (marketplaces frequently shuffle
 * columns across releases) but strict on new unexpected columns, which
 * is the usual signal that a tax / discount / RTO field was added and
 * our totals would be wrong if we ignored it.
 */

export interface Fingerprint {
  /** Normalised, sorted list of distinct header strings. Order lost. */
  headers: string[]
  /** Original header strings in their original order — used to show
   *  what differs, not for matching. */
  original: string[]
}

export interface AdapterCandidate {
  id: string
  version: number
  detectJson: string
}

export type DetectStatus = 'matched' | 'drifted' | 'no_match'

export interface DetectResult {
  status: DetectStatus
  /** Best-matching adapter id when status is `matched` or `drifted`. */
  adapterId: string | null
  adapterVersion: number | null
  /** Headers present in the file but not expected by the adapter. */
  newColumns: string[]
  /** Headers expected by the adapter but missing from the file. */
  missingColumns: string[]
  /** Jaccard-like similarity 0..1 between file headers and adapter
   *  expected headers. The threshold cliffs are declared below. */
  similarity: number
}

const NORMALISE_RE = /[^a-z0-9]+/g
/** Normalise a header for comparison. "Invoice No." / "invoice_no" /
 *  "INVOICE NO" all collapse to "invoiceno". Removes punctuation,
 *  whitespace, case. */
export function normaliseHeader(h: string): string {
  return (h ?? '').toLowerCase().replace(NORMALISE_RE, '')
}

/** Build the fingerprint from a header row. Empty strings are dropped —
 *  Excel often emits trailing empty columns. */
export function fingerprintOf(headerRow: string[]): Fingerprint {
  const original = headerRow.map((h) => (h ?? '').trim()).filter((h) => h.length > 0)
  const headers = [...new Set(original.map(normaliseHeader))].filter((h) => h.length > 0).sort()
  return { headers, original }
}

/** Decode an adapter's detectJson into a normalised header set. */
function expectedHeadersOf(detectJson: string): Set<string> {
  try {
    const raw = JSON.parse(detectJson) as unknown
    if (!Array.isArray(raw)) return new Set()
    return new Set(raw.filter((s): s is string => typeof s === 'string').map(normaliseHeader).filter((s) => s.length > 0))
  } catch {
    return new Set()
  }
}

/**
 * Match the fingerprint against every candidate adapter and return the
 * single best outcome. The thresholds here are deliberately picked to
 * fit real marketplace behaviour:
 *
 *   similarity ≥ 0.90 AND no missing AND no new columns → matched
 *   similarity ≥ 0.75                                   → drifted
 *   anything else                                       → no_match
 *
 * Jaccard = |expected ∩ found| / |expected ∪ found|. New columns in
 * the file lower similarity (they add to the union), but on a wide
 * adapter — 20+ columns — a single new one still clears the 0.9 bar.
 * The spec is explicit here: "a sudden 'Tax Collected at Source' that
 * nobody mapped is a loud signal, not a quiet pass." So matched also
 * requires newColumns.length === 0 — any unmapped column demotes the
 * outcome to drifted, surfacing the drift panel in the UI.
 */
export function detect(fp: Fingerprint, candidates: AdapterCandidate[]): DetectResult {
  let best: DetectResult = {
    status: 'no_match',
    adapterId: null,
    adapterVersion: null,
    newColumns: fp.original,
    missingColumns: [],
    similarity: 0,
  }
  const fileSet = new Set(fp.headers)
  for (const c of candidates) {
    const expected = expectedHeadersOf(c.detectJson)
    if (expected.size === 0) continue
    const intersection = new Set([...expected].filter((h) => fileSet.has(h)))
    const union = new Set([...expected, ...fileSet])
    const similarity = intersection.size / union.size
    if (similarity <= best.similarity) continue
    const missingNormalised = [...expected].filter((h) => !fileSet.has(h))
    const newNormalised = [...fileSet].filter((h) => !expected.has(h))
    // Map back to original strings for display.
    const missingColumns = missingNormalised.slice()
    const newColumns = fp.original.filter((o) => newNormalised.includes(normaliseHeader(o)))
    const status: DetectStatus =
      similarity >= 0.9 && missingNormalised.length === 0 && newNormalised.length === 0 ? 'matched'
      : similarity >= 0.75 ? 'drifted'
      : 'no_match'
    best = {
      status,
      adapterId: status === 'no_match' ? null : c.id,
      adapterVersion: status === 'no_match' ? null : c.version,
      newColumns,
      missingColumns,
      similarity,
    }
  }
  return best
}
