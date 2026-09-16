import { prisma, alive } from '../../../lib/prisma.js'
import type { Session } from '../../../platform/auth.js'
import { TallyCompanyService } from './TallyCompanyService.js'
import { TallyReportService } from './TallyReportService.js'
import { TallyAuditService } from './TallyAuditService.js'
import { ledgerBalances, profitAndLoss } from '../engine/balances.js'
import { stockPositions } from '../engine/inventory.js'
import { gstSummary } from '../engine/gst.js'

/**
 * TallyDashboardService — the dashboard is a VIEW OF THE REPORTS, and
 * the reports are a view of the vouchers. Every tile below carries a
 * `drill` hint naming the report it came from, so a number on the
 * dashboard is one click from the transactions behind it.
 *
 * No figure here is stored, cached, estimated or hardcoded.
 */

export const TallyDashboardService = {
  async overview(session: Session, companyId: string, opts: { from?: string; to?: string; fyId?: string } = {}) {
    await TallyCompanyService.requireOwned(session, companyId)

    // Default to the financial year the company is currently in.
    let from = opts.from ?? null
    let to = opts.to ?? null
    let fyLabel: string | null = null
    if (!from || !to) {
      const fy = opts.fyId
        ? await prisma.tallyFinancialYear.findFirst({ where: { id: opts.fyId, tallyCompanyId: companyId } })
        : await prisma.tallyFinancialYear.findFirst({ where: { tallyCompanyId: companyId }, orderBy: { startDate: 'desc' } })
      if (fy) { from = from ?? fy.startDate; to = to ?? fy.endDate; fyLabel = fy.label }
    }
    const period = { from, to }

    const [balances, pl, stock, gst, receivables, payables, recent, sales, purchases, exceptions, voucherCount] = await Promise.all([
      ledgerBalances(companyId, period),
      profitAndLoss(companyId, period),
      stockPositions(companyId, period),
      gstSummary(companyId, period),
      TallyReportService.outstandings(session, companyId, { side: 'receivable', asOf: to }),
      TallyReportService.outstandings(session, companyId, { side: 'payable', asOf: to }),
      TallyReportService.dayBook(session, companyId, { from: from ?? undefined, to: to ?? undefined, limit: 10 }),
      TallyReportService.register(session, companyId, 'sales', period),
      TallyReportService.register(session, companyId, 'purchase', period),
      TallyAuditService.exceptions(session, companyId, { from: from ?? undefined, to: to ?? undefined }),
      prisma.tallyVoucher.count({ where: { tallyCompanyId: companyId, ...alive, status: 'active', ...(from && to ? { date: { gte: from, lte: to } } : {}) } }),
    ])

    const sumGroup = (name: string) => balances.filter((b) => b.primaryGroupName === name).reduce((s, b) => s + b.closingPaise, 0)

    const tiles = [
      { key: 'sales', label: 'Total sales', amount_paise: sales.totals.grandTotalPaise, drill: 'register:sales' },
      { key: 'purchases', label: 'Total purchases', amount_paise: purchases.totals.grandTotalPaise, drill: 'register:purchase' },
      { key: 'receivables', label: 'Receivables', amount_paise: receivables.totalPaise, drill: 'outstanding:receivable' },
      { key: 'payables', label: 'Payables', amount_paise: payables.totalPaise, drill: 'outstanding:payable' },
      { key: 'cash', label: 'Cash balance', amount_paise: sumGroup('Cash-in-Hand'), drill: 'book:cash' },
      { key: 'bank', label: 'Bank balance', amount_paise: sumGroup('Bank Accounts'), drill: 'book:bank' },
      { key: 'stock', label: 'Stock value', amount_paise: stock.reduce((s, r) => s + r.closingValuePaise, 0), drill: 'inventory:summary' },
      { key: 'profit', label: pl.netProfitPaise >= 0 ? 'Profit' : 'Loss', amount_paise: pl.netProfitPaise, drill: 'report:pl' },
      { key: 'gst_payable', label: 'GST payable', amount_paise: Math.max(gst.net.totalPaise, 0), drill: 'gst:summary' },
      { key: 'gst_credit', label: 'GST credit available', amount_paise: Math.max(-gst.net.totalPaise, 0), drill: 'gst:summary' },
    ]

    return {
      company_id: companyId,
      period: { from, to, financial_year_label: fyLabel },
      voucher_count: voucherCount,
      tiles,
      recent_vouchers: recent.items,
      top_receivables: receivables.parties.slice(0, 5),
      top_payables: payables.parties.slice(0, 5),
      receivable_ageing: receivables.ageing,
      payable_ageing: payables.ageing,
      alerts: exceptions.items.filter((i) => i.count > 0),
      gst: { output_paise: gst.output.totalPaise, input_paise: gst.input.totalPaise, net_paise: gst.net.totalPaise },
      profit_and_loss: {
        income_paise: pl.income.totalPaise,
        expense_paise: pl.expenses.totalPaise,
        gross_profit_paise: pl.grossProfitPaise,
        net_profit_paise: pl.netProfitPaise,
      },
    }
  },
}
