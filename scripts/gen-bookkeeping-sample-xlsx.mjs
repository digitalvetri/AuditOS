/**
 * Generate docs/bookkeeping/sample-sales.xlsx — the demo file for the
 * Books → Excel import walkthrough (docs/bookkeeping/DEMO.md).
 *
 * Mirrors the KS Sales shape from BOOKKEEPING-REBUILD §1.1: three-tab
 * workbook (Sales / Purchase / Sheet3) with the real column layout
 * (blank spacer columns between logical groups). Ten rows include:
 *   • an SGD row that would flag as "S$" → SGD via the alias flow
 *   • a USD row
 *   • two INR-only rows
 *   • one row for "Loopet" — will fuzzy-match "Loopet Pte Ltd" if that
 *     ledger already exists in the target company
 *   • one row where the INR column is deliberately off by ~₹5 from
 *     foreign × rate, so the derive preview surfaces the flag
 *
 *   cd server && node ../scripts/gen-bookkeeping-sample-xlsx.mjs
 *
 * Re-run whenever the demo needs to change. The output is committed.
 */
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// ExcelJS lives in server/node_modules — this script has none of its own.
// Resolve via server/package.json so it doesn't matter where you run node from.
const require = createRequire(path.resolve(__dirname, '..', 'server', 'package.json'))
const ExcelJS = require('exceljs')
const OUT = path.resolve(__dirname, '..', 'docs', 'bookkeeping', 'sample-sales.xlsx')

const salesRows = [
  // date       inv                _     customer       description                      cur    _    foreign      _    inr        rate
  ['08/04/2025', 'INV/25-26/01', '', 'Alexandra',      'Ref-819526 Sample',              'SGD',  '',  1050.63,   '',  88524.20,  84.2582],
  ['15/04/2025', 'INV/25-26/02', '', 'Loopet',         'Development of Matte Balm',      'S$',   '',   500.00,   '',  42129.10,  84.2582],
  ['20/04/2025', 'INV/25-26/03', '', 'PinaPop',        'Consulting retainer April',      'USD',  '',  1200.00,   '',  99700.00,  83.0800],
  ['02/05/2025', 'INV/25-26/04', '', 'Andy Brar',      'Formulation review',             'INR',  '',    '',      '',  15000.00,   ''],
  ['12/05/2025', 'INV/25-26/05', '', 'Inkbolt',        'Packaging design',               'SGD',  '',   750.00,   '',  63200.00,  84.2582],
  ['20/05/2025', 'INV/25-26/06', '', 'Alexandra',      'Sample dispatch charges',        'INR',  '',    '',      '',   2500.00,   ''],
  ['05/06/2025', 'INV/25-26/07', '', 'Oh Wee P',       'Stability testing',              'USD',  '',   800.00,   '',  66500.00,  83.1250],
  ['18/06/2025', 'INV/25-26/08', '', 'PinaPop',        'Retainer May',                   'USD',  '',  1200.00,   '',  99775.00,  83.1458],
  ['02/07/2025', 'INV/25-26/09', '', 'Loopet Pte Ltd', 'Second dev cycle',               'SGD',  '',   900.00,   '',  75840.00,  84.2665],
  ['15/07/2025', 'INV/25-26/10', '', 'Inkbolt',        'Print files handover',           'INR',  '',    '',      '',   8500.00,   ''],
]

const purchaseRows = [
  ['05/04/2025', 'BILL/2025/01', '', 'PackVault',       'Packaging materials',            'INR',  '',    '',      '',  12500.00,   ''],
  ['12/04/2025', 'BILL/2025/02', '', 'ChemAssay Labs',  'Analytical testing',             'INR',  '',    '',      '',   4200.00,   ''],
  ['20/04/2025', 'BILL/2025/03', '', 'CourierPro',      'Sample dispatch — April',        'INR',  '',    '',      '',   1850.00,   ''],
  ['02/05/2025', 'BILL/2025/04', '', 'PackVault',       'Packaging — May batch',          'INR',  '',    '',      '',  18400.00,   ''],
  ['15/05/2025', 'BILL/2025/05', '', 'FreightLine',     'Air freight to Singapore',       'INR',  '',    '',      '',   9600.00,   ''],
]

function writeTab(ws, rows) {
  // A1 marks the FY the way the client's real file does.
  ws.getCell('A1').value = '25-26'
  // Row 2 is the header row so importers see logical columns easily.
  ws.getRow(2).values = [
    'Date',        // A
    'Invoice no',  // B
    '',            // C (spacer)
    'Customer',    // D  (or "Supplier" — set by caller before this call)
    'Description', // E
    'Currency',    // F
    '',            // G (spacer)
    'Foreign',     // H
    '',            // I (spacer)
    'INR',         // J
    'Rate',        // K
  ]
  rows.forEach((r, i) => {
    ws.getRow(3 + i).values = r
  })
  // Neaten column widths without being fancy.
  ws.columns.forEach((c) => { c.width = 14 })
}

async function main() {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'AuditOS demo generator'
  wb.created = new Date()

  const sales = wb.addWorksheet('Sales')
  writeTab(sales, salesRows)

  const purchase = wb.addWorksheet('Purchase')
  writeTab(purchase, purchaseRows)
  // Rename the party column header on the Purchase tab.
  purchase.getRow(2).getCell(4).value = 'Supplier'
  purchase.getRow(2).getCell(2).value = 'Bill no'

  const sheet3 = wb.addWorksheet('Sheet3')
  sheet3.getCell('A1').value = '(reserved for receipts/payments — Step 3.2 of the rebuild)'

  await wb.xlsx.writeFile(OUT)
  console.log(`Wrote ${OUT}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
