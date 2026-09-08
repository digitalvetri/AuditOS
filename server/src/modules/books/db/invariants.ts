import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PrismaClient } from '@prisma/client'

/**
 * Apply the Books database invariants (triggers) for the active provider.
 * Idempotent: every statement is CREATE ... IF NOT EXISTS (SQLite) or
 * DROP+CREATE (PostgreSQL). Called at API start-up, by the seed and by the
 * test harness, so the rules exist wherever the tables exist.
 */
export async function applyBooksInvariants(prisma: PrismaClient): Promise<number> {
  const provider = detectProvider()
  const here = path.dirname(fileURLToPath(import.meta.url))
  const file = path.resolve(here, '../../../../prisma/sql', `books-invariants.${provider}.sql`)
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

function detectProvider(): 'sqlite' | 'postgresql' {
  const url = process.env.DATABASE_URL ?? 'file:./dev.db'
  return url.startsWith('file:') ? 'sqlite' : 'postgresql'
}
