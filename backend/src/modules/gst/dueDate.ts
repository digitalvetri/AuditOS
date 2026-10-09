/**
 * Statutory due-date resolver — GST-CLIENT-DASHBOARD-TASKS §5.
 *
 * The ONLY due-date engine for GSTR-1 / 2B / 3B. (service.ts used to carry
 * a second, hard-coded table with different numbers; it is gone.)
 *
 *   1. Per-period CBIC override: `GstDueDateOverride` matching (kind,
 *      period) — filingFrequency-scoped if the override specifies one.
 *      This is how "GSTR-3B for Aug-2024 extended to 25-Sep" is captured.
 *   2. Effective statutory rule: newest `GstDueDateRule` for (kind,
 *      filingFrequency, stateGroup) whose `effectiveFrom` is <= period.
 *      Null effectiveFrom = "always in force until superseded".
 *
 * State groups (QRMP GSTR-3B): the quarterly 3B is due on the 22nd for
 * Category X states and the 24th for Category Y states — see
 * `STATE_GROUP_BY_CODE` for the source. A rule row with a non-null
 * `stateGroup` beats the all-states (null) row for clients in that group;
 * a client whose state can't be classified falls back to the null row.
 *
 * `createRuleResolver(prisma)` pre-loads every live rule AND override in
 * two queries (both tables are tiny), so `resolve()` is synchronous and
 * can be called per row from serializers.
 *
 * Fallback: if no rule row exists for a (kind, filingFrequency) combo
 * (e.g. the seed hasn't run on a fresh env), the pre-§5 constants are
 * returned. A missing seed shouldn't blank out due dates on the
 * dashboard.
 */
import type { PrismaClient } from '@prisma/client'

export type ReturnKind = 'GSTR1' | 'GSTR2B' | 'GSTR3B'
export type FilingFrequency = 'monthly' | 'quarterly'
export type StateGroup = 'X' | 'Y'

/** Pre-§5 baseline used when no rule matches. Safety net only. */
const FALLBACK_DUE_DAY: Record<ReturnKind, number> = {
  GSTR1: 11,
  GSTR2B: 16,
  GSTR3B: 20,
}

/** 'GSTR-1' (GstFiling.returnType) → 'GSTR1' (rule / case kind). */
export function kindOfReturnType(returnType: string): ReturnKind | null {
  const k = returnType.replace(/-/g, '').toUpperCase()
  return k === 'GSTR1' || k === 'GSTR2B' || k === 'GSTR3B' ? k : null
}

/**
 * QRMP GSTR-3B state groups, keyed by the GSTIN state code (first two
 * digits of the GSTIN).
 *
 * Source: Notification No. 82/2020 – Central Tax (10-Nov-2020), amending
 * Rule 61 of the CGST Rules, 2017 for quarterly (QRMP) filers from the
 * January 2021 tax period — 22nd of the month after the quarter for
 * Chhattisgarh, MP, Gujarat, Maharashtra, Karnataka, Goa, Kerala, TN,
 * Telangana, AP, Daman & Diu, Dadra & Nagar Haveli, Puducherry, A&N
 * Islands, Lakshadweep; 24th for HP, Punjab, Uttarakhand, Haryana,
 * Rajasthan, UP, Bihar, Sikkim, Arunachal, Nagaland, Manipur, Mizoram,
 * Tripura, Meghalaya, Assam, WB, Jharkhand, Odisha, J&K, Ladakh,
 * Chandigarh, Delhi. State lists as reproduced from the GSTN advisory at
 * https://www.taxheal.com/?p=88727 (cbic.gov.in could not be fetched when
 * this was written — re-check against the gazette text on any change).
 * 97 (Other Territory) and 99 (Centre Jurisdiction) are not listed → null.
 */
