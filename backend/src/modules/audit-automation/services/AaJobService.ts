import type { Request } from 'express'
import { prisma } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import { can, type Session } from '../../../platform/auth.js'
import { writeAudit } from '../../../platform/audit.js'
import { aaStorage } from '../storage.js'
import { assignedClientIds, seesAllClients } from '../../../platform/workstation/scope.js'

/**
 * AaJob — the pipeline row for one uploaded statement. Status walks
 * queued → extracting → extracted | failed.
 *
 * Extraction (rows, balance chain, duplicates, ledger rules) is
 * AaExtractService; review, approval and export are AaTxnService.
 */

export type AaJobStatus = 'queued' | 'extracting' | 'extracted' | 'failed'

export interface AaJobApi {
  id: string
  source_document_id: string
  client_id: string
  status: AaJobStatus
  progress: number
  flags: string[]
  error_message: string | null
  meta: Record<string, unknown>
  created_at: string
  started_at: string | null
  completed_at: string | null
  fy: string | null
  period_from: string | null
  period_to: string | null
  opening_balance_paise: number | null
  closing_balance_paise: number | null
  row_count: number
  review_status: string
  approved_at: string | null
  bank_ledger_name: string | null
}

function parseFlags(s: string): string[] {
  return s ? s.split(',').map((f) => f.trim()).filter(Boolean) : []
}
function joinFlags(flags: string[]): string {
  return [...new Set(flags.filter(Boolean))].join(',')
}
function parseMeta(s: string | null): Record<string, unknown> {
  if (!s) return {}
  try { return JSON.parse(s) as Record<string, unknown> } catch { return {} }
}

function toApi(row: {
  id: string
  sourceDocumentId: string
  clientId: string
  status: string
  progress: number
  flags: string
  errorMessage: string | null
  metaJson: string | null
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
  fy?: string | null
  periodFrom?: string | null
  periodTo?: string | null
  openingBalancePaise?: bigint | null
  closingBalancePaise?: bigint | null
  rowCount?: number
  reviewStatus?: string
  approvedAt?: Date | null
  bankLedgerName?: string | null
}): AaJobApi {
  return {
    id: row.id,
    source_document_id: row.sourceDocumentId,
    client_id: row.clientId,
    status: row.status as AaJobStatus,
    progress: row.progress,
    flags: parseFlags(row.flags),
    error_message: row.errorMessage,
    meta: parseMeta(row.metaJson),
    created_at: row.createdAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    completed_at: row.completedAt?.toISOString() ?? null,
    fy: row.fy ?? null,
    period_from: row.periodFrom ?? null,
    period_to: row.periodTo ?? null,
    opening_balance_paise: row.openingBalancePaise == null ? null : Number(row.openingBalancePaise),
    closing_balance_paise: row.closingBalancePaise == null ? null : Number(row.closingBalancePaise),
    row_count: row.rowCount ?? 0,
    review_status: row.reviewStatus ?? 'pending',
    approved_at: row.approvedAt?.toISOString() ?? null,
    bank_ledger_name: row.bankLedgerName ?? null,
  }
}

async function scopedWhere(session: Session, base: object) {
  const { organisationId } = await prisma.user.findUniqueOrThrow({
    where: { id: session.userId },
    select: { organisationId: true },
  })
  // Organisation scope reads everyone's jobs — but only for clients the
  // caller may see (every client with clients.view_all, else the assigned
  // ones); self scope reads own only. Every job and row route goes through
  // here (AaTxnService.jobFor), so this is the one place the rule lives.
  if (can(session, 'tools.audit_automation.access', 'organisation')) {
    if (seesAllClients(session)) return { ...base, organisationId }
    const ids = await assignedClientIds(session, 'self')
    return { ...base, organisationId, AND: [{ clientId: { in: ids === 'ALL' ? [] : ids } }] }
  }
  return { ...base, organisationId, createdByUserId: session.userId }
}

export const AaJobService = {
  toApi,

  async get(session: Session, id: string): Promise<AaJobApi> {
    const where = await scopedWhere(session, { id, sourceDocument: { deletedAt: null } })
    const row = await prisma.aaJob.findFirst({ where })
    if (!row) throw ApiError.notFound('No such job.')
    return toApi(row)
  },

  async listForClient(session: Session, clientId: string): Promise<AaJobApi[]> {
    const where = await scopedWhere(session, { clientId, sourceDocument: { deletedAt: null } })
    const rows = await prisma.aaJob.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 })
    return rows.map(toApi)
  },

  async create(input: {
    sourceDocumentId: string
    organisationId: string
    clientId: string
    createdByUserId: string
    flags: string[]
    meta: Record<string, unknown>
    fy?: string | null
  }, db: Pick<typeof prisma, 'aaJob'> = prisma): Promise<AaJobApi> {
    const row = await db.aaJob.create({
      data: {
        fy: input.fy ?? null,
        sourceDocumentId: input.sourceDocumentId,
        organisationId: input.organisationId,
        clientId: input.clientId,
        createdByUserId: input.createdByUserId,
        status: 'queued',
        progress: 0,
        flags: joinFlags(input.flags),
        metaJson: JSON.stringify(input.meta),
      },
    })
    return toApi(row)
  },

  /**
   * Delete a statement: the job's rows go, the stored extraction goes, and
   * the document is soft-deleted with its hash released — so the same file
   * can be uploaded again (the per-client unique index still holds it
   * otherwise).
   */
  async remove(session: Session, id: string, req?: Request): Promise<void> {
    const job = await AaJobService.get(session, id)
    const doc = await prisma.aaSourceDocument.findUniqueOrThrow({ where: { id: job.source_document_id } })
    await prisma.$transaction([
      prisma.aaBankTxn.deleteMany({ where: { job: { sourceDocumentId: doc.id } } }),
      prisma.aaSourceDocument.update({ where: { id: doc.id }, data: { deletedAt: new Date(), fileSha256: `${doc.fileSha256}:deleted:${doc.id}` } }),
    ])
    await aaStorage.delete(doc.extractionPath).catch(() => undefined)
    await writeAudit({ actorUserId: session.userId, action: 'aa.bank.job_deleted', entityType: 'AaJob', entityId: job.id, after: { filename: doc.originalFilename, client_id: doc.clientId }, req })
  },

  /** Read the statement again (discards edits). Not for an approved statement. */
  async reprocess(session: Session, id: string, req?: Request): Promise<void> {
    const job = await AaJobService.get(session, id)
    if (job.review_status === 'approved') throw ApiError.conflict('job_approved', 'Reopen the approved statement before reading it again.')
    await prisma.aaJob.update({ where: { id: job.id }, data: { status: 'queued', progress: 0, errorMessage: null } })
    await writeAudit({ actorUserId: session.userId, action: 'aa.bank.job_reprocessed', entityType: 'AaJob', entityId: job.id, req })
    const { AaExtractService } = await import('./AaExtractService.js')
    AaExtractService.schedule(job.id)
  },

}
