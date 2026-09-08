// Build sample inputs: an invoice-style xlsx, a letter docx, a CSV with tricky values, a PNG image.
import fs from 'node:fs/promises'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType } from 'docx'
import sharp from 'sharp'
const out = process.argv[2] ?? new URL("./fixtures/", import.meta.url).pathname
await fs.mkdir(out, { recursive: true })

const wb = new ExcelJS.Workbook()
const ws = wb.addWorksheet('Invoice')
ws.columns = [{ header: 'Invoice No', key: 'no', width: 14 }, { header: 'Date', key: 'date', width: 12 }, { header: 'Party', key: 'party', width: 28 }, { header: 'GSTIN', key: 'gstin', width: 18 }, { header: 'Taxable', key: 'taxable', width: 12 }, { header: 'GST', key: 'gst', width: 10 }, { header: 'Total', key: 'total', width: 12 }]
ws.getRow(1).font = { bold: true }
const rows = [
  ['INV-0001', '01/04/2026', 'Sharma Traders', '33AAACS1234A1Z5', 125000, 22500, 147500],
  ['INV-0002', '03/04/2026', 'Lakshmi Textiles Pvt Ltd', '33AABCL5678B1Z2', 48200.5, 8676.09, 56876.59],
  ['INV-0003', '07/04/2026', 'Murugan & Co', '33AADFM9012C1Z9', 9800, 1764, 11564],
  ['INV-0004', '12/04/2026', 'Coimbatore Engineering Works', '33AAECC3456D1Z1', 310000, 55800, 365800],
  ['INV-0005', '18/04/2026', 'Nila Foods', '33AAFCN7890E1Z7', 15250.75, 2745.14, 17995.89],
]
for (const r of rows) ws.addRow(r)
for (const r of ws.getRows(2, 6) ?? []) { r.getCell(5).numFmt = '#,##0.00'; r.getCell(6).numFmt = '#,##0.00'; r.getCell(7).numFmt = '#,##0.00' }
const ws2 = wb.addWorksheet('Summary')
ws2.addRow(['Metric', 'Value']).font = { bold: true }
ws2.addRow(['Invoices', 5]); ws2.addRow(['Total taxable', 508251.25]); ws2.addRow(['Total GST', 91485.23])
await wb.xlsx.writeFile(path.join(out, 'invoice.xlsx'))

const doc = new Document({ sections: [{ children: [
  new Paragraph({ text: 'Engagement Letter', heading: HeadingLevel.HEADING_1 }),
  new Paragraph({ children: [new TextRun('Dear Sir,')] }),
  new Paragraph({ children: [new TextRun('We refer to our discussion regarding the statutory audit of your company for the financial year 2025-26. This letter confirms the scope, responsibilities and fees agreed between us. Please sign and return a copy.')] }),
  new Paragraph({ text: 'Scope of work', heading: HeadingLevel.HEADING_2 }),
  new Paragraph({ text: 'Statutory audit under the Companies Act, 2013', bullet: { level: 0 } }),
  new Paragraph({ text: 'Tax audit under section 44AB', bullet: { level: 0 } }),
  new Paragraph({ text: 'GST annual return (GSTR-9) review', bullet: { level: 0 } }),
  new Paragraph({ text: 'Fees', heading: HeadingLevel.HEADING_2 }),
  new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
    new TableRow({ children: [new TableCell({ children: [new Paragraph('Service')] }), new TableCell({ children: [new Paragraph('Fee (₹)')] })] }),
    new TableRow({ children: [new TableCell({ children: [new Paragraph('Statutory audit')] }), new TableCell({ children: [new Paragraph('1,50,000')] })] }),
    new TableRow({ children: [new TableCell({ children: [new Paragraph('Tax audit')] }), new TableCell({ children: [new Paragraph('75,000')] })] }),
  ] }),
  new Paragraph({ children: [new TextRun('Yours faithfully,')] }),
  new Paragraph({ children: [new TextRun({ text: 'Audit OS Partners', bold: true })] }),
] }] })
await fs.writeFile(path.join(out, 'letter.docx'), await Packer.toBuffer(doc))

await fs.writeFile(path.join(out, 'ledger.csv'), [
  'Voucher No,Date,Party,GSTIN,PIN,Debit,Credit,Narration',
  '0001,01/04/2026,Sharma Traders,33AAACS1234A1Z5,600001,"1,25,000.00",,Opening',
  '0002,02/04/2026,"Lakshmi Textiles, Pvt Ltd",33AABCL5678B1Z2,641001,,"48,200.50","Payment ""on account"""',
  '0003,05/04/2026,Murugan & Co,33AADFM9012C1Z9,620001,(9800),,Reversal',
  '0004,2026-04-07,Nila Foods,33AAFCN7890E1Z7,000123,15250.75,,',
  '',
].join('\r\n'))

const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="1754"><rect width="100%" height="100%" fill="white"/><text x="80" y="160" font-family="DejaVu Sans" font-size="44" fill="black">TAX INVOICE</text><text x="80" y="260" font-family="DejaVu Sans" font-size="30" fill="black">Invoice No: INV-0042</text><text x="80" y="320" font-family="DejaVu Sans" font-size="30" fill="black">GSTIN: 33AAACS1234A1Z5</text><text x="80" y="380" font-family="DejaVu Sans" font-size="30" fill="black">Total Amount: Rs 1,47,500.00</text></svg>`)
await sharp(svg).png().toFile(path.join(out, 'scan.png'))
await sharp(svg).jpeg({ quality: 85 }).toFile(path.join(out, 'scan.jpg'))
await sharp(svg).resize(620).webp().toFile(path.join(out, 'scan.webp'))
console.log('fixtures written to', out)
