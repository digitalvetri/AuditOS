/**
 * E-Invoice / E-Way Bill serialisers.
 *
 * Prisma-shape (camelCase) → HTTP-shape (snake_case, paise, ISO strings).
 * Lives beside the routes rather than in the core workstation serializer so
 * the addition doesn't push a large existing file over 1000 lines.
 */
import type { EInvoiceEwbProfile, EInvoiceIrn, EwayBill, GstFiling } from '@prisma/client'
import type { AatoEntry } from './applicability.js'
import type { AlertItemEwb, AlertItemIrn } from './alerts.js'

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null)

export function profileToApi(row: EInvoiceEwbProfile | null, aato: AatoEntry[]) {
  if (!row) {
    return {
      exists: false,
      irp: null,
      irp_registered_on: null,
      einvoice_api_route: 'none',
      ewb_api_enabled: false,
      ewb_api_username: null,
      ewb_gsp: null,
      ewb_verified_at: null,
      mfa_active: false,
      reconciled_through: null,
      aato_by_year: aato.map((e) => ({ fy: e.fy, aato_paise: e.aatoPaise.toString() })),
    }
  }
  return {
    exists: true,
    irp: row.irp,
    irp_registered_on: row.irpRegisteredOn,
    einvoice_api_route: row.einvoiceApiRoute,
    ewb_api_enabled: row.ewbApiEnabled,
    ewb_api_username: row.ewbApiUsername,
    ewb_gsp: row.ewbGsp,
    ewb_verified_at: row.ewbVerifiedAt,
    mfa_active: row.mfaActive,
    reconciled_through: row.reconciledThrough,
    aato_by_year: aato.map((e) => ({ fy: e.fy, aato_paise: e.aatoPaise.toString() })),
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  }
}

export function irnToApi(item: AlertItemIrn) {
  return {
    irn_id: item.irn_id,
    document_no: item.document_no,
    document_date: item.document_date,
    document_type: item.document_type,
    total_value_paise: item.total_value_paise,
    days_since_document: item.days_since_document,
    days_left: item.days_left,
  }
}

export function ewbAlertItemToApi(item: AlertItemEwb) {
  return {
    ewb_id: item.ewb_id,
    ewb_no: item.ewb_no,
    original_ewb_no: item.original_ewb_no,
    document_no: item.document_no,
    document_date: item.document_date,
    generated_at: item.generated_at,
    original_generated_at: item.original_generated_at,
    expires_at: item.expires_at,
    hours_to_expiry: item.hours_to_expiry,
    days_to_cap: item.days_to_cap,
    status: item.status,
    value_paise: item.value_paise,
  }
}

/** The reference monitor counts — 'reported this month', 'cancelled', etc. */
export function monitorsSummary(input: {
  irns: EInvoiceIrn[]
  ewbs: EwayBill[]
  today: string
  gstFilings: GstFiling[]
  profile: EInvoiceEwbProfile | null
}) {
  const { irns, ewbs, today, gstFilings, profile } = input
  const monthPrefix = today.slice(0, 7)

  const reportedThisMonth = irns.filter((r) => (r.reportedAt ? r.reportedAt.toISOString().slice(0, 7) === monthPrefix : false)).length
  const cancelledIrns = irns.filter((r) => r.status === 'cancelled').length
  const cancelledIrnsInWindow = irns.filter((r) => {
    if (r.status !== 'cancelled' || !r.cancelledAt || !r.reportedAt) return false
    const hours = (r.cancelledAt.getTime() - r.reportedAt.getTime()) / 3_600_000
    return hours >= 0 && hours <= 24
  }).length

  const ewbGeneratedThisMonth = ewbs.filter((r) => r.generatedAt.toISOString().slice(0, 7) === monthPrefix).length
  const ewbCancelled = ewbs.filter((r) => r.status === 'cancelled').length

  // Reconciliation cursor: prefer the profile's declared value; else use
  // the latest filed GSTR-1 period.
  const declaredCursor = profile?.reconciledThrough ?? null
  const latestGstr1 = gstFilings
    .filter((f) => f.returnType === 'GSTR-1' && f.status === 'filed')
    .sort((a, b) => (a.period < b.period ? 1 : -1))[0]?.period ?? null
  const reconciledCursor = declaredCursor ?? latestGstr1

  return {
    einvoice: {
      reported_this_month: reportedThisMonth,
      cancelled_total: cancelledIrns,
      cancelled_within_window: cancelledIrnsInWindow,
      reconciled_through: reconciledCursor,
    },
    ewb: {
      generated_this_month: ewbGeneratedThisMonth,
      cancelled_or_rejected: ewbCancelled,
      reconciled_through: reconciledCursor,
    },
  }
}

export function setupSummary(profile: EInvoiceEwbProfile | null) {
  return {
    irp_registration: {
      state: profile?.irp ? 'ready' : 'pending',
      label: profile?.irp ? `${profile.irp} · registered ${profile.irpRegisteredOn ?? '—'}` : 'Not registered',
    },
    ewb_api_access: {
      state: profile?.ewbApiEnabled ? 'ready' : 'pending',
      label: profile?.ewbApiEnabled
        ? `${profile.ewbGsp ? `${profile.ewbGsp} · ` : ''}credentials verified ${profile.ewbVerifiedAt ?? '—'}`
        : 'Not enabled — the client must add our GSP on the portal',
    },
    mfa: {
      state: profile?.mfaActive ? 'ready' : 'attention',
      label: profile?.mfaActive ? 'Active' : 'Not confirmed — MFA has been mandatory since 1 Apr 2025',
    },
  }
}
