/**
 * TOOL REGISTRY — server copy.
 *
 * The React client carries the full registry (badge, tint, keywords, route)
 * at src/modules/tools/registry.ts and renders the Tools page from it. This
 * file holds the subset the server must enforce regardless of what a client
 * sends: which files a tool accepts, how large they may be, how many, what
 * it produces, which permission gates it and whether it is live at all.
 *
 * The seed syncs ToolCategory / ToolGroup / Tool rows from this file, so a
 * ToolJob always references a tool id that exists here. Turning a compliance
 * converter on later is `status: 'active'` here + on the client, plus its
 * implementation in runner.ts. Nothing else moves.
 */
import type { PermissionCode } from '../../platform/rbac/matrix.js'

export type ToolStatus = 'active' | 'coming_soon'
export type OutputType = 'pdf' | 'xlsx' | 'docx' | 'csv' | 'txt' | 'zip' | 'json' | 'xml'

export interface ToolCategoryDef {
  id: 'converters-utilities' | 'finance-compliance'
  label: string
  order: number
  status: ToolStatus
}

export interface ToolGroupDef {
  id: 'document-conversion' | 'pdf-utilities' | 'compliance-converters'
  label: string
  categoryId: ToolCategoryDef['id']
  order: number
}

export interface ToolDef {
  id: string
  name: string
  description: string
  groupId: ToolGroupDef['id']
  /** MIME types accepted at upload. The server also sniffs magic bytes. */
  accepts: string[]
  /** Lower-case extensions accepted, used when the browser sends a vague MIME. */
  extensions: string[]
  maxFileSizeMB: number
  multiple: boolean
  outputType: OutputType
  permission: PermissionCode
  status: ToolStatus
}

export const MIME = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  zip: 'application/zip',
  json: 'application/json',
  xml: 'application/xml',
} as const

export const TOOL_CATEGORIES: ToolCategoryDef[] = [
  { id: 'converters-utilities', label: 'Converters & Utilities', order: 1, status: 'active' },
  { id: 'finance-compliance', label: 'Finance & Compliance', order: 2, status: 'coming_soon' },
]

export const TOOL_GROUPS: ToolGroupDef[] = [
  { id: 'document-conversion', label: 'Document conversion', categoryId: 'converters-utilities', order: 1 },
  { id: 'pdf-utilities', label: 'PDF utilities', categoryId: 'converters-utilities', order: 2 },
  { id: 'compliance-converters', label: 'Compliance converters', categoryId: 'finance-compliance', order: 3 },
]

const PDF_ONLY = { accepts: [MIME.pdf], extensions: ['pdf'] }
const IMAGES = { accepts: [MIME.jpeg, MIME.png, MIME.webp], extensions: ['jpg', 'jpeg', 'png', 'webp'] }

