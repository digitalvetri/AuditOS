/**
 * TOOL REGISTRY — the single source the Tools page, its search, the
 * workspace routes and the sidebar-free navigation all render from.
 *
 * Nothing in the UI references a tool by a hard-coded string: cards, groups,
 * routes and permissions come from this file. The server carries a matching
 * copy of the enforcement-relevant fields (accepts, size, permission,
 * status) at server/src/modules/tools/registry.ts — keep the two in step.
 *
 * Turning a compliance converter on later: flip `status` to 'active' here
 * and on the server, add its implementation to the runner. Nothing on this
 * page moves.
 */
import type { LucideIcon } from 'lucide-react';
import { LockOpen, PenLine } from 'lucide-react';
import type { PermissionCode } from '@/platform/rbac/matrix';

export type ToolStatus = 'active' | 'coming_soon';
export type BadgeTint = 'green' | 'blue' | 'indigo' | 'amber' | 'rose';
export type OutputType = 'pdf' | 'xlsx' | 'docx' | 'csv' | 'txt' | 'zip' | 'json' | 'xml';

export interface ToolCategory {
  id: 'converters-utilities' | 'finance-compliance';
  label: string;
  order: number;
  status: ToolStatus;
}

export interface ToolGroup {
  id: 'document-conversion' | 'pdf-utilities' | 'compliance-converters';
  label: string;
  categoryId: ToolCategory['id'];
  order: number;
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  badge: { text?: string; icon?: LucideIcon; tint: BadgeTint };
  groupId: ToolGroup['id'];
  route: string;
  /** MIME types the dropzone accepts. */
  accepts: string[];
  /** Lower-case extensions, used for the file picker and the "Supported" hint. */
  extensions: string[];
  maxFileSizeMB: number;
  multiple: boolean;
  outputType: OutputType;
  keywords: string[];
  permission: PermissionCode;
  status: ToolStatus;
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
  json: 'application/json',
} as const;

export const TOOL_CATEGORIES: ToolCategory[] = [
  { id: 'converters-utilities', label: 'Converters & Utilities', order: 1, status: 'active' },
  { id: 'finance-compliance', label: 'Finance & Compliance', order: 2, status: 'coming_soon' },
];

export const TOOL_GROUPS: ToolGroup[] = [
  { id: 'document-conversion', label: 'Document conversion', categoryId: 'converters-utilities', order: 1 },
  { id: 'pdf-utilities', label: 'PDF utilities', categoryId: 'converters-utilities', order: 2 },
  { id: 'compliance-converters', label: 'Compliance converters', categoryId: 'finance-compliance', order: 3 },
];

const PDF = { accepts: [MIME.pdf], extensions: ['pdf'] };
const IMAGES = { accepts: [MIME.jpeg, MIME.png, MIME.webp], extensions: ['jpg', 'jpeg', 'png', 'webp'] };