const STATE_GROUP_BY_CODE: Record<string, StateGroup> = {
  // Category X — 22nd
  '22': 'X', '23': 'X', '24': 'X', '25': 'X', '26': 'X', '27': 'X',
  '28': 'X', '29': 'X', '30': 'X', '31': 'X', '32': 'X', '33': 'X',
  '34': 'X', '35': 'X', '36': 'X', '37': 'X',
  // Category Y — 24th
  '01': 'Y', '02': 'Y', '03': 'Y', '04': 'Y', '05': 'Y', '06': 'Y',
  '07': 'Y', '08': 'Y', '09': 'Y', '10': 'Y', '11': 'Y', '12': 'Y',
  '13': 'Y', '14': 'Y', '15': 'Y', '16': 'Y', '17': 'Y', '18': 'Y',
  '19': 'Y', '20': 'Y', '21': 'Y', '38': 'Y',
}

/** Same groups by state / UT name, for profiles whose GSTIN is unusable. */
const STATE_GROUP_BY_NAME: Record<string, StateGroup> = {
  chhattisgarh: 'X', 'madhya pradesh': 'X', gujarat: 'X', maharashtra: 'X',
  karnataka: 'X', goa: 'X', kerala: 'X', 'tamil nadu': 'X', telangana: 'X',
  'andhra pradesh': 'X', 'daman and diu': 'X', 'dadra and nagar haveli': 'X',
  'dadra and nagar haveli and daman and diu': 'X', puducherry: 'X', pondicherry: 'X',
  'andaman and nicobar islands': 'X', lakshadweep: 'X',
  'himachal pradesh': 'Y', punjab: 'Y', uttarakhand: 'Y', haryana: 'Y',
  rajasthan: 'Y', 'uttar pradesh': 'Y', bihar: 'Y', sikkim: 'Y',
  'arunachal pradesh': 'Y', nagaland: 'Y', manipur: 'Y', mizoram: 'Y',
  tripura: 'Y', meghalaya: 'Y', assam: 'Y', 'west bengal': 'Y', jharkhand: 'Y',
  odisha: 'Y', orissa: 'Y', 'jammu and kashmir': 'Y', ladakh: 'Y',
  chandigarh: 'Y', delhi: 'Y', 'new delhi': 'Y',
}

/** CBIC state group from the GSTIN prefix, else the profile's state name. */
export function stateGroupOf(profile: { gstin?: string | null; state?: string | null }): StateGroup | null {
  const code = profile.gstin?.trim().slice(0, 2) ?? ''
  if (/^\d{2}$/.test(code) && STATE_GROUP_BY_CODE[code]) return STATE_GROUP_BY_CODE[code]
  const name = profile.state?.trim().toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ')
  return (name && STATE_GROUP_BY_NAME[name]) || null
}

/** Composition dealers file CMP-08 / GSTR-4, never GSTR-1 / 2B / 3B. */
export function isComposition(profile: { registrationType?: string | null }): boolean {
  return profile.registrationType === 'composition'
}

const QUARTER_END = [3, 6, 9, 12]

/**
 * Which returns a profile owes FOR `period`. Monthly filers owe all three
 * every month. QRMP filers owe GSTR-1 and GSTR-3B only for the quarter-end
 * month, but GSTR-2B is generated monthly for everyone, so it is owed (to
 * reconcile) every month. Composition dealers owe none of the three —
 * CMP-08 / GSTR-4 tracking is a later phase.
 */
export function kindsOwed(
  profile: { filingFrequency: string; registrationType?: string | null },
  period: string,
): ReturnKind[] {
  if (isComposition(profile)) return []
  if (profile.filingFrequency !== 'quarterly') return ['GSTR1', 'GSTR2B', 'GSTR3B']
  const mo = Number(period.slice(5, 7))
  return QUARTER_END.includes(mo) ? ['GSTR1', 'GSTR2B', 'GSTR3B'] : ['GSTR2B']
}

export interface RuleRow {
  kind: string
  filingFrequency: string
  stateGroup: string | null
  effectiveFrom: string | null
  dueDay: number
}

export interface OverrideRow {
  kind: string
  filingFrequency: string | null
  period: string
  dueDate: string
}

