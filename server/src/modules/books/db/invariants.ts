import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PrismaClient } from '@prisma/client'

/**
 * Apply the Books database invariants (triggers). PostgreSQL uses
 * DROP+CREATE, so this is idempotent — safe to call at API start-up, from
 * the seed and from the test harness.
 */
export async function applyBooksInvariants(prisma: PrismaClient): Promise<number> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const file = path.resolve(here, '../../../../prisma/sql', 'books-invariants.postgresql.sql')
  const sql = fs.readFileSync(file, 'utf8')
  const statements = sql
    .split(/^\s*-- @@\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean)
  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement)
  }
  return statements.length
}