export const TOOLS: ToolDef[] = [
  // ── Document conversion ────────────────────────────────────────────────
  { id: 'pdf-to-excel', name: 'PDF to Excel', description: 'Extract tables from PDF into editable .xlsx',
    groupId: 'document-conversion', ...PDF_ONLY, maxFileSizeMB: 25, multiple: false, outputType: 'xlsx',
    permission: 'tools.pdf_to_excel', status: 'active' },
  { id: 'excel-to-pdf', name: 'Excel to PDF', description: 'Convert spreadsheets to print-ready PDF',
    groupId: 'document-conversion', accepts: [MIME.xlsx, MIME.xls], extensions: ['xlsx', 'xls'],
    maxFileSizeMB: 25, multiple: false, outputType: 'pdf', permission: 'tools.excel_to_pdf', status: 'active' },
  { id: 'pdf-to-word', name: 'PDF to Word', description: 'Editable .docx from any PDF',
    groupId: 'document-conversion', ...PDF_ONLY, maxFileSizeMB: 25, multiple: false, outputType: 'docx',
    permission: 'tools.pdf_to_word', status: 'active' },
  { id: 'word-to-pdf', name: 'Word to PDF', description: 'Letters & deeds to PDF',
    groupId: 'document-conversion', accepts: [MIME.docx], extensions: ['docx'],
    maxFileSizeMB: 25, multiple: false, outputType: 'pdf', permission: 'tools.word_to_pdf', status: 'active' },
  { id: 'image-to-pdf', name: 'Image to PDF', description: 'Scans / JPGs into a single PDF',
    groupId: 'document-conversion', ...IMAGES, maxFileSizeMB: 20, multiple: true, outputType: 'pdf',
    permission: 'tools.image_to_pdf', status: 'active' },
  { id: 'csv-to-excel', name: 'CSV to Excel', description: 'Clean, typed columns from raw CSV',
    groupId: 'document-conversion', accepts: [MIME.csv, MIME.tsv, MIME.txt, MIME.xls], extensions: ['csv', 'tsv', 'txt'],
    maxFileSizeMB: 25, multiple: false, outputType: 'xlsx', permission: 'tools.csv_to_excel', status: 'active' },

  // ── PDF utilities ──────────────────────────────────────────────────────
  { id: 'merge-pdf', name: 'Merge PDF', description: 'Combine multiple PDFs in order',
    groupId: 'pdf-utilities', ...PDF_ONLY, maxFileSizeMB: 25, multiple: true, outputType: 'pdf',
    permission: 'tools.merge_pdf', status: 'active' },
  { id: 'split-pdf', name: 'Split PDF', description: 'Extract pages or ranges',
    groupId: 'pdf-utilities', ...PDF_ONLY, maxFileSizeMB: 25, multiple: false, outputType: 'zip',
    permission: 'tools.split_pdf', status: 'active' },
  { id: 'compress-pdf', name: 'Compress PDF', description: 'Reduce size for portal uploads',
    groupId: 'pdf-utilities', ...PDF_ONLY, maxFileSizeMB: 50, multiple: false, outputType: 'pdf',
    permission: 'tools.compress_pdf', status: 'active' },
  { id: 'unlock-pdf', name: 'Unlock PDF', description: 'Remove a known password from a PDF',
    groupId: 'pdf-utilities', ...PDF_ONLY, maxFileSizeMB: 25, multiple: false, outputType: 'pdf',
    permission: 'tools.unlock_pdf', status: 'active' },
  { id: 'esign-pdf', name: 'e-Sign PDF', description: 'Signature workflow for approvals',
    groupId: 'pdf-utilities', ...PDF_ONLY, maxFileSizeMB: 25, multiple: false, outputType: 'pdf',
    permission: 'tools.esign_pdf', status: 'active' },
  { id: 'ocr-scan', name: 'OCR Scan', description: 'Make scanned docs searchable',
    groupId: 'pdf-utilities', accepts: [MIME.pdf, ...IMAGES.accepts], extensions: ['pdf', ...IMAGES.extensions],
    maxFileSizeMB: 25, multiple: false, outputType: 'pdf', permission: 'tools.ocr_scan', status: 'active' },

  // ── Compliance converters — cards only this phase ──────────────────────
  { id: 'gst-json-excel', name: 'GST JSON ⇄ Excel', description: 'GSTR-1/3B offline utility format',
    groupId: 'compliance-converters', accepts: [MIME.json, MIME.xlsx], extensions: ['json', 'xlsx'],
    maxFileSizeMB: 25, multiple: false, outputType: 'xlsx', permission: 'tools.gst_json_excel', status: 'coming_soon' },
  { id: 'bank-statement-to-excel', name: 'Bank Statement to Excel', description: 'Parse PDF statements to ledger rows',
    groupId: 'compliance-converters', ...PDF_ONLY, maxFileSizeMB: 25, multiple: false, outputType: 'xlsx',
    permission: 'tools.bank_statement_to_excel', status: 'coming_soon' },
  { id: 'form-26as-to-excel', name: 'Form 26AS to Excel', description: 'TDS reconciliation sheet',
    groupId: 'compliance-converters', accepts: [MIME.pdf, MIME.txt], extensions: ['pdf', 'txt'],
    maxFileSizeMB: 25, multiple: false, outputType: 'xlsx', permission: 'tools.form_26as_to_excel', status: 'coming_soon' },
  { id: 'excel-to-tally-xml', name: 'Excel to Tally XML', description: 'Import-ready vouchers for Tally',
    groupId: 'compliance-converters', accepts: [MIME.xlsx], extensions: ['xlsx'],
    maxFileSizeMB: 25, multiple: false, outputType: 'xml', permission: 'tools.excel_to_tally_xml', status: 'coming_soon' },
  { id: 'tds-fvu-generator', name: 'TDS Text/FVU Generator', description: 'Build 24Q/26Q return files',
    groupId: 'compliance-converters', accepts: [MIME.xlsx], extensions: ['xlsx'],
    maxFileSizeMB: 25, multiple: false, outputType: 'txt', permission: 'tools.tds_fvu_generator', status: 'coming_soon' },
  { id: 'invoice-to-einvoice-json', name: 'Invoice to e-Invoice JSON', description: 'IRP-ready schema from Excel',
    groupId: 'compliance-converters', accepts: [MIME.xlsx], extensions: ['xlsx'],
    maxFileSizeMB: 25, multiple: false, outputType: 'json', permission: 'tools.invoice_to_einvoice_json', status: 'coming_soon' },
]

const BY_ID = new Map(TOOLS.map((t) => [t.id, t]))

export function getTool(id: string): ToolDef | undefined {
  return BY_ID.get(id)
}

export const OUTPUT_MIME: Record<OutputType, string> = {
  pdf: MIME.pdf, xlsx: MIME.xlsx, docx: MIME.docx, csv: MIME.csv, txt: MIME.txt,
  zip: MIME.zip, json: MIME.json, xml: MIME.xml,
}
