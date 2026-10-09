/**
 * Compliance calendar catalogue (docs/compliance/README.md).
 *
 * Statutory dates as of October 2026: Income-tax Act 1961 as amended by the
 * Finance Act 2026 for FY 2025-26 (tax years from 2026-27 fall under the
 * Income-tax Act 2025 — same calendar dates). Re-check each year; record a
 * one-off CBDT/CBIC/MCA extension as a DueDateExtension, a permanent change
 * as an edit here.
 *
 * Idempotent: upsert on `code`. An existing row keeps any rule a firm has
 * edited through PATCH /api/compliance/forms/:code — only name/authority/
 * frequency/entity types/sort order are refreshed on re-seed.
 */
import type { PrismaClient } from '@prisma/client'

export interface CatalogueForm {
  code: string
  name: string
  authority: 'income_tax' | 'gst' | 'mca' | 'labour' | 'other'
  frequency: 'monthly' | 'quarterly' | 'half_yearly' | 'annual' | 'event'
  entityTypes: string
  anchor: 'period_end' | 'fy_end' | 'fy_start' | 'agm' | 'event'
  offsetMonths: number
  dueDay: number | null
  offsetDays: number
  months: string | null
  lateFeeNote: string | null
  description: string | null
}

const f = (
  code: string, name: string, authority: CatalogueForm['authority'], frequency: CatalogueForm['frequency'],
  entityTypes: string, anchor: CatalogueForm['anchor'], offsetMonths: number, dueDay: number | null,
  extra: Partial<Pick<CatalogueForm, 'offsetDays' | 'months' | 'lateFeeNote' | 'description'>> = {},
): CatalogueForm => ({
  code, name, authority, frequency, entityTypes, anchor, offsetMonths, dueDay,
  offsetDays: extra.offsetDays ?? 0, months: extra.months ?? null,
  lateFeeNote: extra.lateFeeNote ?? null, description: extra.description ?? null,
})

