import type { ToolDocumentRow } from './services/DocumentService.js'
import type { ToolJobRow } from './services/ToolJobService.js'
import { getTool } from './registry.js'

/**
 * Prisma rows → the snake_case shapes the React client consumes. Same
 * convention as src/api/serialize.ts: the translation lives here only.
 */
function parseJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try { return JSON.parse(raw) as Record<string, unknown> } catch { return {} }
}

export function fileTypeOf(mime: string): 'pdf' | 'excel' | 'word' | 'csv' | 'image' | 'text' | 'zip' | 'other' {
  if (mime === 'application/pdf') return 'pdf'
  if (mime.includes('spreadsheetml') || mime === 'application/vnd.ms-excel') return 'excel'
  if (mime.includes('wordprocessingml')) return 'word'
  if (mime === 'text/csv' || mime === 'text/tab-separated-values') return 'csv'
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'text/plain') return 'text'
  if (mime === 'application/zip') return 'zip'
  return 'other'
}

export function toolDocumentToApi(d: ToolDocumentRow) {
  const tool = d.sourceTool ? getTool(d.sourceTool) : undefined
  const job = d.outputJobs?.[0]
  return {
    id: d.id,
    kind: d.kind as 'input' | 'output',
    filename: d.originalFilename,
    mime_type: d.mimeType,
    file_type: fileTypeOf(d.mimeType),
    file_size: d.fileSize,
    tool_id: d.sourceTool,
    tool_name: tool?.name ?? null,
    parent_document_id: d.parentDocumentId,
    status: d.status as 'processing' | 'completed' | 'failed',
    error_message: d.errorMessage,
    meta: parseJson(d.metaJson),
    created_at: d.createdAt.toISOString(),
    created_by: {
      id: d.user.id,
      label: d.user.employee?.fullName ?? d.user.email,
    },
    job_id: job?.id ?? null,
  }
}

export function toolJobToApi(j: ToolJobRow) {
  return {
    id: j.id,
    tool_id: j.toolId,
    tool_name: j.tool.name,
    status: j.status as 'queued' | 'processing' | 'completed' | 'failed',
    progress: j.progress,
    error_message: j.errorMessage,
    input_document_id: j.inputDocumentId,
    output_document_id: j.outputDocumentId,
    meta: parseJson(j.metaJson),
    started_at: j.startedAt?.toISOString() ?? null,
    completed_at: j.completedAt?.toISOString() ?? null,
    created_at: j.createdAt.toISOString(),
  }
}
