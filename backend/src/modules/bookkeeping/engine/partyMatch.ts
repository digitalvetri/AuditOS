/**
 * Fuzzy ledger-match guard (BOOKKEEPING-REBUILD §3.3).
 *
 * The auto-created party ledger is a convenience the operator wants and
 * a footgun they don't see: three rows for `Loopet`, `Loopet Pte Ltd`
 * and `loopet` and the ageing report has three parties instead of one.
 * A split debtor is invisible until the client asks why their
 * outstanding number is wrong. So before creating a new ledger, this
 * module normalises the incoming name and looks for a probable match
 * against every existing ledger; a match above the threshold is shown
 * to the operator to accept or override.
 *
 * The design deliberately keeps the two moving parts separate:
 *   normalizeParty(name)     — strip legal suffixes, uppercase, collapse spaces.
 *   similarity(a, b)         — Sørensen–Dice on bigrams of the normalised text.
 *
 * The threshold (0.85) is written where it is used, not here — Step 3
 * of the rebuild owns the "how sure" UX and might expose it later.
 */

const SUFFIX_TOKENS = [
  'private limited',
  'pvt ltd',
  'private ltd',
  'pvt limited',
  'pte ltd',
  'pte limited',
  'p ltd',
  'llp',
  'limited',
  'limited liability partnership',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  '& co',
  'and co',
  'and company',
] as const

/**
 * Reduce a party name to a comparable form. All lowercase, punctuation
 * stripped, common legal suffixes removed. `Loopet Pte. Ltd.` and
 * `loopet` end up equal, which is the whole point. Digits are kept —
 * "Client 12" and "Client 21" must NOT normalise to the same string.
 */
export function normalizeParty(input: string): string {
  let s = (input ?? '').toLowerCase()
  // Punctuation → space. Keep the ampersand for now so "& co" survives
  // for the suffix strip; we drop it afterwards.
  s = s.replace(/[.,'"‘’“”/\\()[\]{}:;!?*_\-–—]+/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  // Legal suffixes at the end of the string. Longest tokens first so
  // "private limited" isn't half-stripped to "private".
  const suffixes = [...SUFFIX_TOKENS].sort((a, b) => b.length - a.length)
  let stripped = true
  while (stripped) {
    stripped = false
    for (const sfx of suffixes) {
      // Match either "…<space>sfx" at end, or exactly "sfx".
      const re = new RegExp(`(^|\\s)${escapeRegex(sfx)}\\s*$`)
      if (re.test(s)) {
        s = s.replace(re, '').trim()
        stripped = true
        break
      }
    }
  }
  // Ampersand is legitimate inside a name (e.g. "Smith & Jones") once
  // suffixes are gone. Replace with a space so bigrams are stable.
  s = s.replace(/&/g, ' ').replace(/\s+/g, ' ').trim()
  return s
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Sørensen–Dice coefficient over bigrams — 0.0 (no overlap) to 1.0
 * (identical). Cheap, order-insensitive at the token level, and forgiving
 * of small typos. Chosen over Levenshtein because it handles rearranged
 * words ("Loopet Pte" vs "Pte Loopet") without a length penalty.
 *
 * Both inputs are normalised inside this function so callers cannot forget.
 */
export function similarity(a: string, b: string): number {
  const na = normalizeParty(a)
  const nb = normalizeParty(b)
  if (!na && !nb) return 1
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0

  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const A = bigrams(na)
  const B = bigrams(nb)
  let intersection = 0
  for (const [g, ca] of A) {
    const cb = B.get(g)
    if (cb) intersection += Math.min(ca, cb)
  }
  const sizeA = na.length - 1
  const sizeB = nb.length - 1
  return (2 * intersection) / (sizeA + sizeB)
}

export interface MatchCandidate {
  ledgerId: string
  name: string
}

export interface FuzzyMatch {
  ledgerId: string
  name: string
  score: number
}

/**
 * For a party name found in the import, return the strongest matches
 * from the existing ledger list. An exact-normalised match is always
 * returned first with score 1; other candidates above `threshold` are
 * sorted by score. `topK` caps the list so the UI stays readable.
 */
export function findFuzzyMatches(
  name: string,
  candidates: MatchCandidate[],
  { threshold = 0.85, topK = 3 }: { threshold?: number; topK?: number } = {},
): FuzzyMatch[] {
  const target = normalizeParty(name)
  if (!target) return []
  const scored: FuzzyMatch[] = []
  for (const c of candidates) {
    const s = similarity(name, c.name)
    if (s >= threshold) {
      scored.push({ ledgerId: c.ledgerId, name: c.name, score: s })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK)
}