export const COMPLIANCE_CATALOGUE: CatalogueForm[] = [
  f('ITR_NON_BUSINESS', 'ITR (no business income, not audited)', 'income_tax', 'annual', 'individual,huf', 'fy_end', 4, 31,
    { lateFeeNote: 's.234F fee and s.234A interest', description: 'Due 31 July after the FY.' }),
  f('ITR_NON_AUDIT_BUSINESS', 'ITR (business/profession, not audited)', 'income_tax', 'annual', 'individual,huf,firm,llp,aop', 'fy_end', 5, 31,
    { lateFeeNote: 's.234F fee and s.234A interest', description: 'Due 31 August after the FY (Finance Act 2026).' }),
  f('TAX_AUDIT_REPORT', 'Tax audit report (3CA/3CB + 3CD)', 'income_tax', 'annual', 'any', 'fy_end', 6, 30,
    { lateFeeNote: 's.271B penalty', description: 'Due 30 September after the FY.' }),
  f('ITR_AUDIT', 'ITR (company / audited)', 'income_tax', 'annual', 'company,firm,llp,individual,huf,trust', 'fy_end', 7, 31,
    { lateFeeNote: 's.234F fee and s.234A interest', description: 'Due 31 October after the FY.' }),
  f('FORM_3CEB', 'Transfer pricing report 3CEB', 'income_tax', 'annual', 'company,llp,firm', 'fy_end', 7, 31,
    { lateFeeNote: 's.271BA penalty', description: 'Due 31 October after the FY.' }),
  f('ITR_TP', 'ITR (transfer pricing cases)', 'income_tax', 'annual', 'company,llp,firm', 'fy_end', 8, 30,
    { lateFeeNote: 's.234F fee and s.234A interest', description: 'Due 30 November after the FY.' }),
  f('ADVANCE_TAX', 'Advance tax instalment (15/45/75/100%)', 'income_tax', 'monthly', 'any', 'period_end', 0, 15,
    { months: '6,9,12,3', lateFeeNote: 's.234B / s.234C interest', description: '15 June, 15 September, 15 December, 15 March.' }),
  f('SFT_61A', 'Statement of financial transactions', 'income_tax', 'annual', 'any', 'fy_end', 2, 31,
    { lateFeeNote: 's.271FA penalty', description: 'Due 31 May after the FY.' }),
  f('FORM_10B', 'Audit report of charitable trust', 'income_tax', 'annual', 'trust,society', 'fy_end', 6, 30,
    { description: 'Due 30 September after the FY.' }),
  f('GSTR9', 'GST annual return', 'gst', 'annual', 'any', 'fy_end', 9, 31,
    { lateFeeNote: '₹200/day, capped at 0.5% of turnover', description: 'Due 31 December after the FY.' }),
  f('GSTR9C', 'GST reconciliation statement', 'gst', 'annual', 'any', 'fy_end', 9, 31,
    { description: 'Due 31 December after the FY, with GSTR-9.' }),
  f('CMP08', 'Composition quarterly payment', 'gst', 'quarterly', 'any', 'period_end', 1, 18,
    { lateFeeNote: 'Interest 18% p.a.', description: '18th of the month after the quarter.' }),
  f('GSTR4', 'Composition annual return', 'gst', 'annual', 'any', 'fy_end', 1, 30,
    { description: 'Due 30 April after the FY.' }),
  f('PMT06', 'QRMP monthly tax payment', 'gst', 'monthly', 'any', 'period_end', 1, 25,
    { months: '4,5,7,8,10,11,1,2', lateFeeNote: 'Interest 18% p.a.', description: '25th of the next month, first two months of each quarter.' }),
  f('AGM', 'Hold AGM', 'mca', 'annual', 'company', 'fy_end', 6, 30,
    { description: 'By 30 September after the FY. Enter the AGM date on this item: AOC-4, MGT-7 and ADT-1 run from it.' }),
  f('AOC4', 'Financial statements to ROC', 'mca', 'annual', 'company', 'agm', 0, null,
    { offsetDays: 30, lateFeeNote: '₹100/day additional fee', description: '30 days from the AGM.' }),
  f('MGT7', 'Annual return (MGT-7 / 7A)', 'mca', 'annual', 'company', 'agm', 0, null,
    { offsetDays: 60, lateFeeNote: '₹100/day additional fee', description: '60 days from the AGM.' }),
  f('ADT1', 'Auditor appointment', 'mca', 'annual', 'company', 'agm', 0, null,
    { offsetDays: 15, lateFeeNote: '₹100/day additional fee', description: '15 days from the AGM.' }),
  f('DIR3_KYC', 'Director KYC', 'mca', 'annual', 'company', 'fy_start', 5, 30,
    { lateFeeNote: '₹5,000', description: '30 September every year.' }),
  f('DPT3', 'Return of deposits', 'mca', 'annual', 'company', 'fy_end', 3, 30,
    { lateFeeNote: '₹100/day additional fee', description: 'Due 30 June after the FY.' }),
  f('MSME1', 'MSME outstanding dues', 'mca', 'half_yearly', 'company', 'period_end', 1, 31,
    { months: '9,3', description: '31 October (Apr–Sep) and 30 April (Oct–Mar).' }),
  f('LLP11', 'LLP annual return', 'mca', 'annual', 'llp', 'fy_end', 2, 30,
    { lateFeeNote: '₹100/day additional fee', description: 'Due 30 May after the FY.' }),
  f('LLP8', 'LLP statement of account and solvency', 'mca', 'annual', 'llp', 'fy_end', 7, 30,
    { lateFeeNote: '₹100/day additional fee', description: 'Due 30 October after the FY.' }),
  f('PF_ECR', 'PF return and payment', 'labour', 'monthly', 'any', 'period_end', 1, 15,
    { lateFeeNote: 'Interest s.7Q and damages s.14B', description: '15th of the next month.' }),
  f('ESI', 'ESI contribution', 'labour', 'monthly', 'any', 'period_end', 1, 15,
    { lateFeeNote: 'Interest 12% p.a.', description: '15th of the next month.' }),
  f('PT_TN', 'Tamil Nadu professional tax', 'other', 'half_yearly', 'any', 'period_end', 0, 31,
    { months: '9,3', description: '30 September and 31 March.' }),
]

export async function seedCompliance(prisma: PrismaClient): Promise<{ forms: number }> {
  let i = 0
  for (const form of COMPLIANCE_CATALOGUE) {
    i += 1
    await prisma.complianceForm.upsert({
      where: { code: form.code },
      create: { ...form, sortOrder: i * 10 },
      update: { name: form.name, authority: form.authority, frequency: form.frequency, entityTypes: form.entityTypes, sortOrder: i * 10 },
    })
  }
  return { forms: COMPLIANCE_CATALOGUE.length }
}
