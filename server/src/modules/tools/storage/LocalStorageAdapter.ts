import fs from 'node:fs/promises'
import path from 'node:path'
import type { StorageAdapter, StoredObject } from './StorageAdapter.js'

/**
 * Development adapter — the server's own filesystem under `server/uploads/`
 * (git-ignored). NOT browser localStorage; nothing the Tools module produces
 * ever lives only in the browser.
 *
 * Keys are validated against traversal before they touch the disk, so even a
 * bug upstream that let a client string reach `put` could not escape the root.
 */
export class LocalStorageAdapter implements StorageAdapter {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    if (!/^[A-Za-z0-9._\-\/]+$/.test(key) || key.includes('..') || key.startsWith('/')) {
      throw new Error(`Invalid storage key: ${key}`)
    }
    const abs = path.resolve(this.root, key)
    if (!abs.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error(`Storage key escapes root: ${key}`)
    }
    return abs
  }

  async put(key: string, bytes: Buffer): Promise<StoredObject> {
    const abs = this.resolve(key)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, bytes)
    return { key, size: bytes.length }
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key))
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key))
      return true
    } catch {
      return false
    }
  }

  async localPath(key: string): Promise<string | null> {
    const abs = this.resolve(key)
    return (await this.exists(key)) ? abs : null
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(key))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  async getSignedUrl(_key: string, opts: { ttlSeconds: number; url: string }): Promise<string> {
    // The application's own HMAC-signed route serves local files; the
    // caller already minted `url` with signResource(). Nothing to add.
    return opts.url
  }
}
