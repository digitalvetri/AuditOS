import { prisma } from '../../../lib/prisma.js'

/**
 * Start of the financial year that contains `date`: the company's own FY
 * row when one covers it, otherwise derived from fyBeginMonth.
 *
 * Shared by the balance sheet (where current-year profit begins) and
 * stock valuation (where the weighted average restarts), so both agree
 * on what "this year" means.
 */
export async function fyStartFor(companyId: string, date: string): Promise<string> {
  const [company, fy] = await Promise.all([
    prisma.bookkeepingCompany.findUnique({ where: { id: companyId }, select: { fyBeginMonth: true } }),
    prisma.bookkeepingFinancialYear.findFirst({
      where: { tallyCompanyId: companyId, startDate: { lte: date }, endDate: { gte: date } },
      select: { startDate: true },
    }),
  ])
  if (fy) return fy.startDate
  const month = company?.fyBeginMonth ?? 4
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  const startYear = m >= month ? y : y - 1
  return `${startYear}-${String(month).padStart(2, '0')}-01`
}
