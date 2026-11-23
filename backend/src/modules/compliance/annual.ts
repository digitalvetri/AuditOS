/**
 * ANNUAL FILINGS — the yearly returns the firm files for its clients, created
 * automatically on the day the work opens (sidebar Workstation → IT filing /
 * MCA filing). Each is an ordinary ComplianceItem, so the compliance calendar,
 * reminders, "Mark filed" and extensions all apply.
 *
 *   Form              Who                                   Opens   Due
 *   LLP Form 11       every active LLP client               1 Apr   31 May
 *   LLP Form 8        every active LLP client               1 Sep   31 Oct
 *   ADT-1             every active company client           1 Aug   31 Oct
 *   AOC-4             every active company client           1 Aug   31 Oct
 *   MGT-7 / 7A        every active company client           1 Aug   30 Nov
 *   ITR               clients with Income Tax Filing        1 May   statutory, by ITR type
 *
 * The open/due dates are the firm's own working calendar (agreed 2026-11-23).
 * A company's AGM date entered on an item still recomputes its due date the
 * statutory way. A form switched off in the catalogue is not created.
 *
 * The run for a calendar year covers the financial year that ended on the
 * 31 March before it. An item is created once the open date has come and
 * only until its due date has passed — the firm cannot know whether a return
 * that was already due before this ran was filed elsewhere. Idempotent: a
 * row for (client, form, FY) — made here, by hand or from an obligation — is
 * never touched.
 */
import type { PrismaClient } from '@prisma/client'
import { entityTypeOf, fyLabel, type EntityType } from './engine.js'
import { dueFor } from './engine.js'
import { toRule } from './service.js'

export type AnnualGroup = 'it' | 'llp' | 'company'

export interface AnnualRun {
  group: AnnualGroup
  formCode: string
  /** 'MM-DD' the item is created on. */
  opens: string
  /** 'MM-DD' it is due on; null = the catalogue's statutory rule (ITR). */
  due: string | null
}

export const ANNUAL_RUNS: AnnualRun[] = [
  { group: 'llp', formCode: 'LLP11', opens: '04-01', due: '05-31' },
  { group: 'llp', formCode: 'LLP8', opens: '09-01', due: '10-31' },
  { group: 'company', formCode: 'ADT1', opens: '08-01', due: '10-31' },
  { group: 'company', formCode: 'AOC4', opens: '08-01', due: '10-31' },
  { group: 'company', formCode: 'MGT7', opens: '08-01', due: '11-30' },
]

/** The ITR forms an IT item can be, and the date IT items open. */
export const ITR_FORMS = ['ITR_NON_BUSINESS', 'ITR_NON_AUDIT_BUSINESS', 'ITR_AUDIT', 'ITR_TP']
export const ITR_OPENS = '05-01'
const INCOME_TAX_SERVICE = 'INCOME_TAX_FILING'

/** Form codes listed on each worklist page. */
export const GROUP_FORMS: Record<AnnualGroup, string[]> = {
  it: ITR_FORMS,
  llp: ANNUAL_RUNS.filter((r) => r.group === 'llp').map((r) => r.formCode),
  company: ANNUAL_RUNS.filter((r) => r.group === 'company').map((r) => r.formCode),
}

/**
 * Which ITR a client files: audited (tax audit obligation), companies and
 * trusts → ITR_AUDIT (31 Oct); firms, LLPs, AOPs → business, not audited
 * (31 Aug); individuals and HUFs → no business income (31 Jul). The item can
 * be marked Not applicable and the right one added from the client's
 * Compliance tab when the guess is wrong.
 */
export function itrFormFor(entity: EntityType, audited: boolean): string {
  if (audited || entity === 'company' || entity === 'trust' || entity === 'society') return 'ITR_AUDIT'
  if (entity === 'firm' || entity === 'llp' || entity === 'aop') return 'ITR_NON_AUDIT_BUSINESS'
  return 'ITR_NON_BUSINESS'
}

/** The FY a run in `year` covers: the one ending 31 March of `year`. */
export const runFy = (year: number) => fyLabel(year - 1)

export interface AnnualResult { created: number; skipped_existing: number; by_form: Record<string, number> }

