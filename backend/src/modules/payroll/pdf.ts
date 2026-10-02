import PDFDocument from 'pdfkit'
import type { Response } from 'express'
import type { Employee, Department, Designation, PayrollItem, PayrollRun, Payslip } from '@prisma/client'
import { amountInWords, formatINR } from '../../lib/money.js'
import { fmtDate, fmtDateTime, monthLabel } from '../../lib/dates.js'
import { MOCK_PAYMENT_NOTICE } from '../../platform/constants.js'
import type { PayrollDeductions, PayrollEarnings } from '../../domain/payroll/calc.js'

/**
 * Payslip PDF (§8.4). The line-by-line "working" is the point: every figure
 * on the payslip states the basis it came from, so an employee can check it
 * without asking Finance.
 */
interface PayslipRow extends Payslip {
  employee: Employee & { department: Department; designation: Designation }
  payrollItem: PayrollItem
  payrollRun: PayrollRun
}

interface Line { name: string; basis: string; amountPaise: number }

const INK = '#1a1a1a'
const MUTED = '#6b7280'
const RULE = '#d4d4d8'

function earningLines(e: PayrollEarnings, payableDays: number, lopDays: number): Line[] {
  const lines: Line[] = [
    { name: 'Basic', basis: 'Monthly basic per salary structure', amountPaise: e.basic_paise },
    { name: 'House Rent Allowance', basis: '40% of basic', amountPaise: e.hra_paise },
    { name: 'Conveyance', basis: 'Fixed monthly allowance', amountPaise: e.conveyance_paise },
    { name: 'Special allowance', basis: 'Balancing component of monthly CTC', amountPaise: e.special_paise },
  ]
  if (e.incentive_paise) {
    lines.push({ name: 'Incentive', basis: 'Approved for this period', amountPaise: e.incentive_paise })
  }
  for (const c of e.other ?? []) {
    lines.push({ name: c.label, basis: `Custom component ${c.code}`, amountPaise: c.amount_paise })
  }
  if (lopDays > 0) {
    lines.push({
      name: 'Less: Loss of pay',
      basis: `${lopDays} of ${payableDays} payable days`,
      amountPaise: 0,
    })
  }
  return lines.filter((l) => l.amountPaise !== 0 || l.name.startsWith('Less'))
}

function deductionLines(d: PayrollDeductions, payableDays: number, lopDays: number): Line[] {
  const lines: Line[] = [
    { name: 'Provident Fund (employee)', basis: 'Statutory rate on basic, capped at the wage ceiling', amountPaise: d.pf_employee_paise },
    { name: 'ESI (employee)', basis: 'Statutory rate on gross, within the threshold', amountPaise: d.esi_employee_paise },
    { name: 'Professional Tax', basis: 'Tamil Nadu half-yearly slab', amountPaise: d.pt_paise },
    { name: 'TDS', basis: 'Declared tax deduction', amountPaise: d.tds_paise },
    { name: 'Advance recovery', basis: 'Recovery against an employee advance', amountPaise: d.advance_paise },
  ]
  if (d.lop_paise) {
    lines.push({
      name: 'Loss of pay',
      basis: `${lopDays} of ${payableDays} payable days — already netted off gross`,
      amountPaise: d.lop_paise,
    })
  }
  for (const c of d.other ?? []) {
    lines.push({ name: c.label, basis: `Custom component ${c.code}`, amountPaise: c.amount_paise })
  }
  return lines.filter((l) => l.amountPaise !== 0)
}

