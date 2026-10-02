/**
 * Statutory due-date resolver — GST-CLIENT-DASHBOARD-TASKS §5.
 *
 * `defaultDueDateFor(period, kind, filingFrequency)` was hardcoded in
 * routes.ts (monthly 11/16/20 only) and returned the wrong day for every
 * QRMP quarterly filer. This module replaces the constant with a lookup:
 *
 *   1. Per-period CBIC override: `GstDueDateOverride` matching (kind,
 *      period) — filingFrequency-scoped if the override specifies one.
 *      This is how "GSTR-3B for Aug-2024 extended to 25-Sep" is captured.
 *   2. Effective statutory rule: newest `GstDueDateRule` for (kind,
 *      filingFrequency, stateGroup) whose `effectiveFrom` is <= period.
 *      Null effectiveFrom = "always in force until superseded".
 *
 * Callers pass a `RuleResolver` created via `createRuleResolver(prisma)`,
 * which pre-loads every active rule in one query. A per-request cache
 * matters because /client-dashboard resolves 6 dates per client-row.
 * Overrides are looked up on demand — small table, one call per (kind,
 * period) pair. In practice a request touches ≤3 periods, so this is a
 * handful of round-trips at worst.
 *
 * Fallback: if no rule row exists for a (kind, filingFrequency) combo
 * (e.g. the seed hasn't run on a fresh env), the pre-§5 constants are
 * returned. A missing seed shouldn't blank out due dates on the
 * dashboard — it should surface as "same as before this PR", loud in
 * logs but soft in the UI.
 */
import type { PrismaClient } from '@prisma/client'

export type ReturnKind = 'GSTR1' | 'GSTR2B' | 'GSTR3B'
export type FilingFrequency = 'monthly' | 'quarterly'

/** Pre-§5 baseline used when no rule matches. Same numbers the old
 *  `RETURN_DUE_DAY` constant carried — monthly-only, no QRMP awareness.
 *  Used only as a safety net for the fallback path. */
const FALLBACK_DUE_DAY: Record<ReturnKind, number> = {
  GSTR1: 11,
  GSTR2B: 16,
  GSTR3B: 20,
}

interface RuleRow {
  kind: string
  filingFrequency: string
  stateGroup: string | null
  effectiveFrom: string | null
  dueDay: number
}

export interface RuleResolver {
  /** Compute the due date for one (period, kind, filingFrequency). Reads
   *  the override table when needed; falls back to the pre-loaded rule
   *  set, then to the hardcoded pre-§5 numbers. */
  dueDateFor(
    period: string,
    kind: ReturnKind,
    filingFrequency: FilingFrequency,
  ): Promise<string | null>
}

export async function createRuleResolver(prisma: PrismaClient): Promise<RuleResolver> {
  // One query, one round-trip. There are 6 rows today (2 frequencies × 3
  // kinds) and low double digits at worst, so pre-loading is cheap.
  const rules: RuleRow[] = await prisma.gstDueDateRule.findMany({
    where: { deletedAt: null, stateGroup: null }, // state-group split is future work
    select: { kind: true, filingFrequency: true, stateGroup: true, effectiveFrom: true, dueDay: true },
  })

  function findRule(kind: ReturnKind, filingFrequency: FilingFrequency, period: string): RuleRow | null {
    const candidates = rules.filter(
      (r) => r.kind === kind
        && r.filingFrequency === filingFrequency
        && (r.effectiveFrom === null || r.effectiveFrom <= period),
    )
    if (candidates.length === 0) return null
    // Newest effectiveFrom wins. Null (always-active) sorts before any
    // date string, so a later dated rule supersedes a null baseline.
    candidates.sort((a, b) => {
      const av = a.effectiveFrom ?? ''
      const bv = b.effectiveFrom ?? ''
      return bv.localeCompare(av)
    })
    return candidates[0]
  }

  return {
    async dueDateFor(period, kind, filingFrequency) {
      if (!/^\d{4}-\d{2}$/.test(period)) return null

      // 1. CBIC override wins. A row without a filingFrequency applies to both.
      const override = await prisma.gstDueDateOverride.findFirst({
        where: {
          deletedAt: null,
          kind,
          period,
          OR: [{ filingFrequency }, { filingFrequency: null }],
        },
        select: { dueDate: true },
      })
      if (override?.dueDate) return override.dueDate

      // 2. Statutory rule for this (kind, filingFrequency, era).
      const rule = findRule(kind, filingFrequency, period)
      const day = rule?.dueDay ?? FALLBACK_DUE_DAY[kind]
      return applyDay(period, day)
    },
  }
}

/** `YYYY-MM` + day-of-next-month → `YYYY-MM-DD`. Extracted so callers
 *  reading rules from another source can compose the same date shape. */
export function applyDay(period: string, day: number): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(period)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2]) // 1..12 — the return is FOR THIS period, due NEXT month.
  return new Date(Date.UTC(y, mo, day)).toISOString().slice(0, 10)
}
