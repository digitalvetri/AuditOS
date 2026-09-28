/**
 * BOOKKEEPING · CLIENT DASHBOARD REPORT SERVICE (BOOKKEEPING-REBUILD §6).
 *
 * Ties the pure HTML generator (clientReportHtml.ts) to real company
 * data and to durable storage. Fetches the numbers, calls the renderer,
 * writes the resulting file under uploads/bookkeeping-client-reports/,
 * and records a BookkeepingClientReport row so the firm can re-download
 * the exact bytes that were sent to a client three months ago.
 *
 * The renderer knows nothing about Prisma. The routes know nothing about
 * disk layout. Both isolations matter — the renderer stays testable and
 * the storage adapter can move to S3 later without touching anyone else.
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import type { PrismaClient, Prisma } from '@prisma/client'
import { profitAndLoss, balanceSheet, ledgerBalances } from '../engine/balances.js'
import { ageingBucketFor, daysBetween, AGEING_BUCKETS } from '../engine/primitives.js'
import { alive } from '../../../lib/prisma.js'
import {
  renderClientReportHtml,
  type ClientReportAgeingBucket,
  type ClientReportInput,
  type ClientReportMonthlyBar,
  type ClientReportOutstandingRow,
} from './clientReportHtml.js'

const STORAGE_ROOT = process.env.BK_CLIENT_REPORTS_ROOT
  ? path.resolve(process.env.BK_CLIENT_REPORTS_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'bookkeeping-client-reports')

const ACTIVE = { status: 'active', ...alive }

export interface GenerateClientReportInput {
  companyId: string
  from: string       // YYYY-MM-DD
  to: string
  periodLabel: string
  fyLabel: string
  preparedBy: string
  firmContact: string | null
}

export interface GeneratedClientReport {
  id: string
  fileName: string
  storagePath: string
  fileSha256: string
  html: string       // returned so the endpoint can stream inline if desired
}

export async function generateClientReport(
  prisma: PrismaClient,
  input: GenerateClientReportInput,
  actorUserId: string | null,
): Promise<GeneratedClientReport> {
  const company = await prisma.bookkeepingCompany.findFirst({
    where: { id: input.companyId, ...alive },
    select: { id: true, name: true, gstin: true, address: true },
  })
  if (!company) throw new Error('Company not found or inactive.')

  const [pl, bs, receivable, payable, monthly] = await Promise.all([
    profitAndLoss(input.companyId, { from: input.from, to: input.to }),
    balanceSheet(input.companyId, { asOf: input.to, fyStart: input.from }),
    outstandings(prisma, input.companyId, 'receivable', input.to),
    outstandings(prisma, input.companyId, 'payable', input.to),
    monthlyIncomeExpense(input.companyId, input.from, input.to),
  ])

  const workingCapital = pickWorkingCapital(bs)

  const payload: ClientReportInput = {
    company: {
      name: company.name,
      gstin: company.gstin ?? null,
      addressLine: company.address ?? null,
    },
    header: {
      periodLabel: input.periodLabel,
      from: input.from,
      to: input.to,
      fyLabel: input.fyLabel,
      preparedBy: input.preparedBy,
      preparedAt: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }),
      firmContact: input.firmContact,
    },
    kpis: {
      revenuePaise: pl.income.totalPaise,
      grossProfitPaise: pl.grossProfitPaise,
      grossMarginPct: pl.income.totalPaise > 0 ? (pl.grossProfitPaise / pl.income.totalPaise) * 100 : null,
      netProfitPaise: pl.netProfitPaise,
      netMarginPct: pl.income.totalPaise > 0 ? (pl.netProfitPaise / pl.income.totalPaise) * 100 : null,
      receivablePaise: receivable.totalPaise,
      receivableCount: receivable.partyCount,
      payablePaise: payable.totalPaise,
      payableCount: payable.partyCount,
      workingCapitalPaise: workingCapital,
    },
    monthly,
    ageing: receivable.ageing,
    outstandingTop10: receivable.topTen,
    outstandingTotalPaise: receivable.totalPaise,
    outstandingBillCount: receivable.billCount,
  }

  const html = renderClientReportHtml(payload)
  const bytes = Buffer.from(html, 'utf8')
  const sha = crypto.createHash('sha256').update(bytes).digest('hex')

  // File on disk. One per report id — never overwritten so history is
  // immutable and re-download is a straight file read.
  const id = crypto.randomUUID()
  const safeCompany = company.name.replace(/[^\w-]+/g, '_').slice(0, 40) || 'company'
  const fileName = `${safeCompany}-${input.from}-to-${input.to}.html`
  const relativePath = path.posix.join(input.companyId, `${id}.html`)
  const absolutePath = path.resolve(STORAGE_ROOT, relativePath)
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, bytes)

  await prisma.bookkeepingClientReport.create({
    data: {
      id,
      tallyCompanyId: input.companyId,
      from: input.from,
      to: input.to,
      periodLabel: input.periodLabel,
      sectionsJson: {
        header: true,
        kpis: true,
        trend: monthly.length > 0,
        ageing: receivable.ageing.length > 0,
        outstanding_top10: receivable.topTen.length > 0,
      } as Prisma.InputJsonValue,
      storagePath: relativePath,
      fileName,
      fileSha256: sha,
      createdByUserId: actorUserId,
    },
  })

  return { id, fileName, storagePath: relativePath, fileSha256: sha, html }
}

/** Fetch a stored report's bytes for re-download. */
export async function readClientReportFile(storagePath: string): Promise<Buffer> {
  const abs = path.resolve(STORAGE_ROOT, storagePath)
  const root = path.resolve(STORAGE_ROOT)
  if (!abs.startsWith(root + path.sep)) throw new Error('Invalid storage path.')
  return fs.readFile(abs)
}

