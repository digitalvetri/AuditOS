/**
 * Alert engine — derives the four flagged rows that are the whole value of
 * the E-Invoice & E-Way Bill page:
 *
 *  a) e-invoice 30-day countdown (irreversible after day 30)
 *  b) e-way bill expiring within 24 hours
 *  c) e-way bill approaching the 360-day extension cap
 *  d) B2B invoices without an IRN (from reconciliation)
 *
 * Every threshold and day-count is resolved from StatutoryRate — no
 * literals in this file.
 */
import type { RateRow } from '../../../domain/payroll/statutory.js'
import { EINV_EWB_CODES, resolveInt } from './config.js'
import type { EinvoiceApplicability } from './applicability.js'

export interface AlertBucket<T> {
  code: string
  count: number
  items: T[]
  /** Applicable window/rule statement rendered in the UI. */
  windowLabel: string
  /** True when this alert is actionable — i.e., a remedy still exists. */
  actionable: boolean
  /** Copy hint for the row: 'attention' | 'problem' | 'awaiting' | 'ok'. */
  status: 'attention' | 'problem' | 'awaiting' | 'ok'
}

export interface AlertItemIrn {
  irn_id: string
  document_no: string
  document_date: string
  document_type: string
  total_value_paise: number
  days_since_document: number
  days_left: number
}

export interface AlertItemEwb {
  ewb_id: string
  ewb_no: string
  original_ewb_no: string
  document_no: string
  document_date: string
  generated_at: string
  original_generated_at: string
  expires_at: string | null
  hours_to_expiry: number | null
  days_to_cap: number | null
  status: string
  value_paise: number
}

export interface AlertItemMissingIrn {
  document_no: string
  document_date: string
  buyer_gstin: string | null
  total_value_paise: number
}

export interface AlertsPayload {
  einvoice_30day_countdown: AlertBucket<AlertItemIrn>
  ewb_expiring_24h: AlertBucket<AlertItemEwb>
  ewb_approaching_360_cap: AlertBucket<AlertItemEwb>
  b2b_invoices_without_irn: AlertBucket<AlertItemMissingIrn>
}

interface IrnRow {
  id: string
  documentNo: string
  documentDate: string
  documentType: string
  totalValuePaise: number
  status: string
  reportedAt: Date | null
}
interface EwbRow {
  id: string
  ewbNo: string
  originalEwbNo: string | null
  originalGeneratedAt: Date | null
  documentNo: string
  documentDate: string
  generatedAt: Date
  expiresAt: Date | null
  status: string
  valuePaise: number
}

/** ISO date (YYYY-MM-DD) → Date at 00:00 UTC (calendar-day comparisons only). */
function isoDateToUtc(iso: string): Date { return new Date(`${iso}T00:00:00Z`) }

/** Full days between two Dates (a - b), floored. */
function daysBetween(a: Date, b: Date): number {
  const ms = a.getTime() - b.getTime()
  return Math.floor(ms / 86_400_000)
}

/** Hours from `now` until `t` (positive = future, negative = past). */
function hoursUntil(t: Date, now: Date): number {
  return (t.getTime() - now.getTime()) / 3_600_000
}

export interface BuildAlertsInput {
  rates: RateRow[]
  applicability: EinvoiceApplicability
  irns: IrnRow[]
  ewbs: EwbRow[]
  missingIrnDocuments: AlertItemMissingIrn[]
  now: Date
  today: string // YYYY-MM-DD
}

