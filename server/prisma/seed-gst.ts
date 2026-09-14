/**
 * GST reference-data seed — rate slabs and a starter HSN/SAC master.
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

  return {
    rateSlabs: await prisma.gstRateSlab.count(),
    hsnCodes: await prisma.hsnMaster.count(),
  }
}
