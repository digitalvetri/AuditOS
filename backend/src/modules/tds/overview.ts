/**
 * TDS firm-wide board — every client TAN's challans, returns, certificates
 * and TRACES checks, with what is overdue or due soon. Shared by
 * GET /api/tds/overview and the reminder job (reminders.ts).
 *
 * One query per table, grouped in memory — never a query per client.
 */
import type { PrismaClient } from '@prisma/client'
import {
  addDays, expectedItems, lastNoticeCheck, noticeCheckStale, type ExpectedItem, type FilingLike,
} from './calendar.js'

/** Days ahead that count as "due soon". */
export const DUE_SOON_DAYS = 7

export interface OverviewItem extends ExpectedItem { due_soon: boolean }

export interface OverviewRow {
  client_id: string
  client_name: string
  client_code: string | null
  account_manager_id: string
  account_manager: string | null
  tan: string | null
  is_primary_tan: boolean
  deductor_type: string | null
  return_forms: string[]
  /** Challans / returns / certificates / 16B-C-D not yet done — overdue first. */
  open_items: OverviewItem[]
  overdue: number
  due_soon: number
  open_notices: number
  last_notice_check: string | null
  notice_check_stale: boolean
  /** Worst state, for sorting and the row colour. */
  standing: 'overdue' | 'due_soon' | 'check_due' | 'ok' | 'no_tan'
}

const splitTans = (csv: string | null | undefined) => (csv ?? '').split(',').map((t) => t.trim()).filter(Boolean)

export async function buildOverview(prisma: PrismaClient, clientIds: string[] | 'ALL', fy: string, today: string): Promise<OverviewRow[]> {
  const clients = await prisma.client.findMany({
    where: {
      deletedAt: null,
      ...(clientIds === 'ALL' ? {} : { id: { in: clientIds } }),
      // Only clients TDS applies to: a TAN, a TDS profile, or TDS records.
      OR: [{ tan: { not: null } }, { tdsProfile: { isNot: null } }],
    },
    select: {
      id: true, companyName: true, clientCode: true, tan: true, accountManagerId: true,
      tdsProfile: { select: { returnForms: true, deductorType: true, additionalTans: true } },
    },
    orderBy: { companyName: 'asc' },
  })
  if (!clients.length) return []
  const ids = clients.map((c) => c.id)
  const [filings, managers] = await Promise.all([
    prisma.tdsFiling.findMany({
      where: {
        clientId: { in: ids }, deletedAt: null,
        OR: [{ fy }, { kind: { in: ['notice', 'notice_check'] } }],
      },
      select: { clientId: true, tan: true, kind: true, fy: true, period: true, formType: true, status: true, eventDate: true, reference: true, certIssuedOn: true },
    }),
    prisma.employee.findMany({
      where: { id: { in: [...new Set(clients.map((c) => c.accountManagerId))] } },
      select: { id: true, firstName: true, lastName: true },
    }),
  ])
  const managerName = new Map(managers.map((m) => [m.id, [m.firstName, m.lastName].filter(Boolean).join(' ') || null]))
  const byClient = new Map<string, typeof filings>()
  for (const f of filings) byClient.set(f.clientId, [...(byClient.get(f.clientId) ?? []), f])

  const soon = addDays(today, DUE_SOON_DAYS)
  const rows: OverviewRow[] = []
  for (const c of clients) {
    const forms = (c.tdsProfile?.returnForms ?? '26Q').split(',').filter(Boolean)
    const tans = [...(c.tan ? [c.tan] : []), ...splitTans(c.tdsProfile?.additionalTans).filter((t) => t !== c.tan)]
    const own = byClient.get(c.id) ?? []
    const base = {
      client_id: c.id, client_name: c.companyName, client_code: c.clientCode ?? null,
      account_manager_id: c.accountManagerId, account_manager: managerName.get(c.accountManagerId) ?? null,
      deductor_type: c.tdsProfile?.deductorType ?? null, return_forms: forms,
    }
    if (!tans.length) {
      rows.push({ ...base, tan: null, is_primary_tan: true, open_items: [], overdue: 0, due_soon: 0, open_notices: 0, last_notice_check: null, notice_check_stale: false, standing: 'no_tan' })
      continue
    }
    for (const tan of tans) {
      const primary = tan === c.tan
      // Rows with tan = null belong to the primary TAN.
      const records: FilingLike[] = own.filter((r) => (primary ? r.tan === null || r.tan === tan : r.tan === tan))
      const items = expectedItems(records, fy, forms, today)
        .filter((i) => i.state !== 'done')
        .map((i) => ({ ...i, due_soon: i.state !== 'overdue' && i.due <= soon }))
        .sort((a, b) => (a.state === 'overdue' ? 0 : 1) - (b.state === 'overdue' ? 0 : 1) || a.due.localeCompare(b.due))
      const overdue = items.filter((i) => i.state === 'overdue').length
      const dueSoon = items.filter((i) => i.due_soon).length
      const openNotices = records.filter((r) => r.kind === 'notice' && r.status !== 'done').length
      const stale = noticeCheckStale(records, today)
      rows.push({
        ...base, tan, is_primary_tan: primary, open_items: items, overdue: overdue + openNotices, due_soon: dueSoon,
        open_notices: openNotices, last_notice_check: lastNoticeCheck(records), notice_check_stale: stale,
        standing: overdue + openNotices > 0 ? 'overdue' : dueSoon > 0 ? 'due_soon' : stale ? 'check_due' : 'ok',
      })
    }
  }
  const rank = { overdue: 0, due_soon: 1, check_due: 2, no_tan: 3, ok: 4 }
  return rows.sort((a, b) => rank[a.standing] - rank[b.standing] || b.overdue - a.overdue || a.client_name.localeCompare(b.client_name))
}
