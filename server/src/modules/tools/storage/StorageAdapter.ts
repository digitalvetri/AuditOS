/**
 * STORAGE ADAPTER — the only way file bytes enter or leave the Tools module.
 *
 * Routes and services never touch the filesystem or an object store
 * directly; they hand a key to this interface. The key is generated
 * server-side (see DocumentService) and is never a client-supplied path.
 *
 * `getSignedUrl` returns an application URL that the signed-download route
 * honours — for the local adapter that route streams the file itself; an
 * S3 / Supabase adapter may instead return the provider's own presigned URL.
 */
export interface StoredObject {
  key: string
  size: number
}

export interface StorageAdapter {
  /** Write bytes under `key`, creating any parents. Overwrites silently. */
  put(key: string, bytes: Buffer): Promise<StoredObject>
  /** Read the whole object. Throws if it does not exist. */
  get(key: string): Promise<Buffer>
  /** Does the object exist? */
  exists(key: string): Promise<boolean>
  /** Path on the local disk if the adapter has one (external tools need a path). */
  localPath(key: string): Promise<string | null>
  /** Remove the object; a missing object is not an error. */
  delete(key: string): Promise<void>
  /** A URL a browser can open for `ttlSeconds`. Never a raw public path. */
  getSignedUrl(key: string, opts: { ttlSeconds: number; url: string }): Promise<string>
}
