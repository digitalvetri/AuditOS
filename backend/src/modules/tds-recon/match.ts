/**
 * 26AS ↔ books matching. Pure.
 *
 *  1. Key every entry by deductor TAN + section. A books line with no TAN
 *     borrows the TAN of the 26AS deductor with the same normalised name
 *     (flag tan_from_name).
 *  2. Within a key, pair a 26AS line with a books line whose TDS and amount
 *     both agree within the tolerance — same quarter first, then the
 *     nearest date → matched (schema: verified).
 *  3. Leftovers within the same key are paired by the closest TDS amount →
 *     difference (schema: variance), with the fields that differ.
 *  4. Anything still unpaired is in 26AS only / in books only.
 */
export interface MatchEntry {
  id: string
  tan: string
  name: string | null
  section: string
  date: string
  quarter: string
  amountPaid: bigint
  tds: bigint
  tdsDeposited?: bigint
  status?: string | null
}

export type MatchStatus = 'verified' | 'variance' | 'only_26as' | 'only_books'
/** Contract names for the schema's statuses. */
export const STATUS_LABEL: Record<MatchStatus, 'matched' | 'difference' | 'only_26as' | 'only_books'> = {
  verified: 'matched', variance: 'difference', only_26as: 'only_26as', only_books: 'only_books',
}

export interface MatchRow {
  matchStatus: MatchStatus
  a26Id: string | null
  booksId: string | null
  mismatchFields: string[]
  matchMethod: 'exact' | 'window' | 'section' | null
  deductorKey: string
  flags: string[]
}

const abs = (v: bigint) => (v < 0n ? -v : v)
export const normName = (s: string | null | undefined) => String(s ?? '').toLowerCase()
  .replace(/\b(m\/s|messrs|pvt|private|ltd|limited|llp|the|co|company|india)\b/g, '').replace(/[^a-z0-9]/g, '')

function dayNum(d: string): number {
  return d ? Date.parse(`${d}T00:00:00Z`) / 86_400_000 : 0
}

function rowFlags(a: MatchEntry | null): string[] {
  const f: string[] = []
  const s = a?.status?.toUpperCase()
  if (s && ['U', 'P', 'O', 'Z'].includes(s)) f.push(`status_${s.toLowerCase()}`)
  if (a && a.tdsDeposited !== undefined && a.tdsDeposited > 0n && a.tdsDeposited < a.tds) f.push('short_deposit')
  return f
}

export function matchTds(a26: MatchEntry[], books: MatchEntry[], tolerancePaise = 100n): MatchRow[] {
  const tanByName = new Map<string, string>()
  for (const a of a26) if (a.tan && a.name) tanByName.set(normName(a.name), a.tan)
  const bookKeyed = books.map((b) => {
    if (b.tan) return { b, tan: b.tan, fromName: false }
    const t = tanByName.get(normName(b.name))
    return { b, tan: t ?? '', fromName: Boolean(t) }
  })
  const out: MatchRow[] = []
  const groups = new Map<string, { a: MatchEntry[]; b: { b: MatchEntry; fromName: boolean }[] }>()
  const keyOf = (tan: string, name: string | null, section: string) => `${tan || `NAME:${normName(name)}`}|${section}`
  for (const a of a26) {
    const k = keyOf(a.tan, a.name, a.section)
    if (!groups.has(k)) groups.set(k, { a: [], b: [] })
    groups.get(k)!.a.push(a)
  }
  for (const { b, tan, fromName } of bookKeyed) {
    const k = keyOf(tan, b.name, b.section)
    if (!groups.has(k)) groups.set(k, { a: [], b: [] })
    groups.get(k)!.b.push({ b, fromName })
  }

  for (const [key, g] of groups) {
    const deductorKey = key.split('|')[0]
    const as = [...g.a].sort((x, y) => x.date.localeCompare(y.date))
    const left = new Set(g.b.map((x) => x.b.id))
    const bById = new Map(g.b.map((x) => [x.b.id, x]))
    const unpairedA: MatchEntry[] = []
    // 2. exact within tolerance
    for (const a of as) {
      const cands = g.b.filter((x) => left.has(x.b.id)
        && abs(x.b.tds - a.tds) <= tolerancePaise && abs(x.b.amountPaid - a.amountPaid) <= tolerancePaise)
      cands.sort((x, y) => Number(x.b.quarter !== a.quarter) - Number(y.b.quarter !== a.quarter)
        || Math.abs(dayNum(x.b.date) - dayNum(a.date)) - Math.abs(dayNum(y.b.date) - dayNum(a.date)))
      const hit = cands[0]
      if (!hit) { unpairedA.push(a); continue }
      left.delete(hit.b.id)
      const fields = hit.b.quarter && a.quarter && hit.b.quarter !== a.quarter ? ['quarter'] : []
      out.push({
        matchStatus: 'verified', a26Id: a.id, booksId: hit.b.id, mismatchFields: fields,
        matchMethod: fields.length ? 'window' : 'exact', deductorKey,
        flags: [...rowFlags(a), ...(hit.fromName ? ['tan_from_name'] : [])],
      })
    }
    // 3. same TAN + section, amounts differ
    for (const a of unpairedA) {
      const cands = g.b.filter((x) => left.has(x.b.id))
      if (!cands.length) {
        out.push({ matchStatus: 'only_26as', a26Id: a.id, booksId: null, mismatchFields: [], matchMethod: null, deductorKey, flags: rowFlags(a) })
        continue
      }
      cands.sort((x, y) => Number(abs(x.b.tds - a.tds) - abs(y.b.tds - a.tds)) || Number(x.b.quarter !== a.quarter) - Number(y.b.quarter !== a.quarter))
      const hit = cands[0]
      left.delete(hit.b.id)
      const fields: string[] = []
      if (abs(hit.b.tds - a.tds) > tolerancePaise) fields.push('tds_amount')
      if (abs(hit.b.amountPaid - a.amountPaid) > tolerancePaise) fields.push('amount_paid')
      if (hit.b.quarter && a.quarter && hit.b.quarter !== a.quarter) fields.push('quarter')
      out.push({
        matchStatus: 'variance', a26Id: a.id, booksId: hit.b.id, mismatchFields: fields, matchMethod: 'section', deductorKey,
        flags: [...rowFlags(a), ...(hit.fromName ? ['tan_from_name'] : [])],
      })
    }
    // 4. books leftovers
    for (const id of left) {
      out.push({ matchStatus: 'only_books', a26Id: null, booksId: id, mismatchFields: [], matchMethod: null, deductorKey, flags: bById.get(id)?.fromName ? ['tan_from_name'] : [] })
    }
  }
  return out
}
