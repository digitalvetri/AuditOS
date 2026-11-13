/**
 * Ad-hoc verification: run the Repo tool against the sample MTR CSV and
 * byte-compare the output against the reference R1_*.json. Used once to
 * confirm Repotic-parity. Not part of the test suite (vitest needs a DB
 * for global setup; this converter is pure and has no DB dependency).
 *
 *   npx tsx scripts/verify-repo-tool.ts <csv-path> <reference-json-path>
 */
import fs from 'node:fs'
import path from 'node:path'
import { convertAmazonMtrCsv } from '../src/modules/tools/services/tools/RepoService.js'

const [, , csvPath, refPath] = process.argv
if (!csvPath || !refPath) {
  console.error('Usage: npx tsx scripts/verify-repo-tool.ts <csv-path> <reference-json-path>')
  process.exit(2)
}

const csv = fs.readFileSync(csvPath, 'utf8')
const result = convertAmazonMtrCsv(csv)
const ours = JSON.parse(result.bytes.toString('utf8'))
const theirs = JSON.parse(fs.readFileSync(refPath, 'utf8'))

console.log('── Output ────────────────────────────────────────────')
console.log(`filename : ${result.filename}`)
console.log(`gstin    : ${result.gstin}`)
console.log(`period   : ${result.period}`)
console.log(`rows total / incl / excl : ${result.rowsTotal} / ${result.rowsIncluded} / ${JSON.stringify(result.rowsExcluded)}`)
if (result.warnings.length) console.log(`warnings : ${result.warnings.join('; ')}`)

console.log('\n── Diff vs reference ────────────────────────────────')
function diff(a: unknown, b: unknown, pathStr = ''): string[] {
  const out: string[] = []
  if (a === b) return out
  if (typeof a !== typeof b) return [`${pathStr}: type ${typeof a} vs ${typeof b}`]
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return [`${pathStr}: array vs object`]
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) out.push(`${pathStr}: length ${a.length} vs ${b.length}`)
      for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...diff(a[i], b[i], `${pathStr}[${i}]`))
      return out
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) out.push(...diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], pathStr ? `${pathStr}.${k}` : k))
    return out
  }
  return [`${pathStr}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`]
}

const diffs = diff(ours, theirs)
if (!diffs.length) {
  console.log('IDENTICAL — every field in every section matches the reference.')
  process.exit(0)
}
for (const d of diffs) console.log('  ' + d)
console.log(`\n${diffs.length} difference${diffs.length === 1 ? '' : 's'}.`)
process.exit(1)
