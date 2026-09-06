import type { Response } from 'express'
import ExcelJS from 'exceljs'
import { formatINR } from '../../lib/money.js'
import { fmtDate } from '../../lib/dates.js'
import type { ReportColumn } from './definitions.js'

/** Render one cell for export. Money and dates are formatted, not raw. */
function cell(value: unknown, type: ReportColumn['type']): string {
  if (value === null || value === undefined) return ''
  if (type === 'currency') return formatINR(Number(value))
  if (type === 'date') return typeof value === 'string' && value === '—' ? value : fmtDate(value as string)
  return String(value)
}

export function sendCsv(res: Response, name: string, columns: ReportColumn[], rows: Record<string, unknown>[]) {
  const escape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const lines = [
    columns.map((c) => escape(c.label)).join(','),
    ...rows.map((r) => columns.map((c) => escape(cell(r[c.key], c.type))).join(',')),
  ]
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`)
  // BOM so Excel opens the ₹ sign correctly.
  res.send('﻿' + lines.join('\n'))
}

export async function sendXlsx(res: Response, name: string, columns: ReportColumn[], rows: Record<string, unknown>[]) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Audit OS HRMS'
  const ws = wb.addWorksheet(name.slice(0, 28))
  ws.columns = columns.map((c) => ({
    header: c.label, key: c.key, width: Math.max(14, c.label.length + 4),
  }))
  ws.getRow(1).font = { bold: true }
  for (const r of rows) {
    ws.addRow(Object.fromEntries(columns.map((c) => [c.key, cell(r[c.key], c.type)])))
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`)
  await wb.xlsx.write(res)
  res.end()
}