export function buildAlerts(input: BuildAlertsInput): AlertsPayload {
  const { rates, applicability, irns, ewbs, missingIrnDocuments, now, today } = input

  const windowDays = resolveInt(rates, EINV_EWB_CODES.einv30dayWindowDays, today)
  const alertAtDay = resolveInt(rates, EINV_EWB_CODES.einv30dayAlertAtDay, today)
  const capDays = resolveInt(rates, EINV_EWB_CODES.ewbExtensionCapDays, today)
  const capAlertBefore = resolveInt(rates, EINV_EWB_CODES.ewbCapAlertBeforeDays, today)
  const expiryAlertHours = resolveInt(rates, EINV_EWB_CODES.ewbExpiryAlertHours, today)
  const extendPostHours = resolveInt(rates, EINV_EWB_CODES.ewbExtensionWindowHoursPost, today)
  const extendPreHours = resolveInt(rates, EINV_EWB_CODES.ewbExtensionWindowHoursPre, today)

  // (a) 30-day countdown — only runs if the 30-day rule applies to this client.
  const irnAlerts: AlertItemIrn[] = []
  if (applicability.thirtyDayApplies) {
    for (const irn of irns) {
      if (irn.status !== 'pending') continue
      const daysSinceDoc = daysBetween(isoDateToUtc(today), isoDateToUtc(irn.documentDate))
      const daysLeft = windowDays - daysSinceDoc
      if (daysSinceDoc >= alertAtDay) {
        irnAlerts.push({
          irn_id: irn.id,
          document_no: irn.documentNo,
          document_date: irn.documentDate,
          document_type: irn.documentType,
          total_value_paise: irn.totalValuePaise,
          days_since_document: daysSinceDoc,
          days_left: daysLeft,
        })
      }
    }
  }
  irnAlerts.sort((a, b) => a.days_left - b.days_left)

  // (b) EWB expiring within 24 hours (positive hours to expiry, up to 24).
  // (c) EWB approaching the 360-day extension cap.
  const expiryAlerts: AlertItemEwb[] = []
  const capAlerts: AlertItemEwb[] = []
  for (const ewb of ewbs) {
    if (ewb.status !== 'active' && ewb.status !== 'generated') continue
    const original = ewb.originalGeneratedAt ?? ewb.generatedAt
    const capDeadline = new Date(original.getTime() + capDays * 86_400_000)
    const daysToCap = Math.ceil((capDeadline.getTime() - now.getTime()) / 86_400_000)
    if (daysToCap <= capAlertBefore) {
      capAlerts.push({
        ewb_id: ewb.id,
        ewb_no: ewb.ewbNo,
        original_ewb_no: ewb.originalEwbNo ?? ewb.ewbNo,
        document_no: ewb.documentNo,
        document_date: ewb.documentDate,
        generated_at: ewb.generatedAt.toISOString(),
        original_generated_at: (ewb.originalGeneratedAt ?? ewb.generatedAt).toISOString(),
        expires_at: ewb.expiresAt ? ewb.expiresAt.toISOString() : null,
        hours_to_expiry: ewb.expiresAt ? hoursUntil(ewb.expiresAt, now) : null,
        days_to_cap: daysToCap,
        status: ewb.status,
        value_paise: ewb.valuePaise,
      })
    }
    if (ewb.expiresAt) {
      const hoursLeft = hoursUntil(ewb.expiresAt, now)
      if (hoursLeft <= expiryAlertHours && hoursLeft > -extendPostHours) {
        expiryAlerts.push({
          ewb_id: ewb.id,
          ewb_no: ewb.ewbNo,
          original_ewb_no: ewb.originalEwbNo ?? ewb.ewbNo,
          document_no: ewb.documentNo,
          document_date: ewb.documentDate,
          generated_at: ewb.generatedAt.toISOString(),
          original_generated_at: (ewb.originalGeneratedAt ?? ewb.generatedAt).toISOString(),
          expires_at: ewb.expiresAt.toISOString(),
          hours_to_expiry: hoursLeft,
          days_to_cap: daysToCap,
          status: ewb.status,
          value_paise: ewb.valuePaise,
        })
      }
    }
  }
  expiryAlerts.sort((a, b) => (a.hours_to_expiry ?? 0) - (b.hours_to_expiry ?? 0))
  capAlerts.sort((a, b) => (a.days_to_cap ?? 0) - (b.days_to_cap ?? 0))

  return {
    einvoice_30day_countdown: {
      code: 'einvoice.30day_countdown',
      count: irnAlerts.length,
      items: irnAlerts,
      windowLabel: `${windowDays}-day reporting window · alert from day ${alertAtDay}`,
      actionable: true,
      status: irnAlerts.length ? 'problem' : 'ok',
    },
    ewb_expiring_24h: {
      code: 'ewb.expiring_24h',
      count: expiryAlerts.length,
      items: expiryAlerts,
      windowLabel: `Extend up to ${extendPreHours} hours before / ${extendPostHours} hours after expiry`,
      actionable: true,
      status: expiryAlerts.length ? 'attention' : 'ok',
    },
    ewb_approaching_360_cap: {
      code: 'ewb.approaching_360_cap',
      count: capAlerts.length,
      items: capAlerts,
      windowLabel: `Extensions capped at ${capDays} days from original generation`,
      actionable: false, // past the cap, no remedy — see spec §2.3
      status: capAlerts.length ? 'attention' : 'ok',
    },
    b2b_invoices_without_irn: {
      code: 'einvoice.missing_irn',
      count: missingIrnDocuments.length,
      items: missingIrnDocuments,
      windowLabel: 'B2B invoices with no matching IRN in the reconciliation window',
      actionable: true,
      status: missingIrnDocuments.length ? 'problem' : 'ok',
    },
  }
}
