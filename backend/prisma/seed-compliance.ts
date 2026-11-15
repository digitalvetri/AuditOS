/**
 * Compliance calendar catalogue (docs/compliance/README.md).
 *
 * Statutory dates as of October 2026: Income-tax Act 1961 as amended by the
 * Finance Act 2026 for FY 2025-26 (tax years from 2026-27 fall under the
 * Income-tax Act 2025 — same calendar dates). Re-check each year; record a
 * one-off CBDT/CBIC/MCA extension as a DueDateExtension, a permanent change
 * as an edit here.
 *
 * Idempotent: upsert on `code`. An existing row keeps any rule a firm has
 * edited through PATCH /api/compliance/forms/:code — only name/authority/
 * frequency/entity types/sort order are refreshed on re-seed.
 */
import type { PrismaClient } from '@prisma/client'

export interface CatalogueForm {
  code: string
  name: string
  authority: 'income_tax' | 'gst' | 'mca' | 'labour' | 'other'
  frequency: 'monthly' | 'quarterly' | 'half_yearly' | 'annual' | 'event'
  entityTypes: string
  anchor: 'period_end' | 'fy_end' | 'fy_start' | 'agm' | 'event'
  offsetMonths: number
  dueDay: number | null
  offsetDays: number
  months: string | null
  lateFeeNote: string | null
  description: string | null
  /// COMPLIANCE CLOCK (POST-DELIVERY-CHANGES §A) — a form is a clock when
  /// `internalTargetDays` is set. Clocks are one-shot per client (not per
  /// FY); `generateItems` already skips `frequency='event'` naturally, so
  /// clock items are created explicitly via `POST /api/compliance/clocks`.
  internalTargetDays: number | null
  appliesWhen: string | null
  evidenceRequired: boolean
  leadUpDays: string | null
  computedExpr: string | null
  escalateTo: string | null
}

const f = (
  code: string, name: string, authority: CatalogueForm['authority'], frequency: CatalogueForm['frequency'],
  entityTypes: string, anchor: CatalogueForm['anchor'], offsetMonths: number, dueDay: number | null,
  extra: Partial<Pick<CatalogueForm, 'offsetDays' | 'months' | 'lateFeeNote' | 'description' | 'internalTargetDays' | 'appliesWhen' | 'evidenceRequired' | 'leadUpDays' | 'computedExpr' | 'escalateTo'>> = {},
): CatalogueForm => ({
  code, name, authority, frequency, entityTypes, anchor, offsetMonths, dueDay,
  offsetDays: extra.offsetDays ?? 0, months: extra.months ?? null,
  lateFeeNote: extra.lateFeeNote ?? null, description: extra.description ?? null,
  internalTargetDays: extra.internalTargetDays ?? null,
  appliesWhen: extra.appliesWhen ?? null,
  evidenceRequired: extra.evidenceRequired ?? false,
  leadUpDays: extra.leadUpDays ?? null,
  computedExpr: extra.computedExpr ?? null,
  escalateTo: extra.escalateTo ?? null,
})

