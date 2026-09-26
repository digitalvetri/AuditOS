import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { BookkeepingCompanyService } from './BookkeepingCompanyService.js'
import { gstSummary, gstr1, gstr3b } from '../engine/gst.js'
import { parseTaxConfig } from '../engine/posting.js'
import { ledgerBalances } from '../engine/balances.js'
import { bpToPct } from '../engine/primitives.js'

/**
 * BookkeepingGstService — GST and other statutory reporting.
 *
 * WHAT THIS MODULE DOES NOT DO: it does not file anything. There is no
 * GSTN, IRP or e-Way Bill portal integration here. A return or an
 * e-invoice payload produced below is PREPARED (and possibly VALIDATED
 * and EXPORTED) — the words are used strictly, and "Filed" is never
 * claimed by this code.
 */

export const BookkeepingGstService = {
  async summary(session: Session, companyId: string, filter: { from?: string; to?: string }) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    return gstSummary(companyId, filter)
  },

  async gstr1(session: Session, companyId: string, from: string, to: string) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    return gstr1(companyId, from, to)
  },

  async gstr3b(session: Session, companyId: string, from: string, to: string) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    return gstr3b(companyId, from, to)
  },

  /**
   * Exceptions an accountant must clear before a return is worth filing:
   * missing counter-party GSTIN, missing HSN, missing place of supply,
   * taxable value with no tax posted.
   */
  async exceptions(session: Session, companyId: string, from: string, to: string) {
    const r = await BookkeepingGstService.gstr1(session, companyId, from, to)
    const grouped = new Map<string, { issue: string; vouchers: { voucher_id: string; voucher_number: string }[] }>()
    for (const e of r.exceptions) {
      if (!grouped.has(e.issue)) grouped.set(e.issue, { issue: e.issue, vouchers: [] })
      grouped.get(e.issue)!.vouchers.push({ voucher_id: e.voucherId, voucher_number: e.voucherNumber })
    }
    return { period: { from, to }, groups: Array.from(grouped.values()), total: r.exceptions.length }
  },

  // ── Tax rate masters (data-driven statutory rates) ──────────────────
  async listTaxRates(session: Session, companyId: string, taxType?: string) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const rows = await prisma.bookkeepingTaxRate.findMany({
      where: { tallyCompanyId: companyId, ...alive, ...(taxType ? { taxType } : {}) },
      orderBy: [{ taxType: 'asc' }, { name: 'asc' }],
    })
    return rows.map((r) => ({
      id: r.id, tax_type: r.taxType, name: r.name, hsn_code: r.hsnCode, sac_code: r.sacCode,
      section: r.section, rate_bp: r.rateBp, rate_pct: bpToPct(r.rateBp), cess_bp: r.cessBp,
      threshold_paise: r.thresholdPaise, effective_from: r.effectiveFrom, active: r.active,
    }))
  },

  async createTaxRate(session: Session, companyId: string, input: {
    taxType: string; name: string; rateBp: number; cessBp?: number; hsnCode?: string | null
    sacCode?: string | null; section?: string | null; thresholdPaise?: number | null; effectiveFrom?: string | null
  }) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const name = input.name.trim()
    if (!name) throw ApiError.badRequest('Name is required.')
    if (!['gst', 'tds', 'tcs'].includes(input.taxType)) throw ApiError.badRequest('Tax type must be gst, tds or tcs.')
    const clash = await prisma.bookkeepingTaxRate.findFirst({ where: { tallyCompanyId: companyId, taxType: input.taxType, name, ...alive } })
    if (clash) throw ApiError.conflict('duplicate_name', `A ${input.taxType.toUpperCase()} rate named "${name}" already exists.`)
    const r = await prisma.bookkeepingTaxRate.create({
      data: {
        tallyCompanyId: companyId, taxType: input.taxType, name,
        rateBp: input.rateBp, cessBp: input.cessBp ?? 0,
        hsnCode: input.hsnCode ?? null, sacCode: input.sacCode ?? null, section: input.section ?? null,
        thresholdPaise: input.thresholdPaise ?? null, effectiveFrom: input.effectiveFrom ?? null,
      },
    })
    return { id: r.id, name: r.name, tax_type: r.taxType, rate_bp: r.rateBp }
  },

  /**
   * TDS / TCS position. Derived from ledgers whose taxConfigJson declares
   * a tax_type of tds or tcs — so adding a new section is a master change,
   * never a code change.
   */
  async statutorySummary(session: Session, companyId: string, taxType: 'tds' | 'tcs', filter: { from?: string; to?: string } = {}) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const [ledgers, balances, rates] = await Promise.all([
      prisma.bookkeepingLedger.findMany({
        where: { tallyCompanyId: companyId, ...alive, NOT: { taxConfigJson: null } },
        select: { id: true, name: true, taxConfigJson: true },
      }),
      ledgerBalances(companyId, filter),
      prisma.bookkeepingTaxRate.findMany({ where: { tallyCompanyId: companyId, taxType, ...alive } }),
    ])
    const byId = new Map(balances.map((b) => [b.ledgerId, b]))
    const rows = ledgers
      .map((l) => ({ l, cfg: parseTaxConfig(l.taxConfigJson) as { tax_type?: string; section?: string } }))
      .filter((x) => x.cfg.tax_type === taxType)
      .map((x) => {
        const b = byId.get(x.l.id)
        return {
          ledger_id: x.l.id, ledger_name: x.l.name, section: x.cfg.section ?? null,
          deducted_paise: b ? b.creditPaise : 0,
          paid_paise: b ? b.debitPaise : 0,
          payable_paise: b ? -b.closingPaise : 0,
        }
      })
    return {
      tax_type: taxType,
      period: { from: filter.from ?? null, to: filter.to ?? null },
      rows,
      totals: {
        deducted_paise: rows.reduce((s, r) => s + r.deducted_paise, 0),
        paid_paise: rows.reduce((s, r) => s + r.paid_paise, 0),
        payable_paise: rows.reduce((s, r) => s + r.payable_paise, 0),
      },
      configured_rates: rates.map((r) => ({ id: r.id, name: r.name, section: r.section, rate_pct: bpToPct(r.rateBp), threshold_paise: r.thresholdPaise })),
      note: rows.length === 0
        ? `No ledger is configured for ${taxType.toUpperCase()}. Tag a Duties & Taxes ledger with {"tax_type":"${taxType}","section":"..."} to report on it.`
        : 'Rates and sections come from the tax-rate masters; nothing is assumed by the code.',
    }
  },

  /**
   * e-Invoice payload for one sales voucher, in the shape the IRP schema
   * expects. STATUS: prepared locally. Nothing is transmitted to an IRP
   * and no IRN is obtained — that needs an approved GSP integration.
   */
  async eInvoicePayload(session: Session, companyId: string, voucherId: string) {
    const company = await BookkeepingCompanyService.requireOwned(session, companyId)
    const v = await prisma.bookkeepingVoucher.findFirst({
      where: { id: voucherId, tallyCompanyId: companyId, ...alive, voucherTypeCode: 'sales' },
      include: {
        partyLedger: true,
        items: { include: { stockItem: { include: { unit: true } } } },
      },
    })
    if (!v) throw ApiError.notFound('No such sales voucher.')
    const missing: string[] = []
    if (!company.gstin) missing.push('Company GSTIN')
    if (!v.partyLedger?.gstin) missing.push('Buyer GSTIN')
    if (!v.placeOfSupply) missing.push('Place of supply')
    if (!v.items.length) missing.push('At least one item line')
    for (const i of v.items) if (!i.hsnCode) missing.push(`HSN for ${i.stockItem.name}`)

    return {
      status: 'prepared' as const,
      transmitted: false,
      irn: null,
      blockers: missing,
      note: 'Prepared locally in the IRP payload shape. Audit OS has no IRP/GSP integration, so no IRN is generated and nothing is sent to the portal.',
      payload: {
        Version: '1.1',
        TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
        DocDtls: { Typ: 'INV', No: v.voucherNumber, Dt: toDdMmYyyy(v.date) },
        SellerDtls: {
          Gstin: company.gstin, LglNm: company.name, TrdNm: company.mailingName ?? company.name,
          Addr1: company.address ?? '', Loc: company.state ?? '', Pin: Number(company.pin ?? 0) || null, Stcd: gstStateCode(company.gstin),
        },
        BuyerDtls: {
          Gstin: v.partyLedger?.gstin ?? null, LglNm: v.partyLedger?.name ?? '',
          Pos: v.placeOfSupply ?? null, Addr1: v.partyLedger?.address ?? '', Loc: v.partyLedger?.state ?? '',
          Stcd: gstStateCode(v.partyLedger?.gstin ?? null),
        },
        ItemList: v.items.map((i, idx) => ({
          SlNo: String(idx + 1),
          PrdDesc: i.stockItem.name,
          HsnCd: i.hsnCode,
          Qty: i.qtyMilli / 1000,
          Unit: i.stockItem.unit?.name ?? 'NOS',
          UnitPrice: i.ratePaise / 100,
          TotAmt: (i.amountPaise + i.discountPaise) / 100,
          Discount: i.discountPaise / 100,
          AssAmt: i.amountPaise / 100,
          GstRt: i.gstRateBp / 100,
          CgstAmt: i.cgstPaise / 100,
          SgstAmt: i.sgstPaise / 100,
          IgstAmt: i.igstPaise / 100,
          CesAmt: i.cessPaise / 100,
          TotItemVal: (i.amountPaise + i.cgstPaise + i.sgstPaise + i.igstPaise + i.cessPaise) / 100,
        })),
        ValDtls: {
          AssVal: v.taxableValuePaise / 100,
          CgstVal: v.cgstPaise / 100,
          SgstVal: v.sgstPaise / 100,
          IgstVal: v.igstPaise / 100,
          CesVal: v.cessPaise / 100,
          RndOffAmt: v.roundOffPaise / 100,
          TotInvVal: v.grandTotalPaise / 100,
        },
      },
    }
  },

  /**
   * e-Way Bill payload for one voucher. STATUS: prepared locally. No EWB
   * number is generated — that requires the NIC portal.
   */
  async eWayBillPayload(session: Session, companyId: string, voucherId: string, transport: {
    transporterId?: string | null; transporterName?: string | null; vehicleNumber?: string | null
    transportMode?: string | null; distanceKm?: number | null
  } = {}) {
    const company = await BookkeepingCompanyService.requireOwned(session, companyId)
    const v = await prisma.bookkeepingVoucher.findFirst({
      where: { id: voucherId, tallyCompanyId: companyId, ...alive },
      include: { partyLedger: true, items: { include: { stockItem: true } } },
    })
    if (!v) throw ApiError.notFound('No such voucher.')
    const blockers: string[] = []
    if (!company.gstin) blockers.push('Company GSTIN')
    if (!v.placeOfSupply) blockers.push('Place of supply')
    if (!transport.vehicleNumber && !transport.transporterId) blockers.push('Vehicle number or transporter ID')
    if (!transport.distanceKm) blockers.push('Approximate distance')

    return {
      status: 'prepared' as const,
      transmitted: false,
      ewb_number: null,
      blockers,
      note: 'Prepared locally in the NIC e-Way Bill payload shape. Audit OS has no e-Way Bill portal integration, so no EWB number is generated.',
      payload: {
        supplyType: v.voucherTypeCode === 'purchase' ? 'I' : 'O',
        subSupplyType: '1',
        docType: 'INV',
        docNo: v.voucherNumber,
        docDate: toDdMmYyyy(v.date),
        fromGstin: company.gstin,
        fromTrdName: company.name,
        fromStateCode: gstStateCode(company.gstin),
        toGstin: v.partyLedger?.gstin ?? 'URP',
        toTrdName: v.partyLedger?.name ?? '',
        toStateCode: v.placeOfSupply ?? null,
        totalValue: v.taxableValuePaise / 100,
        cgstValue: v.cgstPaise / 100,
        sgstValue: v.sgstPaise / 100,
        igstValue: v.igstPaise / 100,
        totInvValue: v.grandTotalPaise / 100,
        transporterId: transport.transporterId ?? null,
        transporterName: transport.transporterName ?? null,
        transDistance: transport.distanceKm ?? null,
        transMode: transport.transportMode ?? '1',
        vehicleNo: transport.vehicleNumber ?? null,
        itemList: v.items.map((i) => ({
          productName: i.stockItem.name,
          hsnCode: i.hsnCode,
          quantity: i.qtyMilli / 1000,
          taxableAmount: i.amountPaise / 100,
          cgstRate: i.cgstPaise ? i.gstRateBp / 200 : 0,
          sgstRate: i.sgstPaise ? i.gstRateBp / 200 : 0,
          igstRate: i.igstPaise ? i.gstRateBp / 100 : 0,
        })),
      },
    }
  },
}

function toDdMmYyyy(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

/** The first two digits of a GSTIN are the state code. */
function gstStateCode(gstin: string | null): string | null {
  return gstin && gstin.length >= 2 ? gstin.slice(0, 2) : null
}
