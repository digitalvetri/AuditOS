/**
 * GST reference-data seed — rate slabs, HSN starter, and statutory due-day
 * rules (GST-CLIENT-DASHBOARD-TASKS §5).
 *
 * The rate slabs are the five statutory bands (0/5/12/18/28). We seed
 * them with a single effectiveFrom of 2017-07-01 (the day GST came into
 * force). A Council change lands as a new row with a later date — never
 * as a mutation of an existing row, because past returns must reproduce
 * byte-for-byte.
 *
 * The HSN starter covers the 20-odd codes the demo firm actually uses:
 * professional services (SAC 9982*), plus a handful of goods rows that
 * exercise every rate slab, so a composed GSTR-1 in the demo has real
 * codes without needing the full 40k-row roster.
 *
 * Due-day rules encode the statutory calendar per (kind, filingFrequency):
 * monthly filers get GSTR-1=11, GSTR-3B=20; QRMP quarterly filers get
 * GSTR-1=13, GSTR-3B=22 (State Group X — the earlier of 22/24; Group Y is
 * a follow-up when the state-split flag lands on GstProfile). GSTR-2B is
 * the reconciliation deadline (day 16) for both, since 2B is monthly
 * regardless of the filer's own return frequency.
 *
 * Idempotent: upsert on the natural key of each table.
 */
import type { PrismaClient } from '@prisma/client'

const RATE_SLABS = [
  { percentageBp: 0,    label: '0%'  },
  { percentageBp: 500,  label: '5%'  },
  { percentageBp: 1200, label: '12%' },
  { percentageBp: 1800, label: '18%' },
  { percentageBp: 2800, label: '28%' },
]

// GST-era start date. Every slab has been in force since day one; when
// the Council rewrites a slab, add a new row rather than editing this.
const GST_EFFECTIVE_FROM = '2017-07-01'

const HSN_STARTER: Array<{
  code: string
  description: string
  kind: 'goods' | 'services'
  defaultRateBp: number | null
}> = [
  // Professional services — SAC 9982xx. These are what a CA firm bills.
  { code: '998211', description: 'Accounting and bookkeeping services',                  kind: 'services', defaultRateBp: 1800 },
  { code: '998212', description: 'Financial auditing services',                          kind: 'services', defaultRateBp: 1800 },
  { code: '998213', description: 'Tax consultancy and preparation services',             kind: 'services', defaultRateBp: 1800 },
  { code: '998214', description: 'Insolvency and receivership services',                 kind: 'services', defaultRateBp: 1800 },
  { code: '998222', description: 'Company secretarial services',                         kind: 'services', defaultRateBp: 1800 },
  { code: '998311', description: 'Management consulting services',                       kind: 'services', defaultRateBp: 1800 },
  { code: '998312', description: 'Business consulting services',                         kind: 'services', defaultRateBp: 1800 },
  { code: '998399', description: 'Other professional and technical services n.e.c.',     kind: 'services', defaultRateBp: 1800 },

  // IT and software services — often billed by the same firms.
  { code: '998313', description: 'IT consulting and support services',                   kind: 'services', defaultRateBp: 1800 },
  { code: '998314', description: 'IT design and development services',                   kind: 'services', defaultRateBp: 1800 },
  { code: '997331', description: 'Software licensing services (packaged software)',      kind: 'services', defaultRateBp: 1800 },

  // Common goods — one per slab so tests exercise all rates.
  { code: '1006',   description: 'Rice',                                                 kind: 'goods',    defaultRateBp: 0    },
  { code: '0402',   description: 'Milk powder',                                          kind: 'goods',    defaultRateBp: 500  },
  { code: '2202',   description: 'Aerated waters and beverages',                         kind: 'goods',    defaultRateBp: 2800 },
  { code: '3004',   description: 'Medicaments (patent and proprietary)',                 kind: 'goods',    defaultRateBp: 1200 },
  { code: '3926',   description: 'Articles of plastic n.e.c.',                           kind: 'goods',    defaultRateBp: 1800 },
  { code: '4820',   description: 'Registers, ledgers, notebooks, stationery',            kind: 'goods',    defaultRateBp: 1800 },
  { code: '4901',   description: 'Printed books',                                        kind: 'goods',    defaultRateBp: 0    },
  { code: '6109',   description: 'T-shirts and vests, knitted',                          kind: 'goods',    defaultRateBp: 500  },
  { code: '8471',   description: 'Automatic data-processing machines (computers)',       kind: 'goods',    defaultRateBp: 1800 },
  { code: '8517',   description: 'Telephones for cellular networks (mobile phones)',     kind: 'goods',    defaultRateBp: 1800 },
]

