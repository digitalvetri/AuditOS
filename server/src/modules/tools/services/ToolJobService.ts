import type { Prisma } from '@prisma/client'
import { prisma } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { documentScope } from './DocumentService.js'

/**
 * ToolJobService — every tool run is one ToolJob row, created before any
 * work starts and closed with either an output document or a stored error.
 * The runner reports progress through `progress()`, throttled so a page-by-
 * page converter does not hammer SQLite.
 */
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed'

const include = { tool: true, outputDocument: true, inputDocument: true }
export type ToolJobRow = Prisma.ToolJobGetPayload<{ include: typeof include }>

const lastWritten = new Map<string, number>()

export const ToolJobService = {
  async createJob(input: {
    session: Session
    organisationId: string
    toolId: string
    inputDocumentId: string | null
    meta: Record<string, unknown>
  }): Promise<ToolJobRow> {
    return prisma.toolJob.create({
      data: {
        toolId: input.toolId,
        userId: input.session.userId,
        organisationId: input.organisationId,
        inputDocumentId: input.inputDocumentId,
        status: 'queued',
        metaJson: JSON.stringify(input.meta),
      },
      include,
    })
  },

  async updateStatus(jobId: string, status: JobStatus, extra: Partial<{ progress: number; errorMessage: string | null }> = {}): Promise<void> {
    await prisma.toolJob.update({
      where: { id: jobId },
      data: {
        status,
        ...(extra.progress !== undefined ? { progress: extra.progress } : {}),
        ...(extra.errorMessage !== undefined ? { errorMessage: extra.errorMessage } : {}),
        ...(status === 'processing' ? { startedAt: new Date() } : {}),
      },
    })
  },

  async progress(jobId: string, pct: number): Promise<void> {
    const clamped = Math.max(0, Math.min(99, Math.round(pct)))
    const prev = lastWritten.get(jobId) ?? -1
    if (clamped - prev < 2) return
    lastWritten.set(jobId, clamped)
    await prisma.toolJob.update({ where: { id: jobId }, data: { progress: clamped } }).catch(() => undefined)
  },

  async completeJob(jobId: string, outputDocumentId: string, meta: Record<string, unknown>): Promise<ToolJobRow> {
    lastWritten.delete(jobId)
    const job = await prisma.toolJob.findUniqueOrThrow({ where: { id: jobId } })
    const merged = { ...(job.metaJson ? JSON.parse(job.metaJson) : {}), ...meta }
    return prisma.toolJob.update({
      where: { id: jobId },
      data: { status: 'completed', progress: 100, outputDocumentId, completedAt: new Date(), metaJson: JSON.stringify(merged) },
      include,
    })
  },

  async failJob(jobId: string, errorMessage: string, outputDocumentId: string | null, meta: Record<string, unknown> = {}): Promise<ToolJobRow> {
    lastWritten.delete(jobId)
    const job = await prisma.toolJob.findUniqueOrThrow({ where: { id: jobId } })
    const merged = { ...(job.metaJson ? JSON.parse(job.metaJson) : {}), ...meta }
    return prisma.toolJob.update({
      where: { id: jobId },
      data: { status: 'failed', errorMessage, outputDocumentId, completedAt: new Date(), metaJson: JSON.stringify(merged) },
      include,
    })
  },

  async getJob(session: Session, jobId: string): Promise<ToolJobRow> {
    const scope = documentScope(session)
    if (scope === 'blocked') throw ApiError.forbidden()
    const job = await prisma.toolJob.findFirst({
      where: { id: jobId, ...(scope === 'self' ? { userId: session.userId } : {}) },
      include,
    })
    if (!job) throw ApiError.notFound('Job not found.')
    return job
  },

  async jobsForDocument(documentId: string): Promise<ToolJobRow[]> {
    return prisma.toolJob.findMany({
      where: { OR: [{ outputDocumentId: documentId }, { inputDocumentId: documentId }] },
      include, orderBy: { createdAt: 'desc' },
    })
  },
}
