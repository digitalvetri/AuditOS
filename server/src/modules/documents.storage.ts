import path from 'node:path'
import crypto from 'node:crypto'
import { LocalStorageAdapter } from './tools/storage/LocalStorageAdapter.js'
import type { StorageAdapter } from './tools/storage/StorageAdapter.js'
import { sniffDocument, sniffImage } from './messages/attachments.js'

/**
 * HRMS DOCUMENT FILES — storage and type checks for Documents uploads.
 *
 * Employee documents get their own storage root (EMPLOYEE_DOCS_STORAGE_ROOT,
 * default server/uploads/employee-documents). Keys are server-generated;
 * the only reader is the signed download route.
 */
const root = process.env.EMPLOYEE_DOCS_STORAGE_ROOT
  ? path.resolve(process.env.EMPLOYEE_DOCS_STORAGE_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'employee-documents')

export const employeeDocStorage: StorageAdapter = new LocalStorageAdapter(root)

export const MAX_EMPLOYEE_DOC_MB = 15

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

/**
 * Accept PDF, Word, Excel, PowerPoint, CSV / text, zip and PNG / JPEG / WebP /
 * GIF — decided by the bytes, not the browser's declared type. Returns the
 * extension and MIME to store and serve, or null.
 */
export function checkEmployeeDocument(bytes: Buffer, filename: string): { ext: string; mime: string } | null {
  const image = sniffImage(bytes)
  if (image) return { ext: IMAGE_EXT[image], mime: image }
  return sniffDocument(bytes, filename)
}

export function employeeDocKey(employeeId: string, ext: string): string {
  return `${employeeId}/${crypto.randomUUID()}.${ext}`
}