export async function generateAnnualFilings(
  prisma: PrismaClient,
  today: string,
  opts: { organisationId?: string } = {},
): Promise<AnnualResult> {
  const year = Number(today.slice(0, 4))
  const fy = runFy(year)
  const result: AnnualResult = { created: 0, skipped_existing: 0, by_form: {} }
  const forms = new Map((await prisma.complianceForm.findMany({ where: { isActive: true } })).map((f) => [f.code, f]))

  // Runs whose window (open date … due date) contains today.
  const openRuns = ANNUAL_RUNS.filter((r) => forms.has(r.formCode) && today >= `${year}-${r.opens}` && today <= `${year}-${r.due}`)
  const itOpen = today >= `${year}-${ITR_OPENS}`
  if (!openRuns.length && !itOpen) return result

  const clients = await prisma.client.findMany({
    where: {
      deletedAt: null, status: { not: 'inactive' }, isOrganization: false,
      ...(opts.organisationId ? { organisationId: opts.organisationId } : {}),
    },
    select: { id: true, organisationId: true, businessType: true },
  })
  if (!clients.length) return result
  const ids = clients.map((c) => c.id)
  const existing = await prisma.complianceItem.findMany({
    where: { clientId: { in: ids }, periodKey: fy, formCode: { in: [...ANNUAL_RUNS.map((r) => r.formCode), ...ITR_FORMS] } },
    select: { clientId: true, formCode: true },
  })
  const has = new Set(existing.map((i) => `${i.clientId}|${i.formCode}`))
  const hasItr = new Set(existing.filter((i) => ITR_FORMS.includes(i.formCode)).map((i) => i.clientId))

  const create = async (c: (typeof clients)[number], formCode: string, dueDate: string, assignedEmployeeId: string | null) => {
    if (has.has(`${c.id}|${formCode}`)) { result.skipped_existing += 1; return }
    await prisma.complianceItem.create({
      data: {
        organisationId: c.organisationId, clientId: c.id, formCode, periodKey: fy, periodLabel: `FY ${fy}`,
        dueDate, assignedEmployeeId, notes: 'Created automatically for the year.',
      },
    }).then(() => {
      result.created += 1
      result.by_form[formCode] = (result.by_form[formCode] ?? 0) + 1
      has.add(`${c.id}|${formCode}`)
    }).catch((e: { code?: string }) => { if (e.code !== 'P2002') throw e })
  }

  for (const run of openRuns) {
    for (const c of clients) {
      if (entityTypeOf(c.businessType) !== run.group) continue
      await create(c, run.formCode, `${year}-${run.due}`, null)
    }
  }

  if (itOpen) {
    const services = await prisma.clientService.findMany({
      where: { clientId: { in: ids }, deletedAt: null, status: { not: 'failed' }, service: { code: INCOME_TAX_SERVICE } },
      select: { clientId: true, assignedEmployeeId: true },
    })
    const audited = new Set((await prisma.clientObligation.findMany({
      where: { clientId: { in: ids }, formCode: 'TAX_AUDIT_REPORT', isActive: true, deletedAt: null }, select: { clientId: true },
    })).map((o) => o.clientId))
    const assignee = new Map(services.map((s) => [s.clientId, s.assignedEmployeeId ?? null]))
    for (const c of clients) {
      if (!assignee.has(c.id) || hasItr.has(c.id)) continue
      const code = itrFormFor(entityTypeOf(c.businessType), audited.has(c.id))
      const form = forms.get(code)
      if (!form) continue
      const due = dueFor(toRule(form), fy, fy)?.statutory_due_date
      if (!due || today > due) continue
      await create(c, code, due, assignee.get(c.id) ?? null)
    }
  }
  return result
}

/** The schedule shown on a worklist page: when each form opens and is due next. */
export function annualSchedule(group: AnnualGroup, today: string) {
  const year = Number(today.slice(0, 4))
  const next = (opens: string) => (today > `${year}-${opens}` ? `${year + 1}-${opens}` : `${year}-${opens}`)
  if (group === 'it') {
    return [{ form_code: 'ITR', opens: ITR_OPENS, due: null, next_opens_on: next(ITR_OPENS), covers_fy: runFy(Number(next(ITR_OPENS).slice(0, 4))) }]
  }
  return ANNUAL_RUNS.filter((r) => r.group === group).map((r) => ({
    form_code: r.formCode, opens: r.opens, due: r.due, next_opens_on: next(r.opens), covers_fy: runFy(Number(next(r.opens).slice(0, 4))),
  }))
}
