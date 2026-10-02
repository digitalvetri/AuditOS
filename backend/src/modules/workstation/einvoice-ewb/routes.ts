/**
 * E-Invoice & E-Way Bill routes (§ E-INVOICE-EWAYBILL.md).
 *
 * The firm does NOT generate IRNs or e-way bills — the client does that
 * inside its own ERP. These endpoints deliver the MONITORING view: the
 * four flagged alerts, the reconciliation cursor, the setup snapshot, and
 * the applicability derivation. Mutations here are limited to:
 *  - updating the per-client profile (setup + AATO history)
 *  - capturing outcomes of a client-side handoff (IRN or EWB row)
 *  - triggering the monthly pull manually (nightly job does the same)
 *
 * Every threshold and duration is resolved from StatutoryRate — no
 * literal thresholds appear in this file.
 */
import { Router } from 'express'
import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError, handler, ok } from '../../../lib/http.js'
import { requireSession } from '../../../platform/auth.js'
import { writeAudit } from '../../../platform/audit.js'
import { writeActivity } from '../../../platform/workstation/activity.js'
import { assertCanSeeClient, requireWorkstation } from '../../../platform/workstation/scope.js'
import { body, FieldErrors } from '../validate.js'
import { loadEinvEwbRates } from './config.js'
import { deriveApplicability, parseAatoByYear } from './applicability.js'
import { buildAlerts, type AlertItemMissingIrn } from './alerts.js'
import { profileToApi, irnToApi, ewbAlertItemToApi, monitorsSummary, setupSummary } from './serialize.js'

export const einvoiceEwbRouter = Router()

/**
 * Which half of the module the caller wants.
 *
 * E-Invoice and E-Way Bill are two separate screens (two sidebar entries), and
 * each reads only its own monitors. `mode` lets a screen ask for its half
 * alone, which skips the IRN or e-way-bill query outright rather than
 * fetching rows the caller will discard.
 *
 * The omitted half is ABSENT from the response, never zero-filled: a
 * `reported_this_month: 0` produced by a query we deliberately skipped would
 * be indistinguishable from a real zero, and would eventually be read as one.
 * `both` stays the default so existing callers are unaffected.
 */
const MODES = ['einvoice', 'ewb', 'both'] as const
type EinvEwbMode = (typeof MODES)[number]

function parseMode(raw: unknown): EinvEwbMode {
  if (raw === undefined || raw === '') return 'both'
  if (typeof raw === 'string' && (MODES as readonly string[]).includes(raw)) return raw as EinvEwbMode
  throw ApiError.badRequest(`mode must be one of: ${MODES.join(', ')}.`, {
    mode: [`Unknown mode ${JSON.stringify(raw)}.`],
  })
}

/** IST today as an ISO date (YYYY-MM-DD). */
function istToday(): string {
  const ist = new Date(Date.now() + 5.5 * 3_600_000)
  return ist.toISOString().slice(0, 10)
}

/** Current FY string in Indian financial-year form: April→March. */
function currentFyString(today = istToday()): string {
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7))
  const start = m >= 4 ? y : y - 1
  const end = (start + 1) % 100
  return `${start}-${end.toString().padStart(2, '0')}`
}

/**
 * GET /api/clients/:id/einvoice-ewb?mode=einvoice|ewb|both
 *
 * One screen's state in one call:
 *  - profile (setup + AATO history)
 *  - applicability derivation with the actual thresholds used
 *  - the alert buckets for the requested half
 *  - the reference monitor counts (reported this month, cancelled, etc.)
 *  - the setup rows that belong to the requested half, plus MFA
 *  - pull runs of the matching kind
 *
 * `mode` defaults to `both`. Profile and applicability come back in every
 * mode: the setup handoffs need them, and they are one row either way.
 */
