/**
 * BOOKKEEPING · CLIENT DASHBOARD REPORT SERVICE (BOOKKEEPING-REBUILD §6).
 *
 * Ties the dashboard (clientDashboardBundle.ts builds the data,
 * clientDashboardApp.ts draws the page) to durable storage: renders the
 * self-contained HTML file, writes it under
 * uploads/bookkeeping-client-reports/, and records a
 * BookkeepingClientReport row so the firm can re-download the exact bytes
 * that were sent to a client three months ago.
 *
 * The renderer knows nothing about Prisma. The routes know nothing about
 * disk layout. Both isolations matter — the renderer stays testable and
 * the storage adapter can move to S3 later without touching anyone else.
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import type { PrismaClient, Prisma } from '@prisma/client'
import { buildClientDashboardBundle } from './clientDashboardBundle.js'
import { renderClientDashboardHtml } from './clientDashboardApp.js'

const STORAGE_ROOT = process.env.BK_CLIENT_REPORTS_ROOT
  ? path.resolve(process.env.BK_CLIENT_REPORTS_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'bookkeeping-client-reports')

export interface GenerateClientReportInput {
  companyId: string
  financialYearId?: string | null
  from: string       // YYYY-MM-DD — the period the dashboard opens on
  to: string
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

/** The dashboard page for a company and financial year, not saved anywhere (the in-app view). */
export async function renderClientDashboard(prisma: PrismaClient, input: GenerateClientReportInput): Promise<string> {
  const bundle = await buildClientDashboardBundle(prisma, {
    companyId: input.companyId, financialYearId: input.financialYearId, from: input.from, to: input.to,
    preparedBy: input.preparedBy, firmContact: input.firmContact,
  })
  return renderClientDashboardHtml(bundle)
}

export async function generateClientReport(
  prisma: PrismaClient,
  input: GenerateClientReportInput,
  actorUserId: string | null,
): Promise<GeneratedClientReport> {
  // The id is fixed before rendering so the file can print its own reference.
  const id = crypto.randomUUID()
  const bundle = await buildClientDashboardBundle(prisma, {
    companyId: input.companyId, financialYearId: input.financialYearId, from: input.from, to: input.to,
    preparedBy: input.preparedBy, firmContact: input.firmContact, reportRef: `CR-${id.slice(0, 8).toUpperCase()}`,
  })
  const html = renderClientDashboardHtml(bundle)
  const bytes = Buffer.from(html, 'utf8')
  const sha = crypto.createHash('sha256').update(bytes).digest('hex')

  // File on disk. One per report id — never overwritten so history is
  // immutable and re-download is a straight file read.
  const safeCompany = bundle.company.name.replace(/[^\w-]+/g, '_').slice(0, 40) || 'company'
  const fileName = `${safeCompany}-FY${bundle.fy.label.replace(/[^\w-]+/g, '_')}-dashboard.html`
  const relativePath = path.posix.join(input.companyId, `${id}.html`)
  const absolutePath = path.resolve(STORAGE_ROOT, relativePath)
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, bytes)

  await prisma.bookkeepingClientReport.create({
    data: {
      id,
      tallyCompanyId: input.companyId,
      from: bundle.fy.start,
      to: bundle.fy.end,
      periodLabel: `FY ${bundle.fy.label}`,
      sectionsJson: {
        dashboard: true,
        opens_on: `${bundle.initial.from}..${bundle.initial.to}`,
        vouchers: bundle.vouchers.length,
        vouchers_truncated: bundle.vouchersTruncated,
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
