import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import { can, type Session } from '../../../platform/auth.js'

/**
 * AaJob — the pipeline row for one uploaded statement. Status walks
 * queued → extracting → extracted | failed.
 *
 * This slice's "extractor" is a stub — see markExtractedStub() below —
 * that just moves the job to `extracted` after a brief delay so the
 * pipeline is exercisable end-to-end. Row extraction, balance-chain
 * reconciliation and the review UI are follow-on slices.
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
  }
}

async function scopedWhere(session: Session, base: object) {
  const { organisationId } = await prisma.user.findUniqueOrThrow({
    where: { id: session.userId },
    select: { organisationId: true },
  })
  // Organisation scope reads everyone's jobs; self scope reads own only.
  if (can(session, 'tools.audit_automation.access', 'organisation')) {
    return { ...base, organisationId }
  }
  return { ...base, organisationId, createdByUserId: session.userId }
}

export const AaJobService = {
  toApi,

  async get(session: Session, id: string): Promise<AaJobApi> {
    const where = await scopedWhere(session, { id })
    const row = await prisma.aaJob.findFirst({ where })
    if (!row) throw ApiError.notFound('No such job.')
    return toApi(row)
  },

  async listForClient(session: Session, clientId: string): Promise<AaJobApi[]> {
    const where = await scopedWhere(session, { clientId })
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
  }): Promise<AaJobApi> {
    const row = await prisma.aaJob.create({
      data: {
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
   * Stub extractor for this slice. Simulates the pipeline reaching the
   * extraction stage without actually parsing rows — that lands with the
   * bank adapters (follow-on slice).
   *
   * Fire-and-forget: the route creates the job (returning 202) and this
   * runs after a brief delay so the client's poll sees the transition.
   */
  scheduleStubExtraction(jobId: string, delayMs = 1200): void {
    setTimeout(() => {
      void (async () => {
        try {
          const started = new Date()
          await prisma.aaJob.update({
            where: { id: jobId },
            data: { status: 'extracting', progress: 50, startedAt: started },
          })
          const completed = new Date()
          await prisma.aaJob.update({
            where: { id: jobId },
            data: { status: 'extracted', progress: 100, completedAt: completed },
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'stub extraction failed'
          try {
            await prisma.aaJob.update({
              where: { id: jobId },
              data: { status: 'failed', errorMessage: msg, completedAt: new Date() },
            })
          } catch { /* audit table write failure is not user-facing */ }
        }
      })()
    }, delayMs)
  },
}
