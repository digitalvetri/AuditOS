import path from 'node:path'
import { LocalStorageAdapter } from '../tools/storage/LocalStorageAdapter.js'
import type { StorageAdapter } from '../tools/storage/StorageAdapter.js'

/**
 * Storage for the append-only BookkeepingImport files (spec §4.2 / §6.4).
 *
 * We deliberately keep imports on their OWN root — bookkeeping-imports/ —
 * separate from Documents (which is client-authored file custody) and from
 * Audit Automation (which extracts data from raw PDFs). Each row on
 * BookkeepingImport carries a `storagePath` key resolved by this adapter.
 *
 * Files land at `<periodId>/<importId>-<originalFilename>` so a directory
 * listing groups every import by period, and re-imports naturally sort by
 * time inside a period. Swap the adapter here to move to S3 without
 * touching any service or route.
 *
 * BK_IMPORT_STORAGE_ROOT overrides the local root; default is
 * server/uploads/bookkeeping-imports.
 */
const root = process.env.BK_IMPORT_STORAGE_ROOT
  ? path.resolve(process.env.BK_IMPORT_STORAGE_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'bookkeeping-imports')

export const bookkeepingImportStorage: StorageAdapter = new LocalStorageAdapter(root)

/** Build the key used to store the file for one import row. */
export function importStorageKey(input: {
  periodId: string
  importId: string
  originalFilename: string
}): string {
  // The regex on LocalStorageAdapter allows `A-Za-z0-9._\-\/`. Anything else
  // in a user-supplied filename gets flattened to `_` so a Tally export
  // named "Sales Bill 22-08.xlsx" is stored intact but safely.
  const safeName = input.originalFilename.replace(/[^A-Za-z0-9._\-]/g, '_')
  return `${input.periodId}/${input.importId}-${safeName}`
}