export interface RuleResolver {
  /** Synchronous lookup against the pre-loaded rules and overrides. */
  resolve(
    period: string,
    kind: ReturnKind,
    filingFrequency: FilingFrequency,
    stateGroup?: StateGroup | null,
  ): string | null
  /** Async wrapper kept for existing callers. */
  dueDateFor(
    period: string,
    kind: ReturnKind,
    filingFrequency: FilingFrequency,
    stateGroup?: StateGroup | null,
  ): Promise<string | null>
}

export async function createRuleResolver(prisma: PrismaClient): Promise<RuleResolver> {
  const [rules, overrides] = await Promise.all([
    prisma.gstDueDateRule.findMany({
      where: { deletedAt: null },
      select: { kind: true, filingFrequency: true, stateGroup: true, effectiveFrom: true, dueDay: true },
    }),
    prisma.gstDueDateOverride.findMany({
      where: { deletedAt: null },
      select: { kind: true, filingFrequency: true, period: true, dueDate: true },
    }),
  ])
  return resolverFrom(rules, overrides)
}

/** The pure lookup over pre-loaded rows. Exported for unit tests. */
export function resolverFrom(rules: RuleRow[], overrides: OverrideRow[]): RuleResolver {
  function findRule(kind: ReturnKind, filingFrequency: FilingFrequency, period: string, group: StateGroup | null): RuleRow | null {
    const candidates = rules.filter(
      (r) => r.kind === kind
        && r.filingFrequency === filingFrequency
        && (r.stateGroup === null || r.stateGroup === group)
        && (r.effectiveFrom === null || r.effectiveFrom <= period),
    )
    if (candidates.length === 0) return null
    // Newest effectiveFrom wins. Null (always-active) sorts before any
    // date string, so a later dated rule supersedes a null baseline. On a
    // tie, the state-specific row beats the all-states row.
    candidates.sort((a, b) => {
      const byDate = (b.effectiveFrom ?? '').localeCompare(a.effectiveFrom ?? '')
      if (byDate !== 0) return byDate
      return (b.stateGroup ? 1 : 0) - (a.stateGroup ? 1 : 0)
    })
    return candidates[0]
  }

  function resolve(
    period: string,
    kind: ReturnKind,
    filingFrequency: FilingFrequency,
    stateGroup: StateGroup | null = null,
  ): string | null {
    if (!/^\d{4}-\d{2}$/.test(period)) return null

    // 1. CBIC override wins. A frequency-specific row beats a generic one.
    const matches = overrides.filter((o) => o.kind === kind && o.period === period
      && (o.filingFrequency === filingFrequency || o.filingFrequency === null))
    const override = matches.find((o) => o.filingFrequency === filingFrequency) ?? matches[0]
    if (override?.dueDate) return override.dueDate

    // 2. Statutory rule for this (kind, filingFrequency, state group, era).
    const rule = findRule(kind, filingFrequency, period, stateGroup)
    return applyDay(period, rule?.dueDay ?? FALLBACK_DUE_DAY[kind])
  }

  return {
    resolve,
    async dueDateFor(period, kind, filingFrequency, stateGroup = null) {
      return resolve(period, kind, filingFrequency, stateGroup)
    },
  }
}

/**
 * Due date for one GstFiling-style return type ('GSTR-1' / 'GSTR-3B') of a
 * profile — the shape the compliance-period screens use. Null for a
 * composition dealer (nothing of this kind is owed) or an unknown type.
 */
export function dueForProfile(
  resolver: RuleResolver,
  profile: { gstin?: string | null; state?: string | null; registrationType?: string | null },
  period: string,
  returnType: string,
  periodType: string,
): string | null {
  if (isComposition(profile)) return null
  const kind = kindOfReturnType(returnType)
  if (!kind) return null
  const freq: FilingFrequency = periodType === 'quarterly' ? 'quarterly' : 'monthly'
  return resolver.resolve(period, kind, freq, stateGroupOf(profile))
}

/** `YYYY-MM` + day-of-next-month → `YYYY-MM-DD`. */
export function applyDay(period: string, day: number): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(period)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2]) // 1..12 — the return is FOR THIS period, due NEXT month.
  return new Date(Date.UTC(y, mo, day)).toISOString().slice(0, 10)
}