// ---------------------------------------------------------------------
// Outstandings compaction — reused for both sides and shape-matched to
// the ClientReportInput.
// ---------------------------------------------------------------------

interface CompactedOutstandings {
  totalPaise: number
  partyCount: number
  billCount: number
  ageing: ClientReportAgeingBucket[]
  topTen: ClientReportOutstandingRow[]
}

async function outstandings(
  prisma: PrismaClient,
  companyId: string,
  side: 'receivable' | 'payable',
  asOf: string,
): Promise<CompactedOutstandings> {
  const primaryGroup = side === 'receivable' ? 'Sundry Debtors' : 'Sundry Creditors'
  const sign = side === 'receivable' ? 1 : -1

  const balances = (await ledgerBalances(companyId, { to: asOf }))
    .filter((b) => b.primaryGroupName === primaryGroup)
    .filter((b) => b.closingPaise !== 0)

  const allocations = await prisma.bookkeepingBillAllocation.findMany({
    where: {
      tallyCompanyId: companyId,
      ledgerId: { in: balances.map((b) => b.ledgerId) },
      date: { lte: asOf },
      voucher: ACTIVE,
    },
    select: { ledgerId: true, billRef: true, method: true, amountPaise: true, dueDate: true, date: true },
  })

  interface Bill {
    billRef: string
    partyName: string
    date: string
    dueDate: string | null
    amountPaise: number
    settledPaise: number
  }
  const partyNameById = new Map(balances.map((b) => [b.ledgerId, b.ledgerName]))
  const billsByKey = new Map<string, Bill>()
  for (const a of allocations) {
    const key = `${a.ledgerId}|${a.billRef}`
    let bill = billsByKey.get(key)
    if (!bill) {
      bill = {
        billRef: a.billRef,
        partyName: partyNameById.get(a.ledgerId) ?? '',
        date: a.date,
        dueDate: a.dueDate,
        amountPaise: 0,
        settledPaise: 0,
      }
      billsByKey.set(key, bill)
    }
    if (a.method === 'new') {
      bill.amountPaise += a.amountPaise
      bill.date = a.date
      bill.dueDate = a.dueDate ?? bill.dueDate
    } else {
      bill.settledPaise += a.amountPaise
    }
  }

  const openBills = [...billsByKey.values()]
    .map((b) => {
      const pending = b.amountPaise - b.settledPaise
      const overdueBy = b.dueDate ? daysBetween(b.dueDate, asOf) : daysBetween(b.date, asOf)
      return { ...b, pending, overdueBy, bucket: ageingBucketFor(overdueBy) }
    })
    .filter((b) => b.pending !== 0)

  const buckets: Record<string, { paise: number; count: number }> = {}
  for (const b of AGEING_BUCKETS) buckets[b.key] = { paise: 0, count: 0 }
  for (const b of openBills) {
    buckets[b.bucket].paise += b.pending
    buckets[b.bucket].count += 1
  }
  const ageing: ClientReportAgeingBucket[] = AGEING_BUCKETS.map((b) => ({
    key: b.key,
    label: b.label,
    amountPaise: buckets[b.key].paise,
    invoiceCount: buckets[b.key].count,
  }))

  const topTen: ClientReportOutstandingRow[] = openBills
    .slice()
    .sort((a, b) => Math.abs(b.pending) - Math.abs(a.pending))
    .slice(0, 10)
    .map((b) => ({
      billRef: b.billRef,
      partyName: b.partyName,
      date: b.date,
      amountPaise: Math.abs(b.pending),
      daysOverdue: Math.max(b.overdueBy, 0),
    }))

  const totalPaise = balances.reduce((s, b) => s + sign * b.closingPaise, 0)
  return {
    totalPaise,
    partyCount: balances.length,
    billCount: openBills.length,
    ageing,
    topTen,
  }
}

