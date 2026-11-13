/**
 * One-shot CSV → GSTR-1 JSON convert. Reads an Amazon MTR-B2C CSV and
 * writes R1_<GSTIN>_<MM>_<YYYY>.json next to the input file.
 *
 *   npx tsx scripts/repo-convert.ts <csv-path> [<csv-path>...]
 */
import fs from 'node:fs'
import path from 'node:path'
import { convertAmazonMtrCsv } from '../src/modules/tools/services/tools/RepoService.js'

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('Usage: npx tsx scripts/repo-convert.ts <csv-path> [<csv-path>...]')
  process.exit(2)
}

for (const csvPath of args) {
  console.log(`\n── ${path.basename(csvPath)} ──`)
  try {
    const csv = fs.readFileSync(csvPath, 'utf8')
    const r = convertAmazonMtrCsv(csv)
    const outPath = path.join(path.dirname(csvPath), r.filename)
    fs.writeFileSync(outPath, r.bytes)
    console.log(`  → ${outPath}`)
    console.log(`  GSTIN   : ${r.gstin}`)
    console.log(`  Period  : ${r.period}`)
    console.log(`  Rows    : ${r.rowsIncluded} included / ${r.rowsTotal} total`)
    const excl = Object.entries(r.rowsExcluded).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(', ')
    if (excl) console.log(`  Excluded: ${excl}`)
    if (r.warnings.length) r.warnings.forEach((w) => console.log(`  ⚠  ${w}`))
    const json = JSON.parse(r.bytes.toString('utf8'))
    console.log(`  b2cs    : ${json.b2cs.length} entr${json.b2cs.length === 1 ? 'y' : 'ies'}`)
    if (json.supeco) console.log(`  supeco  : ETIN ${json.supeco.clttx[0].etin}  suppval ₹${json.supeco.clttx[0].suppval}`)
  } catch (e) {
    console.log(`  ✗ ${e instanceof Error ? e.message : e}`)
  }
}