/**
 * Statutory due-day rules — the calendar in six rows. `stateGroup` is null
 * ("all states") for every row today; the GSTR-3B split for QRMP filers
 * (State Group X = day 22, Group Y = day 24) waits for the state-group
 * classifier on GstProfile to land, at which point a two-row upsert here
 * replaces the single quarterly GSTR-3B rule.
 */
const DUE_DAY_RULES: Array<{
  kind: 'GSTR1' | 'GSTR2B' | 'GSTR3B'
  filingFrequency: 'monthly' | 'quarterly'
  dueDay: number
  note: string
}> = [
  { kind: 'GSTR1',  filingFrequency: 'monthly',   dueDay: 11, note: 'CGST Rule 59 — 11th of month following the tax period.' },
  { kind: 'GSTR2B', filingFrequency: 'monthly',   dueDay: 16, note: 'Auto-drafted; reconciliation deadline held at 16th to leave time before 3B.' },
  { kind: 'GSTR3B', filingFrequency: 'monthly',   dueDay: 20, note: 'CGST Rule 61 — 20th of month following the tax period.' },
  { kind: 'GSTR1',  filingFrequency: 'quarterly', dueDay: 13, note: 'QRMP — 13th of month following the quarter end.' },
  { kind: 'GSTR2B', filingFrequency: 'quarterly', dueDay: 16, note: '2B is monthly regardless of the filer’s QRMP election.' },
  { kind: 'GSTR3B', filingFrequency: 'quarterly', dueDay: 22, note: 'QRMP State Group X — 22nd of month following the quarter end (Group Y = 24, pending state classifier).' },
]

const RULE_EFFECTIVE_FROM: string | null = null // null = the calendar in force today.

export async function seedGst(prisma: PrismaClient) {
  // Rate slabs — natural key is (percentageBp, effectiveFrom).
  for (const slab of RATE_SLABS) {
    await prisma.gstRateSlab.upsert({
      where: {
        percentageBp_effectiveFrom: {
          percentageBp: slab.percentageBp,
          effectiveFrom: GST_EFFECTIVE_FROM,
        },
      },
      create: { ...slab, effectiveFrom: GST_EFFECTIVE_FROM, isActive: true },
      update: { label: slab.label, isActive: true },
    })
  }

  // HSN master — upsert on `code`. Updating description keeps the seed
  // authoritative; an operator's `isActive: false` toggle is preserved
  // because we don't touch the flag on update.
  for (const hsn of HSN_STARTER) {
    await prisma.hsnMaster.upsert({
      where: { code: hsn.code },
      create: { ...hsn, isActive: true },
      update: { description: hsn.description, kind: hsn.kind, defaultRateBp: hsn.defaultRateBp },
    })
  }

  // Due-day rules — GST-CLIENT-DASHBOARD-TASKS §5. Natural key is
  // (kind, filingFrequency, stateGroup, effectiveFrom). Both stateGroup
  // and effectiveFrom are nullable ("all states", "always") and Prisma's
  // compound unique type-checks nullable columns as required, so we
  // reach for findFirst + conditional create/update rather than upsert.
  // A CBIC calendar change lands as a new row with a later effectiveFrom
  // — never as an update to an existing row.
  for (const r of DUE_DAY_RULES) {
    const existing = await prisma.gstDueDateRule.findFirst({
      where: {
        kind: r.kind,
        filingFrequency: r.filingFrequency,
        stateGroup: null,
        effectiveFrom: RULE_EFFECTIVE_FROM,
        deletedAt: null,
      },
    })
    if (existing) {
      if (existing.dueDay !== r.dueDay || existing.note !== r.note) {
        await prisma.gstDueDateRule.update({
          where: { id: existing.id },
          data: { dueDay: r.dueDay, note: r.note },
        })
      }
    } else {
      await prisma.gstDueDateRule.create({
        data: {
          kind: r.kind,
          filingFrequency: r.filingFrequency,
          stateGroup: null,
          effectiveFrom: RULE_EFFECTIVE_FROM,
          dueDay: r.dueDay,
          note: r.note,
        },
      })
    }
  }

  return {
    rateSlabs: await prisma.gstRateSlab.count(),
    hsnCodes: await prisma.hsnMaster.count(),
    dueDateRules: await prisma.gstDueDateRule.count({ where: { deletedAt: null } }),
  }
}