export const COMPLIANCE_CATALOGUE: CatalogueForm[] = [
  f('ITR_NON_BUSINESS', 'ITR (no business income, not audited)', 'income_tax', 'annual', 'individual,huf', 'fy_end', 4, 31,
    { lateFeeNote: 's.234F fee and s.234A interest', description: 'Due 31 July after the FY.' }),
  f('ITR_NON_AUDIT_BUSINESS', 'ITR (business/profession, not audited)', 'income_tax', 'annual', 'individual,huf,firm,llp,aop', 'fy_end', 5, 31,
    { lateFeeNote: 's.234F fee and s.234A interest', description: 'Due 31 August after the FY (Finance Act 2026).' }),
  f('TAX_AUDIT_REPORT', 'Tax audit report (3CA/3CB + 3CD)', 'income_tax', 'annual', 'any', 'fy_end', 6, 30,
    { lateFeeNote: 's.271B penalty', description: 'Due 30 September after the FY.' }),
  f('ITR_AUDIT', 'ITR (company / audited)', 'income_tax', 'annual', 'company,firm,llp,individual,huf,trust', 'fy_end', 7, 31,
    { lateFeeNote: 's.234F fee and s.234A interest', description: 'Due 31 October after the FY.' }),
  f('FORM_3CEB', 'Transfer pricing report 3CEB', 'income_tax', 'annual', 'company,llp,firm', 'fy_end', 7, 31,
    { lateFeeNote: 's.271BA penalty', description: 'Due 31 October after the FY.' }),
  f('ITR_TP', 'ITR (transfer pricing cases)', 'income_tax', 'annual', 'company,llp,firm', 'fy_end', 8, 30,
    { lateFeeNote: 's.234F fee and s.234A interest', description: 'Due 30 November after the FY.' }),
  f('ADVANCE_TAX', 'Advance tax instalment (15/45/75/100%)', 'income_tax', 'monthly', 'any', 'period_end', 0, 15,
    { months: '6,9,12,3', lateFeeNote: 's.234B / s.234C interest', description: '15 June, 15 September, 15 December, 15 March.' }),
  f('SFT_61A', 'Statement of financial transactions', 'income_tax', 'annual', 'any', 'fy_end', 2, 31,
    { lateFeeNote: 's.271FA penalty', description: 'Due 31 May after the FY.' }),
  f('FORM_10B', 'Audit report of charitable trust', 'income_tax', 'annual', 'trust,society', 'fy_end', 6, 30,
    { description: 'Due 30 September after the FY.' }),
  f('GSTR9', 'GST annual return', 'gst', 'annual', 'any', 'fy_end', 9, 31,
    { lateFeeNote: '₹200/day, capped at 0.5% of turnover', description: 'Due 31 December after the FY.' }),
  f('GSTR9C', 'GST reconciliation statement', 'gst', 'annual', 'any', 'fy_end', 9, 31,
    { description: 'Due 31 December after the FY, with GSTR-9.' }),
  f('CMP08', 'Composition quarterly payment', 'gst', 'quarterly', 'any', 'period_end', 1, 18,
    { lateFeeNote: 'Interest 18% p.a.', description: '18th of the month after the quarter.' }),
  f('GSTR4', 'Composition annual return', 'gst', 'annual', 'any', 'fy_end', 1, 30,
    { description: 'Due 30 April after the FY.' }),
  f('PMT06', 'QRMP monthly tax payment', 'gst', 'monthly', 'any', 'period_end', 1, 25,
    { months: '4,5,7,8,10,11,1,2', lateFeeNote: 'Interest 18% p.a.', description: '25th of the next month, first two months of each quarter.' }),
  f('AGM', 'Hold AGM', 'mca', 'annual', 'company', 'fy_end', 6, 30,
    { description: 'By 30 September after the FY. Enter the AGM date on this item: AOC-4, MGT-7 and ADT-1 run from it.' }),
  f('AOC4', 'Financial statements to ROC', 'mca', 'annual', 'company', 'agm', 0, null,
    { offsetDays: 30, lateFeeNote: '₹100/day additional fee', description: '30 days from the AGM.' }),
  f('MGT7', 'Annual return (MGT-7 / 7A)', 'mca', 'annual', 'company', 'agm', 0, null,
    { offsetDays: 60, lateFeeNote: '₹100/day additional fee', description: '60 days from the AGM.' }),
  f('ADT1', 'Auditor appointment', 'mca', 'annual', 'company', 'agm', 0, null,
    { offsetDays: 15, lateFeeNote: '₹100/day additional fee', description: '15 days from the AGM.' }),
  f('DIR3_KYC', 'Director KYC', 'mca', 'annual', 'company', 'fy_start', 5, 30,
    { lateFeeNote: '₹5,000', description: '30 September every year.' }),
  f('DPT3', 'Return of deposits', 'mca', 'annual', 'company', 'fy_end', 3, 30,
    { lateFeeNote: '₹100/day additional fee', description: 'Due 30 June after the FY.' }),
  f('MSME1', 'MSME outstanding dues', 'mca', 'half_yearly', 'company', 'period_end', 1, 31,
    { months: '9,3', description: '31 October (Apr–Sep) and 30 April (Oct–Mar).' }),
  f('LLP11', 'LLP annual return', 'mca', 'annual', 'llp', 'fy_end', 2, 30,
    { lateFeeNote: '₹100/day additional fee', description: 'Due 30 May after the FY.' }),
  f('LLP8', 'LLP statement of account and solvency', 'mca', 'annual', 'llp', 'fy_end', 7, 30,
    { lateFeeNote: '₹100/day additional fee', description: 'Due 30 October after the FY.' }),
  f('PF_ECR', 'PF return and payment', 'labour', 'monthly', 'any', 'period_end', 1, 15,
    { lateFeeNote: 'Interest s.7Q and damages s.14B', description: '15th of the next month.' }),
  f('ESI', 'ESI contribution', 'labour', 'monthly', 'any', 'period_end', 1, 15,
    { lateFeeNote: 'Interest 12% p.a.', description: '15th of the next month.' }),
  f('PT_TN', 'Tamil Nadu professional tax', 'other', 'half_yearly', 'any', 'period_end', 0, 31,
    { months: '9,3', description: '30 September and 31 March.' }),

  // ── COMPLIANCE CLOCKS (POST-DELIVERY-CHANGES §A) ──────────────────────
  // One-shot, event-triggered. generateItems skips frequency='event'
  // (engine.ts periodsOf), so clock items live on their own path — created
  // via POST /api/compliance/clocks and updated via PATCH /items/:id.
  f('GST_RULE_10A', 'GST Rule 10A — furnish bank account after registration', 'gst', 'event', 'any', 'event', 0, null,
    {
      offsetDays: 30,
      description: 'Within 30 days of registration grant, OR before the first GSTR-1 / IFF filing, whichever is earlier. ' +
        'Missing it triggers AUTOMATIC suspension of the GSTIN. Recovery: non-core amendment adding bank details.',
      lateFeeNote: 'No direct fee — the cost is automatic registration suspension and the recovery amendment.',
      // Firm wants the client to open a current account and furnish within 15 days
      // (they need the REG-06 certificate to open the account, which itself takes a week).
      // Statutory backstop stays at 30 days (offsetDays).
      internalTargetDays: 15,
      // Exemption test. GstProfile.registrationType today covers regular/composition/
      // casual/isd/sez/non_resident. 'non_resident' maps to NRTP and is exempt;
      // casual/isd/sez aren't exempt under Rule 10A. TDS/TCS/suo-moto/OIDAR aren't
      // in the enum yet — flagged in the JSON so a future type addition slots in.
      appliesWhen: JSON.stringify({
        authority: 'gst',
        registration_type_not_in: ['non_resident', 'tds', 'tcs', 'suo_moto', 'oidar'],
        note: 'OIDAR with an Indian representative IS covered — out of scope until the registration_type enum carries that distinction.',
      }),
      // Evidence = the portal amendment acknowledgement. 'Marked done' with
      // nothing behind it is how a suspension arrives six months later.
      evidenceRequired: true,
      // Lead-ups count down from the INTERNAL target, not the statutory.
      leadUpDays: JSON.stringify([10, 5, 2, 1]),
      // The deadline is MIN(reg_date + 30, first_gstr1_date). The second
      // anchor isn't wired yet — sub-PR (b.2) will update the anchor when
      // GstFiling for GSTR-1 lands before day 30.
      computedExpr: JSON.stringify({ kind: 'min_event', event: 'first_gstr1_filed' }),
      escalateTo: 'md',
    }),
  f('INC_20A', 'INC-20A — Declaration of Commencement of Business', 'mca', 'event', 'company', 'event', 0, null,
    {
      offsetDays: 180,
      description: 'Within 180 days of incorporation. Companies WITH SHARE CAPITAL incorporated on or after 2 Nov 2018. ' +
        'Until filed the company cannot commence business or borrow, and the Registrar may begin strike-off under s.10A(3).',
      // Penalty text for the dashboard. Late-fee tiers (2x / 4x / 6x / 10x / 12x of normal fee)
      // aren't computable without the normal fee per authorised capital band — the estimator
      // returns null, the note carries the detail.
      lateFeeNote: '₹50,000 on the company + ₹1,000/day on each officer in default (capped at ₹1,00,000/each). ' +
        'MCA additional fee: 2x ≤30d · 4x 31–60 · 6x 61–90 · 10x 91–180 · 12x >180.',
      // Firm target is day 30: the client cannot legally trade or borrow until filed,
      // so chasing it in week 25 is wrong even though it's technically on time.
      internalTargetDays: 30,
      // Applies to companies with share capital incorporated on or after 2 Nov 2018.
      // LLPs, companies limited by guarantee without share capital, and pre-2018
      // companies are excluded.
      appliesWhen: JSON.stringify({
        authority: 'mca',
        entity_type: 'company',
        has_share_capital: true,
        incorporated_on_or_after: '2018-11-02',
      }),
      // Evidence = the INC-20A SRN as filed on MCA.
      evidenceRequired: true,
      // Earlier and more frequent escalation than Rule 10A — INC-20A has no
      // extension, and penalties accrue per-director per-day.
      leadUpDays: JSON.stringify([30, 15, 7, 2, 1]),
      escalateTo: 'md',
    }),
]