export const TOOLS: ToolDefinition[] = [
  // ── Document conversion ────────────────────────────────────────────────
  { id: 'pdf-to-excel', name: 'PDF to Excel', description: 'Extract tables from PDF into editable .xlsx',
    badge: { text: 'PDF→XLS', tint: 'green' }, groupId: 'document-conversion', route: '/tools/pdf-to-excel',
    ...PDF, maxFileSizeMB: 25, multiple: false, outputType: 'xlsx',
    keywords: ['pdf', 'excel', 'xlsx', 'table', 'extract', 'spreadsheet'], permission: 'tools.pdf_to_excel', status: 'active' },
  { id: 'excel-to-pdf', name: 'Excel to PDF', description: 'Convert spreadsheets to print-ready PDF',
    badge: { text: 'XLS→PDF', tint: 'green' }, groupId: 'document-conversion', route: '/tools/excel-to-pdf',
    accepts: [MIME.xlsx, MIME.xls], extensions: ['xlsx', 'xls'], maxFileSizeMB: 25, multiple: false, outputType: 'pdf',
    keywords: ['excel', 'xlsx', 'pdf', 'spreadsheet', 'print'], permission: 'tools.excel_to_pdf', status: 'active' },
  { id: 'pdf-to-word', name: 'PDF to Word', description: 'Editable .docx from any PDF',
    badge: { text: 'PDF→DOC', tint: 'blue' }, groupId: 'document-conversion', route: '/tools/pdf-to-word',
    ...PDF, maxFileSizeMB: 25, multiple: false, outputType: 'docx',
    keywords: ['pdf', 'word', 'docx', 'editable', 'document'], permission: 'tools.pdf_to_word', status: 'active' },
  { id: 'word-to-pdf', name: 'Word to PDF', description: 'Letters & deeds to PDF',
    badge: { text: 'DOC→PDF', tint: 'blue' }, groupId: 'document-conversion', route: '/tools/word-to-pdf',
    accepts: [MIME.docx], extensions: ['docx'], maxFileSizeMB: 25, multiple: false, outputType: 'pdf',
    keywords: ['word', 'docx', 'pdf', 'letter', 'deed'], permission: 'tools.word_to_pdf', status: 'active' },
  { id: 'image-to-pdf', name: 'Image to PDF', description: 'Scans / JPGs into a single PDF',
    badge: { text: 'IMG→PDF', tint: 'indigo' }, groupId: 'document-conversion', route: '/tools/image-to-pdf',
    ...IMAGES, maxFileSizeMB: 20, multiple: true, outputType: 'pdf',
    keywords: ['image', 'jpg', 'jpeg', 'png', 'webp', 'scan', 'photo', 'pdf'], permission: 'tools.image_to_pdf', status: 'active' },
  { id: 'csv-to-excel', name: 'CSV to Excel', description: 'Clean, typed columns from raw CSV',
    badge: { text: 'CSV→XLS', tint: 'green' }, groupId: 'document-conversion', route: '/tools/csv-to-excel',
    accepts: [MIME.csv, MIME.tsv, MIME.txt, MIME.xls], extensions: ['csv', 'tsv', 'txt'], maxFileSizeMB: 25, multiple: false, outputType: 'xlsx',
    keywords: ['csv', 'tsv', 'excel', 'xlsx', 'import', 'columns'], permission: 'tools.csv_to_excel', status: 'active' },

  // ── PDF utilities ──────────────────────────────────────────────────────
  { id: 'merge-pdf', name: 'Merge PDF', description: 'Combine multiple PDFs in order',
    badge: { text: 'MERGE', tint: 'amber' }, groupId: 'pdf-utilities', route: '/tools/merge-pdf',
    ...PDF, maxFileSizeMB: 25, multiple: true, outputType: 'pdf',
    keywords: ['pdf', 'merge', 'combine', 'join', 'append'], permission: 'tools.merge_pdf', status: 'active' },
  { id: 'split-pdf', name: 'Split PDF', description: 'Extract pages or ranges',
    badge: { text: 'SPLIT', tint: 'amber' }, groupId: 'pdf-utilities', route: '/tools/split-pdf',
    ...PDF, maxFileSizeMB: 25, multiple: false, outputType: 'zip',
    keywords: ['pdf', 'split', 'pages', 'range', 'extract'], permission: 'tools.split_pdf', status: 'active' },
  { id: 'compress-pdf', name: 'Compress PDF', description: 'Reduce size for portal uploads',
    badge: { text: 'ZIP', tint: 'amber' }, groupId: 'pdf-utilities', route: '/tools/compress-pdf',
    ...PDF, maxFileSizeMB: 50, multiple: false, outputType: 'pdf',
    keywords: ['pdf', 'compress', 'reduce', 'size', 'shrink', 'portal'], permission: 'tools.compress_pdf', status: 'active' },
  { id: 'unlock-pdf', name: 'Unlock PDF', description: 'Remove a known password from a PDF',
    badge: { icon: LockOpen, tint: 'rose' }, groupId: 'pdf-utilities', route: '/tools/unlock-pdf',
    ...PDF, maxFileSizeMB: 25, multiple: false, outputType: 'pdf',
    keywords: ['pdf', 'unlock', 'password', 'decrypt', 'statement', 'bank'], permission: 'tools.unlock_pdf', status: 'active' },
  { id: 'esign-pdf', name: 'e-Sign PDF', description: 'Signature workflow for approvals',
    badge: { icon: PenLine, tint: 'rose' }, groupId: 'pdf-utilities', route: '/tools/esign-pdf',
    ...PDF, maxFileSizeMB: 25, multiple: false, outputType: 'pdf',
    keywords: ['pdf', 'sign', 'signature', 'esign', 'approve', 'approval'], permission: 'tools.esign_pdf', status: 'active' },
  { id: 'ocr-scan', name: 'OCR Scan', description: 'Make scanned docs searchable',
    badge: { text: 'OCR', tint: 'indigo' }, groupId: 'pdf-utilities', route: '/tools/ocr-scan',
    accepts: [MIME.pdf, ...IMAGES.accepts], extensions: ['pdf', ...IMAGES.extensions], maxFileSizeMB: 25, multiple: false, outputType: 'pdf',
    keywords: ['pdf', 'ocr', 'scan', 'text', 'searchable', 'image', 'recognise'], permission: 'tools.ocr_scan', status: 'active' },

  // ── Compliance converters — cards only this phase ──────────────────────
  { id: 'gst-json-excel', name: 'GST JSON ⇄ Excel', description: 'GSTR-1/3B offline utility format',
    badge: { text: 'JSON', tint: 'blue' }, groupId: 'compliance-converters', route: '/tools/gst-json-excel',
    accepts: [MIME.json, MIME.xlsx], extensions: ['json', 'xlsx'], maxFileSizeMB: 25, multiple: false, outputType: 'xlsx',
    keywords: ['gst', 'gstr', 'gstr-1', 'gstr-3b', 'json', 'excel', 'offline utility'], permission: 'tools.gst_json_excel', status: 'coming_soon' },
  { id: 'bank-statement-to-excel', name: 'Bank Statement to Excel', description: 'Parse PDF statements to ledger rows',
    badge: { text: 'BANK', tint: 'green' }, groupId: 'compliance-converters', route: '/tools/bank-statement-to-excel',
    ...PDF, maxFileSizeMB: 25, multiple: false, outputType: 'xlsx',
    keywords: ['bank', 'statement', 'excel', 'ledger', 'pdf'], permission: 'tools.bank_statement_to_excel', status: 'coming_soon' },
  { id: 'form-26as-to-excel', name: 'Form 26AS to Excel', description: 'TDS reconciliation sheet',
    badge: { text: '26AS', tint: 'indigo' }, groupId: 'compliance-converters', route: '/tools/form-26as-to-excel',
    accepts: [MIME.pdf, MIME.txt], extensions: ['pdf', 'txt'], maxFileSizeMB: 25, multiple: false, outputType: 'xlsx',
    keywords: ['26as', 'tds', 'excel', 'reconciliation', 'traces'], permission: 'tools.form_26as_to_excel', status: 'coming_soon' },
  { id: 'excel-to-tally-xml', name: 'Excel to Tally XML', description: 'Import-ready vouchers for Tally',
    badge: { text: 'TALLY', tint: 'amber' }, groupId: 'compliance-converters', route: '/tools/excel-to-tally-xml',
    accepts: [MIME.xlsx], extensions: ['xlsx'], maxFileSizeMB: 25, multiple: false, outputType: 'xml',
    keywords: ['tally', 'xml', 'excel', 'voucher', 'import'], permission: 'tools.excel_to_tally_xml', status: 'coming_soon' },
  { id: 'tds-fvu-generator', name: 'TDS Text/FVU Generator', description: 'Build 24Q/26Q return files',
    badge: { text: 'FVU', tint: 'rose' }, groupId: 'compliance-converters', route: '/tools/tds-fvu-generator',
    accepts: [MIME.xlsx], extensions: ['xlsx'], maxFileSizeMB: 25, multiple: false, outputType: 'txt',
    keywords: ['tds', 'fvu', '24q', '26q', 'return', 'text'], permission: 'tools.tds_fvu_generator', status: 'coming_soon' },
  { id: 'invoice-to-einvoice-json', name: 'Invoice to e-Invoice JSON', description: 'IRP-ready schema from Excel',
    badge: { text: 'IFF', tint: 'blue' }, groupId: 'compliance-converters', route: '/tools/invoice-to-einvoice-json',
    accepts: [MIME.xlsx], extensions: ['xlsx'], maxFileSizeMB: 25, multiple: false, outputType: 'json',
    keywords: ['invoice', 'e-invoice', 'einvoice', 'irp', 'json', 'excel'], permission: 'tools.invoice_to_einvoice_json', status: 'coming_soon' },
];

const BY_ID = new Map(TOOLS.map((t) => [t.id, t]));
export function getTool(id: string | undefined): ToolDefinition | undefined {
  return id ? BY_ID.get(id) : undefined;
}
export function groupOf(tool: ToolDefinition): ToolGroup {
  return TOOL_GROUPS.find((g) => g.id === tool.groupId)!;
}

/** Search across name, description, group label and keywords. */
export function searchTools(query: string, tools: ToolDefinition[] = TOOLS): ToolDefinition[] {
  const q = query.trim().toLowerCase();
  if (!q) return tools;
  const terms = q.split(/\s+/);
  return tools.filter((t) => {
    const hay = [t.name, t.description, groupOf(t).label, ...t.keywords].join(' ').toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

/** Human "Supported: PDF · max 25 MB" line. */
export function supportedLine(tool: ToolDefinition): string {
  const exts = [...new Set(tool.extensions.map((e) => (e === 'jpeg' ? 'jpg' : e)))].map((e) => e.toUpperCase());
  return `Supported: ${exts.join(', ')} · max ${tool.maxFileSizeMB} MB${tool.multiple ? ' each' : ''}`;
}

export const DOCUMENTS_ROUTE = '/tools/documents';