export function streamPayslipPdf(res: Response, p: PayslipRow) {
  const earnings = JSON.parse(p.payrollItem.earningsJson) as PayrollEarnings
  const deductions = JSON.parse(p.payrollItem.deductionsJson) as PayrollDeductions
  const payableDays = p.payrollItem.payableDays
  const lopDays = p.payrollItem.lopDays

  const doc = new PDFDocument({ size: 'A4', margin: 48 })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="${p.payslipNo}.pdf"`)
  doc.pipe(res)

  doc.fillColor(INK).fontSize(16).font('Helvetica-Bold').text('AUDIT OS')
  doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(`Payslip · ${p.payslipNo}`)
  doc.moveDown(0.8)
  doc.fillColor(INK).fontSize(12).font('Helvetica-Bold')
    .text(`Pay period: ${monthLabel(p.payrollRun.periodStart)}`)
  doc.moveDown(0.5)
  rule(doc)

  doc.moveDown(0.6)
  const left = doc.page.margins.left
  const colTwo = 300
  const top = doc.y
  label(doc, 'Employee', left); value(doc, p.employee.fullName, left)
  label(doc, 'Employee ID', left); value(doc, p.employee.employeeCode, left)
  const afterLeft = doc.y
  doc.y = top
  label(doc, 'Department', colTwo); value(doc, p.employee.department.name, colTwo)
  label(doc, 'Designation', colTwo); value(doc, p.employee.designation.name, colTwo)
  doc.y = Math.max(afterLeft, doc.y)

  doc.moveDown(0.4)
  rule(doc)
  doc.moveDown(0.4)
  doc.fontSize(9).fillColor(MUTED).font('Helvetica').text(
    `Payable days ${payableDays}   ·   Present ${p.payrollItem.presentDays}   ·   Leave ${p.payrollItem.onLeaveDays}   ·   LOP ${lopDays}`,
  )
  doc.moveDown(0.6)

  section(doc, 'Earnings', earningLines(earnings, payableDays, lopDays))
  doc.moveDown(0.4)
  section(doc, 'Deductions', deductionLines(deductions, payableDays, lopDays))

  doc.moveDown(0.6)
  rule(doc)
  doc.moveDown(0.5)
  totalRow(doc, 'Gross earnings', p.payrollItem.grossPaise)
  totalRow(doc, 'Total deductions', p.payrollItem.totalDeductionsPaise)
  doc.moveDown(0.2)
  totalRow(doc, 'Net pay', p.payrollItem.netPaise, true)
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
  doc.moveDown(0.3)
  doc.text(amountInWords(p.payrollItem.netPaise))

  if (p.payrollItem.gratuityAccrualPaise) {
    doc.moveDown(0.4)
    doc.fontSize(8).fillColor(MUTED).text(
      `Gratuity accrued this month (employer liability, not paid out): ${formatINR(p.payrollItem.gratuityAccrualPaise)}`,
    )
  }

  doc.moveDown(1)
  rule(doc)
  doc.moveDown(0.5)
  doc.fontSize(8).fillColor(MUTED)
  doc.text(`Published ${fmtDateTime(p.publishedAt)}   ·   ${MOCK_PAYMENT_NOTICE}`)
  doc.text(`Generated ${fmtDate(new Date())} · This document is computer generated.`)

  doc.end()
}

function rule(doc: PDFKit.PDFDocument) {
  doc.strokeColor(RULE).lineWidth(0.5)
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .stroke()
}
function label(doc: PDFKit.PDFDocument, text: string, x: number) {
  doc.fontSize(7.5).fillColor(MUTED).font('Helvetica')
    .text(text.toUpperCase(), x, doc.y, { characterSpacing: 0.5 })
}
function value(doc: PDFKit.PDFDocument, text: string, x: number) {
  doc.fontSize(10).fillColor(INK).font('Helvetica').text(text, x, doc.y)
  doc.moveDown(0.35)
}
function section(doc: PDFKit.PDFDocument, title: string, lines: Line[]) {
  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  doc.fontSize(9).font('Helvetica-Bold').fillColor(INK).text(title, left, doc.y)
  doc.moveDown(0.3)
  for (const line of lines) {
    const y = doc.y
    doc.fontSize(9.5).font('Helvetica').fillColor(INK).text(line.name, left, y, { width: 260 })
    doc.text(formatINR(line.amountPaise), right - 140, y, { width: 140, align: 'right' })
    doc.fontSize(7.5).fillColor(MUTED).text(line.basis, left + 8, doc.y, { width: 330 })
    doc.moveDown(0.25)
  }
}
function totalRow(doc: PDFKit.PDFDocument, title: string, paise: number, strong = false) {
  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const y = doc.y
  doc.fillColor(INK).fontSize(strong ? 12 : 10).font(strong ? 'Helvetica-Bold' : 'Helvetica')
  doc.text(title, left, y)
  doc.text(formatINR(paise), right - 160, y, { width: 160, align: 'right' })
  doc.moveDown(0.3)
}