einvoiceEwbRouter.get('/:id/einvoice-ewb', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.eway.read', 'workstation.eway.generate')
  await assertCanSeeClient(session, scope, req.params.id)

  const mode = parseMode(req.query.mode)
  const wantEinvoice = mode !== 'ewb'
  const wantEwb = mode !== 'einvoice'

  const clientId = req.params.id
  const client = await prisma.client.findFirst({ where: { id: clientId, ...alive } })
  if (!client) throw ApiError.notFound('Client not found.')

  const today = istToday()
  const now = new Date()

  const [profileRow, irns, ewbs, pulls, gstFilings] = await Promise.all([
    prisma.eInvoiceEwbProfile.findFirst({ where: { clientId, ...alive } }),
    // Skipped entirely for the half that was not asked for.
    wantEinvoice
      ? prisma.eInvoiceIrn.findMany({ where: { clientId, ...alive }, orderBy: { documentDate: 'desc' } })
      : Promise.resolve([]),
    wantEwb
      ? prisma.ewayBill.findMany({ where: { clientId, ...alive }, orderBy: { generatedAt: 'desc' } })
      : Promise.resolve([]),
    prisma.eInvoiceEwbPullRun.findMany({
      // One kind per screen: the reconciliation table shows a single column.
      where: { clientId, ...(mode === 'both' ? {} : { kind: mode }) },
      orderBy: [{ periodMonth: 'desc' }, { runAt: 'desc' }],
      take: 24,
    }),
    // GST filings power the reconciliation summary ('reconciled to Aug 2026')
    prisma.gstFiling.findMany({
      where: { gstProfile: { clientId }, ...alive },
      orderBy: { period: 'desc' },
      take: 12,
    }),
  ])

  const rates = await loadEinvEwbRates(prisma, client.organisationId)
  const aato = parseAatoByYear(profileRow?.aatoByYearJson ?? '[]')
  const applicability = deriveApplicability(aato, rates, today)

  // The 'missing IRN' bucket is a reconciliation output. In this build we
  // don't have a full purchase-register recon yet — the demo seeds a small
  // set of unmatched documents so the alert row wires end-to-end. When the
  // real recon lands, this collapses to a single query.
  const missingIrns: AlertItemMissingIrn[] = []
  const alerts = buildAlerts({
    rates,
    applicability,
    irns: irns.map((r) => ({
      id: r.id,
      documentNo: r.documentNo,
      documentDate: r.documentDate,
      documentType: r.documentType,
      totalValuePaise: r.totalValuePaise,
      status: r.status,
      reportedAt: r.reportedAt,
    })),
    ewbs: ewbs.map((r) => ({
      id: r.id,
      ewbNo: r.ewbNo,
      originalEwbNo: r.originalEwbNo,
      originalGeneratedAt: r.originalGeneratedAt,
      documentNo: r.documentNo,
      documentDate: r.documentDate,
      generatedAt: r.generatedAt,
      expiresAt: r.expiresAt,
      status: r.status,
      valuePaise: r.valuePaise,
    })),
    missingIrnDocuments: missingIrns,
    now,
    today,
  })

  const monitors = monitorsSummary({ irns, ewbs, today, gstFilings, profile: profileRow })
  const setup = setupSummary(profileRow)

  ok(res, {
    // Echoed so a caller can assert it got the half it asked for rather than
    // inferring it from which keys happen to be present.
    mode,
    client: {
      id: client.id,
      client_code: client.clientCode,
      company_name: client.companyName,
      gstin: client.gstin,
      pan: client.pan,
    },
    current_fy: currentFyString(today),
    today,
    profile: profileToApi(profileRow, aato),
    applicability: {
      applicable: applicability.applicable,
      applicable_since_fy: applicability.applicableSinceFy,
      thirty_day_applies: applicability.thirtyDayApplies,
      direct_api_eligible: applicability.directApiEligible,
      thresholds: applicability.thresholds,
    },
    alerts: {
      ...(wantEinvoice ? {
        einvoice_30day_countdown: {
          ...alerts.einvoice_30day_countdown,
          items: alerts.einvoice_30day_countdown.items.map(irnToApi),
        },
        b2b_invoices_without_irn: alerts.b2b_invoices_without_irn,
      } : {}),
      ...(wantEwb ? {
        ewb_expiring_24h: {
          ...alerts.ewb_expiring_24h,
          items: alerts.ewb_expiring_24h.items.map(ewbAlertItemToApi),
        },
        ewb_approaching_360_cap: {
          ...alerts.ewb_approaching_360_cap,
          items: alerts.ewb_approaching_360_cap.items.map(ewbAlertItemToApi),
        },
      } : {}),
    },
    monitors: {
      ...(wantEinvoice ? { einvoice: monitors.einvoice } : {}),
      ...(wantEwb ? { ewb: monitors.ewb } : {}),
    },
    setup: {
      ...(wantEinvoice ? { irp_registration: setup.irp_registration } : {}),
      ...(wantEwb ? { ewb_api_access: setup.ewb_api_access } : {}),
      // MFA guards the portal login behind either obligation, so it belongs to
      // both screens.
      mfa: setup.mfa,
    },
    pulls: {
      items: pulls.map((p) => ({
        kind: p.kind,
        period_month: p.periodMonth,
        run_at: p.runAt.toISOString(),
        record_count: p.recordCount,
        source: p.source,
        status: p.status,
      })),
    },
    /* SIMULATED. Everything under this endpoint is derived from local data:
       we don't call the government IRP or EWB portals. The UI is required
       to show this notice — reconciliation numbers must not be presented as
       authoritative when they aren't. */
    connection: {
      status: 'simulated',
      is_simulated: true,
      notice: 'Simulated — Audit OS is not connected to the IRP or the e-way bill portal. Data shown is from our local store.',
    },
  })
}))

