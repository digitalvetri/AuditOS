import ExcelJS from 'exceljs'

/**
 * FINANCE MIS — file exports. JSON carries money in paise; the files carry
 * rupees with two decimals, because that is what an accountant pastes into
 * a working.
 */

export type ColumnType = 'text' | 'money' | 'number' | 'percent' | 'hours' | 'boolean'

export interface ReportColumn {
  key: string
  label: string
  type: ColumnType
}

export interface FinanceReport {
  report: string
  title: string
  from: string
  to: string
  columns: ReportColumn[]
  rows: Record<string, unknown>[]
  totals: Record<string, unknown> | null
  notes: string[]
}

function cellValue(col: ReportColumn, v: unknown): string | number | null {
  if (v === null || v === undefined) return null
  if (col.type === 'money') return typeof v === 'number' ? Math.round(v) / 100 : null
  if (col.type === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number' || typeof v === 'string') return v
  return String(v)
}

function headerLabel(col: ReportColumn): string {
  if (col.type === 'money') return `${col.label} (Rs)`
  if (col.type === 'percent') return `${col.label} (%)`
  return col.label
}

function csvEscape(v: string | number | null): string {
  if (v === null) return ''
  let s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v
  // Spreadsheet formula injection: a client name starting with = + - @ is
  // rendered as text, never evaluated.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function fileName(r: FinanceReport, ext: 'csv' | 'xlsx'): string {
  return `${r.report}_${r.from}_${r.to}.${ext}`
}

export function toCsv(r: FinanceReport): string {
  const lines: string[] = []
  lines.push(r.columns.map((c) => csvEscape(headerLabel(c))).join(','))
  for (const row of r.rows) lines.push(r.columns.map((c) => csvEscape(cellValue(c, row[c.key]))).join(','))
  if (r.totals) lines.push(r.columns.map((c) => csvEscape(cellValue(c, r.totals![c.key]))).join(','))
  if (r.notes.length) {
    lines.push('')
    for (const n of r.notes) lines.push(csvEscape(`Note: ${n}`))
  }
  // BOM so Excel opens the UTF-8 text (client names, ₹) correctly.
  return `﻿${lines.join('\r\n')}\r\n`
}

export async function toXlsx(r: FinanceReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'AuditOS'
  const ws = wb.addWorksheet(r.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '))
  ws.addRow([r.title])
  ws.getRow(1).font = { bold: true, size: 13 }
  ws.addRow([`Period: ${r.from} to ${r.to}`])
  ws.addRow([])
  const header = ws.addRow(r.columns.map(headerLabel))
  header.font = { bold: true }
  for (const row of r.rows) ws.addRow(r.columns.map((c) => cellValue(c, row[c.key])))
  if (r.totals) {
    const t = ws.addRow(r.columns.map((c) => cellValue(c, r.totals![c.key])))
    t.font = { bold: true }
  }
  r.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1)
    col.width = c.type === 'text' ? 28 : 16
    if (c.type === 'money') col.numFmt = '#,##0.00'
    else if (c.type === 'hours' || c.type === 'percent') col.numFmt = '0.00'
  })
  if (r.notes.length) {
    ws.addRow([])
    for (const n of r.notes) ws.addRow([`Note: ${n}`])
  }
  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}
