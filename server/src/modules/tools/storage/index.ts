import path from 'node:path'
import { LocalStorageAdapter } from './LocalStorageAdapter.js'
import type { StorageAdapter } from './StorageAdapter.js'

/**
 * The one storage instance the Tools module uses. Swap the adapter here
 * (S3 / Supabase) and nothing in the services or routes changes.
 *
 * TOOLS_STORAGE_ROOT overrides the local root; default is server/uploads/tools.
 */
const root = process.env.TOOLS_STORAGE_ROOT
  ? path.resolve(process.env.TOOLS_STORAGE_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'tools')

export const storage: StorageAdapter = new LocalStorageAdapter(root)
export type { StorageAdapter } from './StorageAdapter.js'