/**
 * PATCH /api/clients/:id/einvoice-ewb
 *
 * Update the setup / profile. Callable fields:
 *  - irp, irp_registered_on, einvoice_api_route
 *  - ewb_api_enabled, ewb_api_username, ewb_gsp, ewb_verified_at
 *  - mfa_active
 *  - aato_by_year (array of { fy, aato_paise })
 *  - reconciled_through ('YYYY-MM')
 */
einvoiceEwbRouter.patch('/:id/einvoice-ewb', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.eway.generate')
  await assertCanSeeClient(session, scope, req.params.id)

  const b = body(req)
  const v = new FieldErrors()
  const irp = b.irp !== undefined ? v.str('irp', b.irp, { required: false, max: 40 }) : undefined
  const irpRegisteredOn = b.irp_registered_on !== undefined ? v.date('irp_registered_on', b.irp_registered_on, false) : undefined
  const einvoiceApiRoute = b.einvoice_api_route !== undefined ? v.str('einvoice_api_route', b.einvoice_api_route, { required: false, max: 20 }) : undefined
  const ewbApiEnabled = b.ewb_api_enabled !== undefined ? Boolean(b.ewb_api_enabled) : undefined
  const ewbApiUsername = b.ewb_api_username !== undefined ? v.str('ewb_api_username', b.ewb_api_username, { required: false, max: 80 }) : undefined
  const ewbGsp = b.ewb_gsp !== undefined ? v.str('ewb_gsp', b.ewb_gsp, { required: false, max: 80 }) : undefined
  const ewbVerifiedAt = b.ewb_verified_at !== undefined ? v.date('ewb_verified_at', b.ewb_verified_at, false) : undefined
  const mfaActive = b.mfa_active !== undefined ? Boolean(b.mfa_active) : undefined
  const reconciledThrough = b.reconciled_through !== undefined ? v.str('reconciled_through', b.reconciled_through, { required: false, max: 7 }) : undefined
  v.throwIfAny()

  let aatoJson: string | undefined
  if (Array.isArray(b.aato_by_year)) {
    const clean = b.aato_by_year
      .filter((x): x is { fy: string; aato_paise: number | string } =>
        !!x && typeof x === 'object' && typeof (x as { fy: unknown }).fy === 'string')
      .map((x) => ({ fy: x.fy, aatoPaise: String(x.aato_paise ?? '0') }))
    aatoJson = JSON.stringify(clean)
  }

  const client = await prisma.client.findFirst({ where: { id: req.params.id, ...alive } })
  if (!client) throw ApiError.notFound('Client not found.')

  const existing = await prisma.eInvoiceEwbProfile.findFirst({ where: { clientId: req.params.id } })
  const data = {
    clientId: req.params.id,
    ...(irp !== undefined ? { irp } : {}),
    ...(irpRegisteredOn !== undefined ? { irpRegisteredOn } : {}),
    ...(einvoiceApiRoute !== undefined ? { einvoiceApiRoute: einvoiceApiRoute ?? 'none' } : {}),
    ...(ewbApiEnabled !== undefined ? { ewbApiEnabled } : {}),
    ...(ewbApiUsername !== undefined ? { ewbApiUsername } : {}),
    ...(ewbGsp !== undefined ? { ewbGsp } : {}),
    ...(ewbVerifiedAt !== undefined ? { ewbVerifiedAt } : {}),
    ...(mfaActive !== undefined ? { mfaActive } : {}),
    ...(reconciledThrough !== undefined ? { reconciledThrough } : {}),
    ...(aatoJson !== undefined ? { aatoByYearJson: aatoJson } : {}),
  }

  const row = existing
    ? await prisma.eInvoiceEwbProfile.update({ where: { id: existing.id }, data: { ...data, updatedBy: session.userId } })
    : await prisma.eInvoiceEwbProfile.create({ data: { ...data, createdBy: session.userId } })

  await writeActivity({
    session, subjectType: 'client', subjectId: req.params.id,
    action: 'einvoice_ewb.profile_updated',
    description: 'E-Invoice / E-Way Bill profile updated.',
    entityType: 'EInvoiceEwbProfile', entityId: row.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'einvoice_ewb.profile.update',
    entityType: 'EInvoiceEwbProfile', entityId: row.id, after: row, req,
  })

  const aato = parseAatoByYear(row.aatoByYearJson)
  ok(res, profileToApi(row, aato))
}))

