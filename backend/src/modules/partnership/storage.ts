import path from 'node:path'
import { LocalStorageAdapter } from '../tools/storage/LocalStorageAdapter.js'
import type { StorageAdapter } from '../tools/storage/StorageAdapter.js'

/**
 * Bytes behind Partnership Registration uploads. The record of each file is a
 * ClientDocumentVersion (the client's one document store); this is only where
 * its bytes sit. Under uploads/, which Docker persists in `auditos-uploads`.
 *
 * PFR_STORAGE_ROOT overrides the root.
 */
const root = process.env.PFR_STORAGE_ROOT
  ? path.resolve(process.env.PFR_STORAGE_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'registration-documents')

export const partnershipStorage: StorageAdapter = new LocalStorageAdapter(root)

/** `<caseId>/<documentId>/v<n>-<safe name>` — the adapter only accepts A-Za-z0-9._-/ */
export function fileKey(caseId: string, documentId: string, version: number, originalName: string): string {
  const safe = originalName.replace(/[^A-Za-z0-9._\-]/g, '_').slice(-120)
  return `${caseId}/${documentId}/v${version}-${safe}`
}

/** What the firm collects: scans (PDF/JPEG per the source PDF), images and Word files. */
export const ALLOWED_EXTENSIONS = ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'] as const
export const MAX_UPLOAD_MB = 25

export const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
}
