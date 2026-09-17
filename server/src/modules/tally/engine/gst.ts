import { prisma, alive } from '../../../lib/prisma.js'
import { ledgerBalances } from './balances.js'
import { parseTaxConfig } from './posting.js'
import { applyBp } from './primitives.js'

/**
 * GST — every figure here is derived from posted vouchers and from the
 * tax configuration on the ledgers/items involved. No rate is hardcoded:
 * a line's rate rides on the stock item (gstRateBp) or on the TallyTaxRate
 * master, and the tax amount itself comes off the posted tax ledgers.
 *
 * STATUS VOCABULARY (spec §11). A return produced here is PREPARED, and
 * may be VALIDATED and EXPORTED. It is never "filed": this module has no
 * GSTN integration, and says so rather than implying one.
 */
export type ReturnStatus = 'prepared' | 'validated' | 'exported'

export interface GstComponentTotals {
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  cessPaise: number
}

const ZERO: GstComponentTotals = { cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0 }

export interface GstSummary {
  from: string | null
  to: string | null
  /** Input tax credit accumulated in the period (debit balances). */
  input: GstComponentTotals & { totalPaise: number }
  /** Output tax charged in the period (credit balances). */
  output: GstComponentTotals & { totalPaise: number }
  /** Output − input, per component. Positive = payable, negative = credit. */
  net: GstComponentTotals & { totalPaise: number }
  ledgers: {
    ledgerId: string
    ledgerName: string
    component: string
    direction: string
    debitPaise: number
    creditPaise: number
    closingPaise: number
  }[]
  outwardTaxableValuePaise: number
  inwardTaxableValuePaise: number
}

