import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * One throwaway SQLite database for the whole test run: pushed from the
 * schema, then the Books invariants applied. Tests never touch dev.db.
 */
export const TEST_DB = path.resolve(process.cwd(), 'prisma', 'books-test.db')

export default async function setup() {
  for (const f of [TEST_DB, `${TEST_DB}-journal`]) if (fs.existsSync(f)) fs.unlinkSync(f)
  const env = { ...process.env, DATABASE_URL: `file:./books-test.db` }
  execSync('npx prisma db push --skip-generate --accept-data-loss', { cwd: process.cwd(), env, stdio: 'pipe' })
  process.env.DATABASE_URL = 'file:./books-test.db'
  const { PrismaClient } = await import('@prisma/client')
  const { applyBooksInvariants } = await import('../db/invariants.js')
  const prisma = new PrismaClient({ datasources: { db: { url: 'file:./books-test.db' } } })
  await applyBooksInvariants(prisma)
  await prisma.$disconnect()
}
