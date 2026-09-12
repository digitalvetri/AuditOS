/**
 * E-invoice applicability derivation (PAN-level, sticky, from any FY since
 * the config's applicability scan start).
 *
 * The rule that gets implemented wrong: applicability is checked at PAN
 * level, and it triggers if AATO exceeded the threshold in ANY financial
 * year from 2017-18 onwards (the scan-from FY is configurable). Once
 * applicable, it stays applicable even if turnover later falls, unless an
 * explicit exemption applies.
 *
 * The 30-day reporting rule has its own AATO threshold (higher) and its
 * own effective-from date, and is derived independently.
 */
import type { RateRow } from '../../../domain/payroll/statutory.js'
import { EINV_EWB_CODES, resolveBigPaise, resolveDate, resolveOrThrow } from './config.js'

export interface AatoEntry {
  /** 'YYYY-YY', e.g. '2022-23'. */
  fy: string
  aatoPaise: bigint
}

export interface EinvoiceApplicability {
  applicable: boolean
  /** The earliest FY the threshold was crossed, or null if never. */
  applicableSinceFy: string | null
  /** True when the current AATO also crosses the 30-day rule threshold. */
  thirtyDayApplies: boolean
  /** Same but for the direct-API threshold (₹100 Cr). */
  directApiEligible: boolean
  /** Verbatim threshold values used for the derivation — surfaced in the UI. */
  thresholds: {
    aatoPaise: string
    thirtyDayPaise: string
    directApiPaise: string
    scanFromFy: string
    thirtyDayEffectiveFrom: string
  }
}

function isFyString(s: string): boolean {
  return /^\d{4}-\d{2}$/.test(s)
}

/** '2022-23' < '2023-24' by string compare, which is what we want. */
export function fyGte(a: string, b: string): boolean { return a >= b }

/** Parse the aato_by_year JSON stored on EInvoiceEwbProfile. */
export function parseAatoByYear(json: string): AatoEntry[] {
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return [] }
  if (!Array.isArray(raw)) return []
  const out: AatoEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const fy = (item as { fy?: unknown }).fy
    const val = (item as { aatoPaise?: unknown }).aatoPaise
    if (typeof fy !== 'string' || !isFyString(fy)) continue
    try {
      const p = typeof val === 'bigint' ? val : BigInt(String(val ?? 0))
      out.push({ fy, aatoPaise: p })
    } catch {
      // Skip malformed entries rather than throw — a bad row shouldn't
      // silently flip applicability to false.
    }
  }
  return out.sort((a, b) => (a.fy < b.fy ? -1 : 1))
}

/**
 * Derive applicability from an AATO history plus config rows.
 *
 * `asOfDate` is the date to resolve config values against — usually today.
 * The current FY's AATO is looked up separately (for the 30-day rule) via
 * `currentFy`; if a client has not yet reported AATO for the current FY,
 * the last known year's AATO is used.
 */
export function deriveApplicability(
  aato: AatoEntry[],
  rates: RateRow[],
  asOfDate: string,
): EinvoiceApplicability {
  const aatoThreshold = resolveBigPaise(rates, EINV_EWB_CODES.einvAatoThresholdPaise, asOfDate)
  const thirtyDayThreshold = resolveBigPaise(rates, EINV_EWB_CODES.einv30dayAatoThresholdPaise, asOfDate)
  const directApiThreshold = resolveBigPaise(rates, EINV_EWB_CODES.einvDirectApiAatoThresholdPaise, asOfDate)
  const scanFromFy = resolveOrThrow(rates, EINV_EWB_CODES.einvApplicabilityScanFromFy, asOfDate)
  const thirtyDayEffectiveFrom = resolveDate(rates, EINV_EWB_CODES.einv30dayEffectiveFrom, asOfDate)

  let applicableSinceFy: string | null = null
  for (const entry of aato) {
    if (!fyGte(entry.fy, scanFromFy)) continue
    if (entry.aatoPaise >= aatoThreshold) { applicableSinceFy = entry.fy; break }
  }
  const applicable = applicableSinceFy !== null

  // Latest known AATO is what the 30-day / direct-API tests measure against.
  const latest = aato.length > 0 ? aato[aato.length - 1] : null
  const latestAato = latest ? latest.aatoPaise : BigInt(0)

  const thirtyDayApplies =
    applicable
    && asOfDate >= thirtyDayEffectiveFrom
    && latestAato >= thirtyDayThreshold

  const directApiEligible = applicable && latestAato >= directApiThreshold

  return {
    applicable,
    applicableSinceFy,
    thirtyDayApplies,
    directApiEligible,
    thresholds: {
      aatoPaise: aatoThreshold.toString(),
      thirtyDayPaise: thirtyDayThreshold.toString(),
      directApiPaise: directApiThreshold.toString(),
      scanFromFy,
      thirtyDayEffectiveFrom,
    },
  }
}