// ---------------------------------------------------------------------
// Monthly income vs expense — iterates the P&L compute per calendar
// month within [from, to]. Cheap for ≤12-month ranges; if a range ever
// covers years, this becomes a single group-by query — not today.
// ---------------------------------------------------------------------

async function monthlyIncomeExpense(companyId: string, from: string, to: string): Promise<ClientReportMonthlyBar[]> {
  const start = new Date(from + 'T00:00:00Z')
  const end = new Date(to + 'T00:00:00Z')
  const out: ClientReportMonthlyBar[] = []
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const stop = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
  while (cur <= stop) {
    const monthStart = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), 1))
    const monthEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0))
    const fromIso = monthStart.toISOString().slice(0, 10)
    const toIso = monthEnd.toISOString().slice(0, 10)
    const pl = await profitAndLoss(companyId, { from: fromIso, to: toIso })
    const label = monthStart.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' })
    out.push({ label, incomePaise: pl.income.totalPaise, expensePaise: pl.expenses.totalPaise })
    cur.setUTCMonth(cur.getUTCMonth() + 1)
  }
  return out
}

// ---------------------------------------------------------------------
// Working-capital pick from the balance sheet groups.
// ---------------------------------------------------------------------

function pickWorkingCapital(bs: { assets: { groups: { groupName: string; amountPaise: number }[] }; liabilities: { groups: { groupName: string; amountPaise: number }[] } }): number {
  const currentAssetsNames = new Set(['Current Assets', 'Sundry Debtors', 'Cash-in-Hand', 'Bank Accounts'])
  const currentLiabNames = new Set(['Current Liabilities', 'Sundry Creditors', 'Duties & Taxes'])
  const currentAssets = bs.assets.groups
    .filter((g) => currentAssetsNames.has(g.groupName))
    .reduce((s, g) => s + g.amountPaise, 0)
  const currentLiab = bs.liabilities.groups
    .filter((g) => currentLiabNames.has(g.groupName))
    .reduce((s, g) => s + g.amountPaise, 0)
  return currentAssets - currentLiab
}
