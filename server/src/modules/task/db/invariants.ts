import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PrismaClient } from '@prisma/client'

/**
 * Apply the Task module's database invariants — the partial unique indexes
 * that make a second open work session impossible, and the CHECK constraints
 * that keep a duration from ever being negative.
 *
 * Idempotent, so it runs at API start-up next to the Books invariants.
 */
export async function applyTaskInvariants(prisma: PrismaClient): Promise<number> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const file = path.resolve(here, '../../../../prisma/sql', 'task-invariants.postgresql.sql')
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
