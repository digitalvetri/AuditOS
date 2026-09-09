import path from 'node:path'
import { LocalStorageAdapter } from '../tools/storage/LocalStorageAdapter.js'
import type { StorageAdapter } from '../tools/storage/StorageAdapter.js'

/**
 * The one storage instance the audit-automation module uses for extraction
 * blobs. Swap the adapter here to move to S3 / Supabase without touching
 * any service or route.
 *
 * We deliberately DO NOT store the decrypted PDF (AMENDMENT-02 §1-Gap1) —
 * only the JSON extraction blob (pdfjs TextItem[] per page with
 * coordinates). See lib/pdfInspect.ts.
 *
 * AA_STORAGE_ROOT overrides the local root; default is server/uploads/audit-automation.
 */
const root = process.env.AA_STORAGE_ROOT
  ? path.resolve(process.env.AA_STORAGE_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'audit-automation')

export const aaStorage: StorageAdapter = new LocalStorageAdapter(root)
