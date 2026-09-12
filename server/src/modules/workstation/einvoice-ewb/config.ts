/**
 * E-Invoice + E-Way Bill configuration.
 *
 * Every number the spec mentions — turnover thresholds, day counts, hour
 * windows, kilometres, rupee alert thresholds — is a StatutoryRate row keyed
 * by one of the codes below. The acceptance test is a grep for literals in
 * this module; anything numeric that a caller cares about must resolve
 * through resolveOrThrow().
 */
import type { PrismaClient } from '@prisma/client'
import { resolveRate, type RateRow } from '../../../domain/payroll/statutory.js'

/** Config codes used by the E-Invoice / E-Way Bill engine. */
export const EINV_EWB_CODES = {
  // ── E-invoice thresholds ────────────────────────────────────────────────
  /** AATO above which e-invoicing is applicable (paise, PAN-level, any FY). */
  einvAatoThresholdPaise: 'einv.aato_threshold_paise',
  /** AATO above which the 30-day reporting rule applies (paise). */
  einv30dayAatoThresholdPaise: 'einv.30day.aato_threshold_paise',
  /** AATO above which NIC IRP offers direct API registration (paise). */
  einvDirectApiAatoThresholdPaise: 'einv.direct_api.aato_threshold_paise',
  /** Hours after IRN generation within which cancellation is possible. */
  einvCancellationWindowHours: 'einv.cancellation_window_hours',
  /** Reporting window from document date (days). */
  einv30dayWindowDays: 'einv.30day_window_days',
  /** Days into the window at which the countdown starts alerting. */
  einv30dayAlertAtDay: 'einv.30day_alert_at_day',
  /** Earliest FY string used when scanning aato history (e.g. '2017-18'). */
  einvApplicabilityScanFromFy: 'einv.applicability_scan_from_fy',
  /** Effective date the 30-day rule kicked in (YYYY-MM-DD). */
  einv30dayEffectiveFrom: 'einv.30day.effective_from',
  /** Effective date e-invoicing above the current threshold applies. */
  einvThresholdEffectiveFrom: 'einv.aato.effective_from',

  // ── E-way bill thresholds / durations ───────────────────────────────────
  /** Max age of the base document at generation (days). */
  ewbDocMaxAgeDays: 'ewb.doc_max_age_days',
  /** Cap on total days from original generation an EWB may be extended. */
  ewbExtensionCapDays: 'ewb.extension_cap_days',
  /** Hours before expiry an extension is permitted. */
  ewbExtensionWindowHoursPre: 'ewb.extension_window_hours_pre',
  /** Hours after expiry an extension is permitted. */
  ewbExtensionWindowHoursPost: 'ewb.extension_window_hours_post',
  /** Validity per km (km/day). */
  ewbValidityKmPerDay: 'ewb.validity_km_per_day',
  /** Value above which the portal SMS-alerts the generator (paise). */
  ewbHighValueAlertPaise: 'ewb.high_value_alert_paise',
  /** MFA effective-from — universal (YYYY-MM-DD). */
  ewbMfaEffectiveFromAll: 'ewb.mfa.effective_from_all',
  /** Alert threshold: days until the 360-day cap to raise a warning. */
  ewbCapAlertBeforeDays: 'ewb.cap_alert_before_days',
  /** Alert window: hours until expiry to include an EWB in the 24h alert. */
  ewbExpiryAlertHours: 'ewb.expiry_alert_hours',
  /** Effective date of the 180-day and 360-day rules. */
  ewbRulesEffectiveFrom: 'ewb.rules.effective_from',
} as const

export type EinvEwbCode = typeof EINV_EWB_CODES[keyof typeof EINV_EWB_CODES]

/** Load the E-Invoice / E-Way Bill rate rows for an organisation. */
export async function loadEinvEwbRates(prisma: PrismaClient, organisationId: string): Promise<RateRow[]> {
  const rows = await prisma.statutoryRate.findMany({
    where: {
      organisationId,
      deletedAt: null,
      OR: [
        { code: { startsWith: 'einv.' } },
        { code: { startsWith: 'ewb.' } },
      ],
    },
    select: { code: true, value: true, effectiveFrom: true, effectiveTo: true },
  })
  return rows.map((r) => ({ code: r.code, value: r.value, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo }))
}

/** Resolve a config value as of a given date. Throws if unset — no fallback. */
export function resolveOrThrow(rates: RateRow[], code: EinvEwbCode, onDate: string): string {
  const row = resolveRate(code, onDate, rates)
  if (!row) throw new Error(`Missing StatutoryRate '${code}' effective ${onDate}. Seed the config row first.`)
  return row.value
}

/** Resolve as an integer. Throws if unset or non-numeric. */
export function resolveInt(rates: RateRow[], code: EinvEwbCode, onDate: string): number {
  const raw = resolveOrThrow(rates, code, onDate)
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`StatutoryRate '${code}' value '${raw}' is not numeric.`)
  return n
}

/** Resolve as a bigint (paise thresholds). */
export function resolveBigPaise(rates: RateRow[], code: EinvEwbCode, onDate: string): bigint {
  const raw = resolveOrThrow(rates, code, onDate)
  try { return BigInt(raw) } catch { throw new Error(`StatutoryRate '${code}' value '${raw}' is not a bigint.`) }
}

/** Resolve a date string (YYYY-MM-DD). */
export function resolveDate(rates: RateRow[], code: EinvEwbCode, onDate: string): string {
  return resolveOrThrow(rates, code, onDate)
}
