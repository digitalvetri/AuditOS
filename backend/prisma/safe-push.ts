/**
 * Non-destructive schema sync — what the Docker `migrate` step runs instead
 * of a bare `prisma db push`.
 *
 * `db push` refuses (or, with --accept-data-loss, obeys) any change that
 * drops data. That made one stale table — e.g. the Books* tables left over
 * after the Books module was removed from the schema — block every deploy.
 * This script diffs the live database against prisma/schema.prisma and:
 *
 *   applies   CREATE TABLE / INDEX / TYPE, ADD COLUMN, ADD CONSTRAINT,
 *             and other additive statements
 *   skips     DROP TABLE for tables the schema no longer has, plus every
 *             statement touching those tables — they stay, with their data,
 *             and are listed in the output so someone can drop them on purpose
 *   refuses   anything destructive on a table the schema still uses
 *             (DROP COLUMN, column type change, DROP of a live index/enum…) —
 *             exits 1 with the statements, so it gets a deliberate migration
 *
 *   npx tsx prisma/safe-push.ts            apply
 *   npx tsx prisma/safe-push.ts --dry-run  print the plan, change nothing
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dryRun = process.argv.includes('--dry-run')
const url = process.env.DATABASE_URL
if (!url) {
  console.error('[safe-push] DATABASE_URL is not set.')
  process.exit(1)
}
const prismaBin = path.resolve(process.cwd(), 'node_modules', '.bin', 'prisma')
const prisma = (args: string[], input?: string) =>
  execFileSync(prismaBin, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'inherit'] })

const diff = prisma([
  'migrate', 'diff', '--from-url', url, '--to-schema-datamodel', 'prisma/schema.prisma', '--script',
])

// Prisma emits one statement per `;` at line end; bodies never contain `;\n`.
const statements = diff
  .split(/;\s*\n/)
  .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
  .filter(Boolean)

const tableOf = (s: string) => s.match(/^(?:ALTER|DROP) TABLE (?:IF EXISTS )?"([^"]+)"/i)?.[1] ?? null
const dropped = new Set(statements.map((s) => s.match(/^DROP TABLE (?:IF EXISTS )?"([^"]+)"/i)?.[1]).filter(Boolean) as string[])

const apply: string[] = []
const skipped: string[] = []
const refused: string[] = []
for (const s of statements) {
  const t = tableOf(s)
  if (t && dropped.has(t)) { skipped.push(s); continue }
  // An index on a stale table is dropped by name, without its table.
  if (/^DROP INDEX/i.test(s) && [...dropped].some((d) => s.includes(`"${d}_`))) { skipped.push(s); continue }
  const destructive =
    /^DROP (TABLE|INDEX|TYPE|VIEW|SEQUENCE)/i.test(s) ||
    /\bDROP COLUMN\b/i.test(s) ||
    /\bALTER COLUMN\b[^,]*\bTYPE\b/i.test(s) ||
    /\bSET NOT NULL\b/i.test(s)
  // Dropping a foreign key or a default is safe — it never removes rows.
  if (destructive && !/\bDROP CONSTRAINT\b/i.test(s)) refused.push(s)
  else apply.push(s)
}

const head = (s: string) => s.split('\n')[0].slice(0, 110)
if (dropped.size) {
  console.log(`[safe-push] ${dropped.size} table(s) are no longer in the schema and were LEFT IN PLACE with their data:`)
  console.log(`            ${[...dropped].join(', ')}`)
  console.log('            Drop them deliberately once nobody needs the data.')
}
if (refused.length) {
  console.error(`[safe-push] REFUSED — ${refused.length} destructive change(s) to tables still in the schema:`)
  for (const s of refused) console.error(`            ${head(s)}`)
  console.error('            Apply these on purpose (reviewed SQL or `prisma db push --accept-data-loss`).')
  process.exit(1)
}
if (!apply.length) {
  console.log('[safe-push] Database already matches the schema (additive changes).')
  process.exit(0)
}
console.log(`[safe-push] ${dryRun ? 'Would apply' : 'Applying'} ${apply.length} statement(s):`)
for (const s of apply) console.log(`            ${head(s)}`)
if (dryRun) process.exit(0)

const dir = mkdtempSync(path.join(tmpdir(), 'safe-push-'))
try {
  const file = path.join(dir, 'apply.sql')
  // One transaction: all of it lands, or none of it does.
  writeFileSync(file, `BEGIN;\n${apply.map((s) => `${s};`).join('\n')}\nCOMMIT;\n`)
  prisma(['db', 'execute', '--url', url, '--file', file])
  console.log('[safe-push] Done.')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
