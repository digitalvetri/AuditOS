import { prisma, alive } from '../../../lib/prisma.js'
import type { Session } from '../../../platform/auth.js'
import { TallyCompanyService } from './TallyCompanyService.js'

/**
 * TallySearchService — one query across a company's masters and
 * transactions. Every hit carries the route that opens the record, so the
 * UI never has to map a type to a path.
 */

export interface SearchHit {
  type: 'ledger' | 'group' | 'voucher' | 'stock_item' | 'company' | 'employee'
  id: string
  label: string
  sublabel: string | null
  route: string
}

export const TallySearchService = {
  async search(session: Session, companyId: string, q: string, limit = 8): Promise<{ query: string; hits: SearchHit[] }> {
    await TallyCompanyService.requireOwned(session, companyId)
    const term = q.trim()
    if (term.length < 2) return { query: term, hits: [] }
    const like = { contains: term, mode: 'insensitive' as const }
    const base = `/tally/companies/${companyId}`

    const [ledgers, groups, vouchers, items, employees] = await Promise.all([
      prisma.tallyLedger.findMany({
        where: { tallyCompanyId: companyId, ...alive, OR: [{ name: like }, { gstin: like }, { pan: like }] },
        select: { id: true, name: true, group: { select: { name: true } } }, take: limit,
      }),
      prisma.tallyGroup.findMany({
        where: { tallyCompanyId: companyId, ...alive, name: like },
        select: { id: true, name: true, nature: true }, take: limit,
      }),
      prisma.tallyVoucher.findMany({
        where: {
          tallyCompanyId: companyId, ...alive,
          OR: [{ voucherNumber: like }, { narration: like }, { referenceNumber: like }, { partyLedger: { name: like } }],
        },
        select: { id: true, voucherNumber: true, date: true, voucherTypeCode: true, grandTotalPaise: true, partyLedger: { select: { name: true } } },
        orderBy: { date: 'desc' }, take: limit,
      }),
      prisma.tallyStockItem.findMany({
        where: { tallyCompanyId: companyId, ...alive, OR: [{ name: like }, { hsnCode: like }] },
        select: { id: true, name: true, hsnCode: true }, take: limit,
      }),
      prisma.tallyEmployee.findMany({
        where: { tallyCompanyId: companyId, ...alive, OR: [{ name: like }, { code: like }] },
        select: { id: true, name: true, designation: true }, take: limit,
      }),
    ])

    const hits: SearchHit[] = [
      ...ledgers.map((l) => ({
        type: 'ledger' as const, id: l.id, label: l.name, sublabel: l.group.name,
        route: `${base}/reports/ledger/${l.id}`,
      })),
      ...groups.map((g) => ({
        type: 'group' as const, id: g.id, label: g.name, sublabel: g.nature,
        route: `${base}/masters/groups`,
      })),
      ...vouchers.map((v) => ({
        type: 'voucher' as const, id: v.id,
        label: `${v.voucherTypeCode.replace(/_/g, ' ')} ${v.voucherNumber}`,
        sublabel: `${v.date}${v.partyLedger ? ` · ${v.partyLedger.name}` : ''} · ₹${(v.grandTotalPaise / 100).toFixed(2)}`,
        route: `${base}/vouchers/${v.id}`,
      })),
      ...items.map((i) => ({
        type: 'stock_item' as const, id: i.id, label: i.name, sublabel: i.hsnCode ? `HSN ${i.hsnCode}` : null,
        route: `${base}/inventory/items/${i.id}`,
      })),
      ...employees.map((e) => ({
        type: 'employee' as const, id: e.id, label: e.name, sublabel: e.designation,
        route: `${base}/payroll`,
      })),
    ]
    return { query: term, hits }
  },

  /** Cross-company search used by the module home. */
  async searchCompanies(session: Session, q: string) {
    const companies = await TallyCompanyService.listForOrg(session)
    const term = q.trim().toLowerCase()
    return companies
      .filter((c) => !term || c.name.toLowerCase().includes(term) || (c.gstin ?? '').toLowerCase().includes(term))
      .map((c) => ({
        type: 'company' as const, id: c.id, label: c.name, sublabel: c.gstin, route: `/tally/companies/${c.id}`,
      }))
  },
}