/** Ledger-level GST position for a period — the heart of GST reporting. */
export async function gstSummary(companyId: string, filter: { from?: string | null; to?: string | null } = {}): Promise<GstSummary> {
  const [ledgerRows, balances] = await Promise.all([
    prisma.tallyLedger.findMany({
      where: { tallyCompanyId: companyId, ...alive, NOT: { taxConfigJson: null } },
      select: { id: true, name: true, taxConfigJson: true },
    }),
    ledgerBalances(companyId, filter),
  ])
  const balanceById = new Map(balances.map((b) => [b.ledgerId, b]))

  const input = { ...ZERO, totalPaise: 0 }
  const output = { ...ZERO, totalPaise: 0 }
  const ledgers: GstSummary['ledgers'] = []

  for (const l of ledgerRows) {
    const cfg = parseTaxConfig(l.taxConfigJson)
    if (!cfg.gst_component) continue
    const b = balanceById.get(l.id)
    if (!b) continue
    const direction = cfg.gst_direction ?? (b.debitPaise >= b.creditPaise ? 'input' : 'output')
    const amount = direction === 'input' ? b.debitPaise - b.creditPaise : b.creditPaise - b.debitPaise
    const bucket = direction === 'input' ? input : output
    const key = `${cfg.gst_component}Paise` as keyof GstComponentTotals
    bucket[key] += amount
    bucket.totalPaise += amount
    ledgers.push({
      ledgerId: l.id, ledgerName: l.name, component: cfg.gst_component, direction,
      debitPaise: b.debitPaise, creditPaise: b.creditPaise, closingPaise: b.closingPaise,
    })
  }

  const dateFilter = filter.from || filter.to
    ? { date: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
    : {}
  const [outward, inward] = await Promise.all([
    prisma.tallyVoucher.aggregate({
      where: { tallyCompanyId: companyId, status: 'active', ...alive, voucherTypeCode: { in: ['sales', 'credit_note'] }, ...dateFilter },
      _sum: { taxableValuePaise: true },
    }),
    prisma.tallyVoucher.aggregate({
      where: { tallyCompanyId: companyId, status: 'active', ...alive, voucherTypeCode: { in: ['purchase', 'debit_note'] }, ...dateFilter },
      _sum: { taxableValuePaise: true },
    }),
  ])

  return {
    from: filter.from ?? null,
    to: filter.to ?? null,
    input,
    output,
    net: {
      cgstPaise: output.cgstPaise - input.cgstPaise,
      sgstPaise: output.sgstPaise - input.sgstPaise,
      igstPaise: output.igstPaise - input.igstPaise,
      cessPaise: output.cessPaise - input.cessPaise,
      totalPaise: output.totalPaise - input.totalPaise,
    },
    ledgers: ledgers.sort((a, b) => a.direction.localeCompare(b.direction) || a.ledgerName.localeCompare(b.ledgerName)),
    outwardTaxableValuePaise: outward._sum.taxableValuePaise ?? 0,
    inwardTaxableValuePaise: inward._sum.taxableValuePaise ?? 0,
  }
}

export interface Gstr1Invoice {
  voucherId: string
  voucherNumber: string
  date: string
  partyName: string | null
  partyGstin: string | null
  placeOfSupply: string | null
  taxableValuePaise: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  cessPaise: number
  invoiceValuePaise: number
  voucherTypeCode: string
}

export interface HsnSummaryRow {
  hsnCode: string
  description: string
  uqc: string
  qtyMilli: number
  rateBp: number
  taxableValuePaise: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  cessPaise: number
}

export interface Gstr1 {
  status: ReturnStatus
  period: { from: string; to: string }
  b2b: Gstr1Invoice[]
  b2cl: Gstr1Invoice[]
  b2cs: Gstr1Invoice[]
  creditNotes: Gstr1Invoice[]
  hsn: HsnSummaryRow[]
  totals: { taxableValuePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number; invoiceCount: number }
  exceptions: { voucherId: string; voucherNumber: string; issue: string }[]
}

/** B2CL threshold: inter-state supply to an unregistered person above ₹2.5 lakh. */
const B2CL_THRESHOLD_PAISE = 250_000_00

/**
 * GSTR-1 working — outward supplies for a period, split the way the
 * return is split. Exceptions (missing GSTIN, missing place of supply)
 * are surfaced rather than silently defaulted.
 */
export async function gstr1(companyId: string, from: string, to: string): Promise<Gstr1> {
  const vouchers = await prisma.tallyVoucher.findMany({
    where: {
      tallyCompanyId: companyId, status: 'active', ...alive,
      voucherTypeCode: { in: ['sales', 'credit_note'] },
      date: { gte: from, lte: to },
    },
    select: {
      id: true, voucherNumber: true, date: true, placeOfSupply: true, voucherTypeCode: true,
      taxableValuePaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, cessPaise: true, grandTotalPaise: true,
      partyLedger: { select: { name: true, gstin: true, state: true } },
      items: { select: { hsnCode: true, gstRateBp: true, qtyMilli: true, amountPaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, cessPaise: true, stockItem: { select: { name: true, unit: { select: { name: true } } } } } },
    },
    orderBy: { date: 'asc' },
  })

  const map = (v: typeof vouchers[number]): Gstr1Invoice => ({
    voucherId: v.id,
    voucherNumber: v.voucherNumber,
    date: v.date,
    partyName: v.partyLedger?.name ?? null,
    partyGstin: v.partyLedger?.gstin ?? null,
    placeOfSupply: v.placeOfSupply ?? null,
    taxableValuePaise: v.taxableValuePaise,
    cgstPaise: v.cgstPaise,
    sgstPaise: v.sgstPaise,
    igstPaise: v.igstPaise,
    cessPaise: v.cessPaise,
    invoiceValuePaise: v.grandTotalPaise,
    voucherTypeCode: v.voucherTypeCode,
  })

  const b2b: Gstr1Invoice[] = []
  const b2cl: Gstr1Invoice[] = []
  const b2cs: Gstr1Invoice[] = []
  const creditNotes: Gstr1Invoice[] = []
  const exceptions: Gstr1['exceptions'] = []
  const hsnAcc = new Map<string, HsnSummaryRow>()

  for (const v of vouchers) {
    const row = map(v)
    if (v.voucherTypeCode === 'credit_note') creditNotes.push(row)
    else if (row.partyGstin) b2b.push(row)
    else if (row.invoiceValuePaise > B2CL_THRESHOLD_PAISE && row.igstPaise > 0) b2cl.push(row)
    else b2cs.push(row)

    if (!row.placeOfSupply) exceptions.push({ voucherId: v.id, voucherNumber: v.voucherNumber, issue: 'Place of supply is not set.' })
    if (!row.partyGstin && row.invoiceValuePaise > B2CL_THRESHOLD_PAISE) {
      exceptions.push({ voucherId: v.id, voucherNumber: v.voucherNumber, issue: 'Invoice above ₹2.5 lakh with no counter-party GSTIN.' })
    }
    if (row.taxableValuePaise > 0 && row.cgstPaise + row.sgstPaise + row.igstPaise === 0) {
      exceptions.push({ voucherId: v.id, voucherNumber: v.voucherNumber, issue: 'Taxable value with no tax posted — check the tax ledgers.' })
    }

    for (const it of v.items) {
      if (!it.hsnCode) {
        exceptions.push({ voucherId: v.id, voucherNumber: v.voucherNumber, issue: `HSN/SAC missing on "${it.stockItem.name}".` })
        continue
      }
      const k = `${it.hsnCode}|${it.gstRateBp}`
      if (!hsnAcc.has(k)) {
        hsnAcc.set(k, {
          hsnCode: it.hsnCode, description: it.stockItem.name, uqc: it.stockItem.unit?.name ?? 'NOS',
          qtyMilli: 0, rateBp: it.gstRateBp, taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0,
        })
      }
      const h = hsnAcc.get(k)!
      h.qtyMilli += it.qtyMilli
      h.taxableValuePaise += it.amountPaise
      h.cgstPaise += it.cgstPaise
      h.sgstPaise += it.sgstPaise
      h.igstPaise += it.igstPaise
      h.cessPaise += it.cessPaise
    }
  }

  const totals = vouchers.reduce(
    (a, v) => {
      const sign = v.voucherTypeCode === 'credit_note' ? -1 : 1
      return {
        taxableValuePaise: a.taxableValuePaise + sign * v.taxableValuePaise,
        cgstPaise: a.cgstPaise + sign * v.cgstPaise,
        sgstPaise: a.sgstPaise + sign * v.sgstPaise,
        igstPaise: a.igstPaise + sign * v.igstPaise,
        cessPaise: a.cessPaise + sign * v.cessPaise,
        invoiceCount: a.invoiceCount + 1,
      }
    },
    { taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0, invoiceCount: 0 },
  )

  return {
    status: exceptions.length ? 'prepared' : 'validated',
    period: { from, to },
    b2b, b2cl, b2cs, creditNotes,
    hsn: Array.from(hsnAcc.values()).sort((a, b) => a.hsnCode.localeCompare(b.hsnCode)),
    totals,
    exceptions,
  }
}

export interface Gstr3b {
  status: ReturnStatus
  period: { from: string; to: string }
  /** 3.1(a) Outward taxable supplies (other than zero rated, nil and exempted). */
  outwardTaxableSupplies: { taxableValuePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number }
  /** 4(A)(5) ITC available — all other ITC. */
  itcAvailable: { cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number; totalPaise: number }
  /** 5.1 / 6.1 net tax payable in cash after ITC set-off. */
  netPayable: { cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number; totalPaise: number }
  inwardSupplies: { taxableValuePaise: number }
  note: string
}

/** GSTR-3B working from the same posted vouchers GSTR-1 reads. */
export async function gstr3b(companyId: string, from: string, to: string): Promise<Gstr3b> {
  const s = await gstSummary(companyId, { from, to })
  return {
    status: 'prepared',
    period: { from, to },
    outwardTaxableSupplies: {
      taxableValuePaise: s.outwardTaxableValuePaise,
      cgstPaise: s.output.cgstPaise, sgstPaise: s.output.sgstPaise,
      igstPaise: s.output.igstPaise, cessPaise: s.output.cessPaise,
    },
    itcAvailable: {
      cgstPaise: s.input.cgstPaise, sgstPaise: s.input.sgstPaise,
      igstPaise: s.input.igstPaise, cessPaise: s.input.cessPaise, totalPaise: s.input.totalPaise,
    },
    netPayable: {
      cgstPaise: Math.max(s.net.cgstPaise, 0), sgstPaise: Math.max(s.net.sgstPaise, 0),
      igstPaise: Math.max(s.net.igstPaise, 0), cessPaise: Math.max(s.net.cessPaise, 0),
      totalPaise: Math.max(s.net.cgstPaise, 0) + Math.max(s.net.sgstPaise, 0) + Math.max(s.net.igstPaise, 0) + Math.max(s.net.cessPaise, 0),
    },
    inwardSupplies: { taxableValuePaise: s.inwardTaxableValuePaise },
    note: 'Prepared from posted vouchers. Cross-utilisation of IGST credit against CGST/SGST is not applied — set-off is shown per component.',
  }
}

/**
 * Split a taxable amount into its GST components for a supply. Intra-state
 * supplies split the rate into CGST + SGST; inter-state charge IGST. The
 * rate itself is always passed in — never assumed.
 */
export function splitGst(taxablePaise: number, rateBp: number, interState: boolean, cessBp = 0) {
  const total = applyBp(taxablePaise, rateBp)
  const cess = cessBp ? applyBp(taxablePaise, cessBp) : 0
  if (interState) return { cgstPaise: 0, sgstPaise: 0, igstPaise: total, cessPaise: cess }
  const half = Math.round(total / 2)
  return { cgstPaise: half, sgstPaise: total - half, igstPaise: 0, cessPaise: cess }
}