/**
 * One-time migration: INC_20A rows from `PostRegistrationCompliance` (the
 * partnership module's per-case tracker) into `ComplianceItem` under the
 * unified clock engine. Fully idempotent — the `@@unique([clientId,
 * formCode, periodKey])` on ComplianceItem means a re-run is a no-op.
 *
 * `PostRegistrationCompliance` stays untouched for now: the partnership
 * workflow still reads and writes it. A follow-up switches those reads to
 * ComplianceItem and freezes the old table. Until then, Admin should treat
 * the unified entry as the long-term record; Partnership's view keeps
 * working on its own data.
 *
 * Only INC_20A is migrated; ADTC and LLP_FORM_3_INITIAL stay on the
 * partnership path (not scoped in POST-DELIVERY-CHANGES §A).
 */
export async function migrateInc20aFromPartnership(prisma: PrismaClient): Promise<{ migrated: number; skipped: number }> {
  const result = { migrated: 0, skipped: 0 }
  const form = await prisma.complianceForm.findUnique({ where: { code: 'INC_20A' } })
  if (!form) return result // the seed hasn't run yet; next invocation will catch up
  const rows = await prisma.postRegistrationCompliance.findMany({
    where: { code: 'INC_20A' },
    select: {
      clientId: true, triggerDate: true, dueDate: true, completedOn: true,
      completedBy: true, assignedEmployeeId: true, notes: true,
    },
  })
  if (!rows.length) return result
  // Join to the client to pick up organisationId — PartnershipCase itself
  // doesn't carry it (it's derived through the client).
  const clientOrg = new Map(
    (await prisma.client.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.clientId))] } },
      select: { id: true, organisationId: true },
    })).map((c) => [c.id, c.organisationId]),
  )
  for (const r of rows) {
    const organisationId = clientOrg.get(r.clientId)
    if (!organisationId) { result.skipped += 1; continue }
    const anchor = r.triggerDate ?? null
    // periodKey mirrors the POST /clocks convention: '<anchorYear>-<formCode>'
    // and falls back to the dueDate year, else the completedOn year — one of
    // these is always set on a real PostRegistrationCompliance row.
    const yearSource = anchor ?? r.dueDate ?? r.completedOn
    if (!yearSource) { result.skipped += 1; continue }
    const periodKey = `${yearSource.slice(0, 4)}-INC_20A`
    const status: string = r.completedOn ? 'filed' : 'not_started'
    const internal = anchor && form.internalTargetDays != null
      ? daysAdd(anchor, form.internalTargetDays)
      : null
    const due = anchor ? daysAdd(anchor, form.offsetDays) : (r.dueDate ?? daysAdd(yearSource, form.offsetDays))
    await prisma.complianceItem.upsert({
      where: { clientId_formCode_periodKey: { clientId: r.clientId, formCode: 'INC_20A', periodKey } },
      create: {
        organisationId,
        clientId: r.clientId,
        formCode: 'INC_20A',
        periodKey,
        periodLabel: form.name,
        dueDate: due,
        anchorDate: anchor,
        internalDueDate: internal,
        status,
        filedOn: r.completedOn,
        filedBy: r.completedBy,
        assignedEmployeeId: r.assignedEmployeeId,
        notes: r.notes,
      },
      update: {}, // leave existing rows alone — this is a one-way, one-time copy
    })
    result.migrated += 1
  }
  return result
}

/** Pure-string YYYY-MM-DD + N days. */
function daysAdd(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  t.setUTCDate(t.getUTCDate() + days)
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

export async function seedCompliance(prisma: PrismaClient): Promise<{ forms: number }> {
  let i = 0
  for (const form of COMPLIANCE_CATALOGUE) {
    i += 1
    await prisma.complianceForm.upsert({
      where: { code: form.code },
      create: { ...form, sortOrder: i * 10 },
      update: {
        name: form.name, authority: form.authority, frequency: form.frequency, entityTypes: form.entityTypes, sortOrder: i * 10,
        // Clock settings (POST-DELIVERY-CHANGES §A) are system-set, not firm
        // policy — refresh them on re-seed so a mistaken earlier value
        // (e.g. 'partner' instead of 'md' for escalateTo) is corrected.
        internalTargetDays: form.internalTargetDays,
        appliesWhen: form.appliesWhen,
        evidenceRequired: form.evidenceRequired,
        leadUpDays: form.leadUpDays,
        computedExpr: form.computedExpr,
        escalateTo: form.escalateTo,
      },
    })
  }
  return { forms: COMPLIANCE_CATALOGUE.length }
}