/**
 * POST /api/clients/:id/einvoice-ewb/pull?kind=ewb|einvoice&month=YYYY-MM
 *
 * Manually record a pull run for a given month. In production the nightly
 * scheduler calls the equivalent handler with `source='scheduled'`. In this
 * build the record is a marker with a synthetic count — the point is that
 * the reconciliation store carries a row for a month the portal has since
 * dropped (portal retains only 6 months).
 */
einvoiceEwbRouter.post('/:id/einvoice-ewb/pull', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.eway.generate')
  await assertCanSeeClient(session, scope, req.params.id)

  const b = body(req)
  const v = new FieldErrors()
  const kindRaw = v.str('kind', b.kind, { max: 10 })
  const month = v.str('month', b.month, { max: 7 })
  v.throwIfAny()
  if (kindRaw !== 'ewb' && kindRaw !== 'einvoice') throw ApiError.badRequest('kind must be ewb or einvoice')
  if (!/^\d{4}-\d{2}$/.test(month!)) throw ApiError.badRequest('month must be YYYY-MM')

  const client = await prisma.client.findFirst({ where: { id: req.params.id, ...alive } })
  if (!client) throw ApiError.notFound('Client not found.')

  const run = await prisma.eInvoiceEwbPullRun.create({
    data: {
      clientId: req.params.id,
      kind: kindRaw!,
      periodMonth: month!,
      source: 'manual',
      status: 'ok',
      recordCount: 0,
      notes: 'Manual pull recorded from UI',
    },
  })

  await writeAudit({
    actorUserId: session.userId, action: 'einvoice_ewb.pull.manual',
    entityType: 'EInvoiceEwbPullRun', entityId: run.id, after: run, req,
  })

  ok(res, {
    kind: run.kind, period_month: run.periodMonth, run_at: run.runAt.toISOString(),
    record_count: run.recordCount, source: run.source, status: run.status,
  })
}))
