import { prisma } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { TallyCompanyService } from './TallyCompanyService.js'

/**
 * TallyFinancialYearService — list / create / close FYs for a company.
 * The first FY is seeded at company creation (TallyCompanyService.create);
 * subsequent FYs are added here.
 */

export interface FinancialYearApi {
  id: string
  label: string
  start_date: string
  end_date: string
  closed: boolean
  created_at: string
}

function toApi(row: {
  id: string; label: string; startDate: string; endDate: string; closed: boolean; createdAt: Date;
}): FinancialYearApi {
  return {
    id: row.id, label: row.label, start_date: row.startDate,
    end_date: row.endDate, closed: row.closed, created_at: row.createdAt.toISOString(),
  }
}

export const TallyFinancialYearService = {
  toApi,

  async list(session: Session, companyId: string): Promise<FinancialYearApi[]> {
    await TallyCompanyService.requireOwned(session, companyId)
    const rows = await prisma.tallyFinancialYear.findMany({
      where: { tallyCompanyId: companyId },
      orderBy: [{ startDate: 'desc' }],
    })
    return rows.map(toApi)
  },

  async create(session: Session, companyId: string, input: {
    label: string
    startDate: string
    endDate: string
  }): Promise<FinancialYearApi> {
    await TallyCompanyService.requireOwned(session, companyId)
    const label = input.label.trim()
    if (!label) throw ApiError.badRequest('Label is required.')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)) {
      throw ApiError.badRequest('Dates must be YYYY-MM-DD.')
    }
    if (input.startDate >= input.endDate) throw ApiError.badRequest('Start date must be before end date.')
    const clash = await prisma.tallyFinancialYear.findFirst({
      where: { tallyCompanyId: companyId, label },
    })
    if (clash) throw ApiError.conflict('duplicate_label', `FY "${label}" already exists.`)
    const row = await prisma.tallyFinancialYear.create({
      data: { tallyCompanyId: companyId, label, startDate: input.startDate, endDate: input.endDate },
    })
    return toApi(row)
  },

  async close(session: Session, companyId: string, fyId: string): Promise<FinancialYearApi> {
    await TallyCompanyService.requireOwned(session, companyId)
    const row = await prisma.tallyFinancialYear.findFirst({
      where: { id: fyId, tallyCompanyId: companyId },
    })
    if (!row) throw ApiError.notFound('No such financial year.')
    const updated = await prisma.tallyFinancialYear.update({
      where: { id: fyId }, data: { closed: true },
    })
    return toApi(updated)
  },
}
