import path from 'node:path'
import { LocalStorageAdapter } from '../tools/storage/LocalStorageAdapter.js'
import type { StorageAdapter } from '../tools/storage/StorageAdapter.js'

/**
 * Storage adapter for BookkeepingImport files.
 *
 * The Bookkeeping Service module (the checklist / workflow tracker) was
 * removed in PR #70, but its Prisma tables were intentionally left in
 * place — see the PR description: any rows on `BookkeepingImport` still
 * point at files on disk at `uploads/bookkeeping-imports/…`, and two
 * workstation routes (client-folders download + client-merge merge)
 * still need to read those bytes for existing client-attached history.
 *
 * So the adapter has been rehosted here — the shortest possible
 * standalone module — rather than reintroducing the whole deleted
 * directory. When the tables are finally dropped (a future migration),
 * this file and its two call sites can go together.
 *
 * BK_IMPORT_STORAGE_ROOT overrides the local root; default is
 * backend/uploads/bookkeeping-imports.
 */
const root = process.env.BK_IMPORT_STORAGE_ROOT
  ? path.resolve(process.env.BK_IMPORT_STORAGE_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'bookkeeping-imports')

export const bookkeepingImportStorage: StorageAdapter = new LocalStorageAdapter(root)
