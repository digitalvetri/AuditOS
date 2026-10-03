import JSZip from 'jszip'
import type { Session } from '../../platform/auth.js'
import { getTool, OUTPUT_MIME, type ToolDef } from './registry.js'
import { withExtension, stripExtension, formatBytes } from './lib/files.js'
import { ToolError, userMessage } from './services/errors.js'
import { DocumentService, type ToolDocumentRow } from './services/DocumentService.js'
import { ToolJobService } from './services/ToolJobService.js'
import { AuditLogService } from './services/AuditLogService.js'
import { PDFService } from './services/tools/PDFService.js'
import { ExcelService } from './services/tools/ExcelService.js'
import { WordService } from './services/tools/WordService.js'
import { ImageService } from './services/tools/ImageService.js'
import { OCRService } from './services/tools/OCRService.js'
import { signatureProvider } from './services/tools/SignatureProvider.js'
import { gstr2bExcelToJson, gstr2bJsonToExcel } from './services/tools/gstr2b.js'
import { form26asToExcel } from './services/tools/form26as.js'
import { ComplianceService } from './services/tools/ComplianceService.js'
import { fmtDateIST } from './lib/dates.js'

/**
 * THE RUNNER — one job at a time per slot, each tool a small function.
 *
 * A tool implementation receives the job's inputs (bytes already loaded),
 * the validated options and a progress callback, and returns the output
 * bytes plus facts worth keeping. Everything around it — job status,
 * document record, audit entries, error translation — is shared, so a new
 * tool is a new entry in IMPLEMENTATIONS and nothing else.
 */
export interface RunContext {
  session: Session
  organisationId: string
  tool: ToolDef
  inputs: { doc: ToolDocumentRow; bytes: Buffer }[]
  options: Record<string, unknown>
  progress: (pct: number) => void
  jobId: string
}

export interface RunOutput {
  filename: string
  mime: string
  bytes: Buffer
  meta?: Record<string, unknown>
  /** Honest partial result — surfaced to the user, job still 'completed'. */
  warning?: string
  /** Additional files to save alongside the primary output (OCR's .txt). */
  extras?: { filename: string; mime: string; bytes: Buffer; meta?: Record<string, unknown> }[]
}

type Implementation = (ctx: RunContext) => Promise<RunOutput>

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d)
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d)

const IMPLEMENTATIONS: Record<string, Implementation> = {
  'pdf-to-excel': async ({ inputs, progress }) => {
    const { doc, bytes } = inputs[0]
    const r = await ExcelService.pdfToExcel(bytes, progress)
    const warning = r.pagesWithoutTables.length
      ? `No table was found on ${r.pagesWithoutTables.length === 1 ? 'page' : 'pages'} ${r.pagesWithoutTables.join(', ')}. Those pages are listed on the Summary sheet, not silently dropped.`
      : undefined
    return {
      filename: withExtension(doc.originalFilename, 'xlsx'), mime: OUTPUT_MIME.xlsx, bytes: r.bytes,
      meta: { tables: r.tables, page_count: r.pageCount, pages_with_tables: r.pagesWithTables, pages_without_tables: r.pagesWithoutTables },
      warning,
    }
  },

  'excel-to-pdf': async ({ inputs, options, progress }) => {
    const { doc, bytes } = inputs[0]
    progress(10)
    const ext = doc.mimeType === 'application/vnd.ms-excel' ? 'xls' : 'xlsx'
    const out = await ExcelService.excelToPdf(bytes, ext, { fitToWidth: options.fit_to_width !== false })
    progress(90)
    return { filename: withExtension(doc.originalFilename, 'pdf'), mime: OUTPUT_MIME.pdf, bytes: out, meta: { page_count: await PDFService.pageCount(out) } }
  },

  'pdf-to-word': async ({ inputs, progress }) => {
    const { doc, bytes } = inputs[0]
    const r = await WordService.pdfToWord(bytes, progress)
    return { filename: withExtension(doc.originalFilename, 'docx'), mime: OUTPUT_MIME.docx, bytes: r.bytes, meta: { page_count: r.pageCount, paragraphs: r.paragraphs, tables: r.tables } }
  },

  'word-to-pdf': async ({ inputs, progress }) => {
    const { doc, bytes } = inputs[0]
    progress(10)
    const out = await WordService.wordToPdf(bytes)
    progress(90)
    return { filename: withExtension(doc.originalFilename, 'pdf'), mime: OUTPUT_MIME.pdf, bytes: out, meta: { page_count: await PDFService.pageCount(out) } }
  },

  'image-to-pdf': async ({ inputs, options, progress }) => {
    const pageSize = (['A4', 'Letter', 'Fit'] as const).find((v) => v === options.page_size) ?? 'A4'
    const orientation = (['portrait', 'landscape', 'auto'] as const).find((v) => v === options.orientation) ?? 'auto'
    const r = await ImageService.imagesToPdf(inputs.map((i) => i.bytes), { pageSize, orientation, marginMm: num(options.margin_mm, 10) }, progress)
    const base = inputs.length === 1 ? stripExtension(inputs[0].doc.originalFilename) : `images-${inputs.length}`
    return { filename: `${base}.pdf`, mime: OUTPUT_MIME.pdf, bytes: r.bytes, meta: { page_count: r.pageCount, page_size: pageSize, orientation } }
  },

  'csv-to-excel': async ({ inputs, options, progress }) => {
    const { doc, bytes } = inputs[0]
    progress(15)
    const keep = options.keep_as_text === 'all' ? 'all' : Array.isArray(options.keep_as_text) ? options.keep_as_text.map((n) => Number(n)).filter(Number.isInteger) : undefined
    const delimiter = str(options.delimiter, 'auto')
    const encoding = str(options.encoding, 'auto')
    const r = await ExcelService.csvToExcel(bytes, {
      delimiter: delimiter === 'auto' ? 'auto' : (delimiter === 'tab' ? '\t' : delimiter) as ',' | ';' | '\t' | '|',
      encoding: encoding as 'auto' | 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252',
      hasHeader: options.has_header === undefined || options.has_header === 'auto' ? 'auto' : Boolean(options.has_header),
      keepAsText: keep,
      sheetName: stripExtension(doc.originalFilename),
    })
    progress(90)
    const warning = r.skippedRows > 0 ? `${r.skippedRows} blank ${r.skippedRows === 1 ? 'row was' : 'rows were'} skipped.` : undefined
    return {
      filename: withExtension(doc.originalFilename, 'xlsx'), mime: OUTPUT_MIME.xlsx, bytes: r.bytes,
      meta: { rows: r.rows, columns: r.columns, encoding: r.detection.encoding, delimiter: r.detection.delimiter === '\t' ? 'tab' : r.detection.delimiter, has_header: r.detection.hasHeader, column_types: r.columnTypes, column_names: r.columnNames },
      warning,
    }
  },

  'merge-pdf': async ({ inputs, progress }) => {
    if (inputs.length < 2) throw new ToolError('invalid_options', 'Add at least two PDFs to merge.')
    const r = await PDFService.merge(inputs.map((i) => i.bytes), progress)
    return { filename: `${stripExtension(inputs[0].doc.originalFilename)}-merged.pdf`, mime: OUTPUT_MIME.pdf, bytes: r.bytes, meta: { page_count: r.pageCount, files: inputs.length, sources: inputs.map((i) => i.doc.originalFilename) } }
  },

  'split-pdf': async ({ inputs, options, progress }) => {
    const { doc, bytes } = inputs[0]
    const total = await PDFService.pageCount(bytes)
    let groups: number[][]
    if (options.mode === 'every') {
      const n = Math.max(1, Math.floor(num(options.every, 1)))
      groups = []
      for (let p = 1; p <= total; p += n) groups.push(Array.from({ length: Math.min(n, total - p + 1) }, (_, k) => p + k))
    } else {
      groups = PDFService.parseRanges(str(options.ranges), total)
    }
    const parts = await PDFService.split(bytes, groups, (p) => progress(p * 0.8))
    const base = stripExtension(doc.originalFilename)
    const label = (g: number[]) => (g.length === 1 ? `p${g[0]}` : `p${g[0]}-${g[g.length - 1]}`)
    if (parts.length === 1) {
      return { filename: `${base}-${label(groups[0])}.pdf`, mime: OUTPUT_MIME.pdf, bytes: parts[0], meta: { page_count: groups[0].length, parts: 1, ranges: groups.map(label) } }
    }
    const zip = new JSZip()
    parts.forEach((b, i) => zip.file(`${base}-${label(groups[i])}.pdf`, b))
    const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    progress(95)
    return { filename: `${base}-split.zip`, mime: OUTPUT_MIME.zip, bytes: out, meta: { parts: parts.length, ranges: groups.map(label), source_pages: total } }
  },

  'compress-pdf': async ({ inputs, options, progress }) => {
    const { doc, bytes } = inputs[0]
    const level = (['low', 'recommended', 'high'] as const).find((v) => v === options.level) ?? 'recommended'
    if (await PDFService.isEncrypted(bytes)) throw new ToolError('encrypted', 'This PDF is password-protected. Use Unlock PDF first.')
    progress(10)
    const compressed = await PDFService.compress(bytes, level)
    progress(90)
    // Never hand back a bigger file than the one that came in.
    const grew = compressed.length >= bytes.length
    const out = grew ? bytes : compressed
    const reduction = bytes.length > 0 ? Math.round((1 - out.length / bytes.length) * 1000) / 10 : 0
    const warning = grew
      ? `No reduction was possible — this PDF is already compact (${formatBytes(bytes.length)}). The original is kept unchanged.`
      : reduction < 5
        ? `Only ${reduction}% smaller (${formatBytes(bytes.length)} → ${formatBytes(out.length)}). This PDF is already compact; a higher level may not help.`
        : undefined
    return { filename: `${stripExtension(doc.originalFilename)}-compressed.pdf`, mime: OUTPUT_MIME.pdf, bytes: out, meta: { level, original_size: bytes.length, new_size: out.length, reduction_pct: reduction, unchanged: grew }, warning }
  },

  'unlock-pdf': async ({ inputs, options, progress, session, jobId }) => {
    const { doc, bytes } = inputs[0]
    const password = str(options.password)
    if (!password) throw new ToolError('invalid_options', 'Enter the password for this PDF.')
    if (options.authorised !== true) throw new ToolError('not_authorised', 'Confirm you are authorised to decrypt this document.')
    await AuditLogService.log({ session, action: 'unlock_authorised', toolId: 'unlock-pdf', documentId: doc.id, jobId, status: 'info', meta: { filename: doc.originalFilename } })
    progress(10)
    const out = await PDFService.unlock(bytes, password)
    progress(90)
    return { filename: `${stripExtension(doc.originalFilename)}-unlocked.pdf`, mime: OUTPUT_MIME.pdf, bytes: out, meta: { page_count: await PDFService.pageCount(out), authorised_by: session.userId } }
  },

  'esign-pdf': async ({ inputs, options, progress, session, jobId }) => {
    const { doc, bytes } = inputs[0]
    const placement = (['bottom-right', 'bottom-left', 'top-right', 'top-left', 'custom'] as const).find((v) => v === options.placement) ?? 'bottom-right'
    let drawnPng: Buffer | null = null
    const dataUrl = str(options.signature_png)
    if (dataUrl.startsWith('data:image/png;base64,')) {
      drawnPng = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64')
      if (drawnPng.length > 400_000) throw new ToolError('invalid_options', 'The drawn signature is too large. Draw it again.')
    }
    progress(10)
    const r = await signatureProvider.apply(bytes, {
      page: Math.floor(num(options.page, 1)),
      placement,
      x: num(options.x, 0.7), y: num(options.y, 0.1),
      signerName: str(options.signer_name).trim(),
      designation: str(options.designation).trim() || undefined,
      date: str(options.date).trim() || fmtDateIST(new Date()),
      reason: str(options.reason).trim() || undefined,
      drawnPng,
    })
    progress(85)
    await AuditLogService.log({ session, action: 'esign_applied', toolId: 'esign-pdf', documentId: doc.id, jobId, status: 'info', meta: { ...r.meta, filename: doc.originalFilename } })
    return { filename: `${stripExtension(doc.originalFilename)}-signed.pdf`, mime: OUTPUT_MIME.pdf, bytes: r.bytes, meta: { signature: r.meta, page_count: await PDFService.pageCount(r.bytes) } }
  },

  'ocr-scan': async ({ inputs, options, progress }) => {
    const { doc, bytes } = inputs[0]
    const outputs = (Array.isArray(options.outputs) ? options.outputs : ['pdf', 'txt']).filter((o): o is 'pdf' | 'txt' => o === 'pdf' || o === 'txt')
    const r = await OCRService.run({ bytes, mime: doc.mimeType }, { lang: 'eng', outputs: outputs.length ? outputs : ['pdf', 'txt'] }, progress)
    const meta = {
      page_count: r.pages.length,
      average_confidence: Math.round(r.averageConfidence),
      pages: r.pages.map((p) => ({ page: p.page, confidence: Math.round(p.confidence), chars: p.text.length })),
      text: r.text.slice(0, 200_000),
    }
    const lowPages = r.pages.filter((p) => p.confidence < 60).map((p) => p.page)
    const warning = r.pages.every((p) => !p.text)
      ? 'No text could be recognised. The scan may be too faint or rotated.'
      : lowPages.length ? `Low confidence on ${lowPages.length === 1 ? 'page' : 'pages'} ${lowPages.join(', ')} — check those against the original.` : undefined
    const txtName = `${stripExtension(doc.originalFilename)}.txt`
    if (r.pdf && outputs.includes('pdf')) {
      const extras = outputs.includes('txt') ? [{ filename: txtName, mime: OUTPUT_MIME.txt, bytes: r.txt, meta: { page_count: r.pages.length, average_confidence: meta.average_confidence } }] : []
      return { filename: `${stripExtension(doc.originalFilename)}-searchable.pdf`, mime: OUTPUT_MIME.pdf, bytes: r.pdf, meta, warning, extras }
    }
    return { filename: txtName, mime: OUTPUT_MIME.txt, bytes: r.txt, meta, warning }
  },

  // ── Compliance converters ─────────────────────────────────────────────

  // Bidirectional: the direction is the input's own type, so one card
  // serves both errands and the output extension follows the input.
  'gst-json-excel': async ({ inputs, progress }) => {
    const { doc, bytes } = inputs[0]
    const toJson = doc.mimeType === OUTPUT_MIME.json || /\.json$/i.test(doc.originalFilename)
    progress(15)
    if (toJson) {
      const r = await ComplianceService.gstJsonToExcel(bytes)
      progress(90)
      return {
        filename: withExtension(doc.originalFilename, 'xlsx'), mime: OUTPUT_MIME.xlsx, bytes: r.bytes,
        meta: { direction: 'json_to_excel', sections: r.sections, invoices: r.invoices, rows: r.rows },
      }
    }
    const r = await ComplianceService.gstExcelToJson(bytes)
    progress(90)
    return {
      filename: withExtension(doc.originalFilename, 'json'), mime: OUTPUT_MIME.json, bytes: r.bytes,
      meta: { direction: 'excel_to_json', sections: r.sections, invoices: r.invoices, rows: r.rows },
    }
  },

  // Bidirectional and lossless (gstr2b.ts): the input's type picks the direction.
  'gstr2b-json-excel': async ({ inputs, progress }) => {
    const { doc, bytes } = inputs[0]
    const toExcel = doc.mimeType === OUTPUT_MIME.json || /\.json$/i.test(doc.originalFilename)
    progress(15)
    const r = toExcel ? await gstr2bJsonToExcel(bytes) : await gstr2bExcelToJson(bytes)
    progress(90)
    const warnings = r.issues.filter((i) => i.severity === 'warning')
    const selfTest: { pass: boolean; diffs: string[] } | null = 'selfTest' in r ? (r as { selfTest: { pass: boolean; diffs: string[] } }).selfTest : null
    const parts = [
      ...(selfTest && !selfTest.pass ? [`Round-trip self-test FAILED at: ${selfTest.diffs.slice(0, 5).join('; ')}.`] : []),
      ...(warnings.length ? [`${warnings.length} warning${warnings.length === 1 ? '' : 's'}: ${warnings.slice(0, 4).map((w) => `${w.where} — ${w.message}`).join(' · ')}${warnings.length > 4 ? ' · …' : ''}`] : []),
    ]
    return {
      filename: withExtension(doc.originalFilename, toExcel ? 'xlsx' : 'json'),
      mime: toExcel ? OUTPUT_MIME.xlsx : OUTPUT_MIME.json, bytes: r.bytes,
      meta: {
        direction: toExcel ? 'json_to_excel' : 'excel_to_json',
        sections: r.sections.map((s) => s.section), section_counts: r.sections,
        documents: r.sections.reduce((a, s) => a + s.documents, 0), rows: r.sections.reduce((a, s) => a + s.rows, 0),
        self_test: selfTest ? (selfTest.pass ? 'PASS' : 'FAIL') : null, self_test_diffs: selfTest?.diffs ?? [],
        warnings: warnings.slice(0, 100),
      },
      warning: parts.length ? parts.join(' ') : undefined,
    }
  },

  'bank-statement-to-excel': async ({ inputs, progress }) => {
    const { doc, bytes } = inputs[0]
    const r = await ComplianceService.bankStatementToExcel(bytes, progress)
    const parts: string[] = []
    if (r.skipped) parts.push(`${r.skipped} dated ${r.skipped === 1 ? 'line' : 'lines'} could not be read and ${r.skipped === 1 ? 'is' : 'are'} listed on the Skipped sheet.`)
    if (!r.balanced) parts.push('Opening + credits − debits does not tie to the closing balance, so check the statement against the Summary sheet before using it.')
    return {
      filename: withExtension(doc.originalFilename, 'xlsx'), mime: OUTPUT_MIME.xlsx, bytes: r.bytes,
      meta: {
        transactions: r.transactions, page_count: r.pageCount, skipped: r.skipped,
        opening: r.opening, closing: r.closing, total_debit: r.totalDebit, total_credit: r.totalCredit, balanced: r.balanced,
      },
      warning: parts.length ? parts.join(' ') : undefined,
    }
  },

  // Several files at once; one that can't be read is reported, the others convert.
  'form-26as-to-excel': async ({ inputs, progress }) => {
    progress(10)
    const r = await form26asToExcel(inputs.map((i) => ({ name: i.doc.originalFilename, bytes: i.bytes })))
    progress(90)
    const failed = r.files.filter((f) => !f.ok)
    const mismatches = r.checks.filter((c) => !c.ok)
    const parts = [
      ...failed.map((f) => `${f.file} was not converted: ${f.reason}.`),
      ...(mismatches.length ? [`Check: transactions do not equal the totals in the file — ${mismatches.slice(0, 3).map((c) => `${c.label}: ${c.detail}`).join('; ')}${mismatches.length > 3 ? '; …' : ''}.`] : []),
      ...(r.skipped.length ? [`${r.skipped.length} Part A ${r.skipped.length === 1 ? 'line' : 'lines'} could not be read and ${r.skipped.length === 1 ? 'is' : 'are'} on the Skipped sheet — ${r.skipped.slice(0, 3).map((s) => `${s.reason}`).join('; ')}.`] : []),
    ]
    const first = inputs[0].doc.originalFilename
    return {
      filename: inputs.length > 1 ? `Form26AS-${inputs.length}-files.xlsx` : withExtension(first, 'xlsx'), mime: OUTPUT_MIME.xlsx, bytes: r.bytes,
      meta: {
        rows: r.transactions, deductors: r.deductors, total_paid: r.totals.paid, total_tax: r.totals.tax, total_deposited: r.totals.dep,
        skipped: r.skipped.length, files: r.files, check_ok: mismatches.length === 0, checks: r.checks,
      },
      warning: parts.length ? parts.join(' ') : undefined,
    }
  },

  'excel-to-tally-xml': async ({ inputs, options, progress }) => {
    const { doc, bytes } = inputs[0]
    progress(20)
    const r = await ComplianceService.excelToTallyXml(bytes, { companyName: str(options.company_name) })
    progress(90)
    return {
      filename: withExtension(doc.originalFilename, 'xml'), mime: OUTPUT_MIME.xml, bytes: r.bytes,
      meta: { vouchers: r.vouchers, skipped: r.skipped, total_amount: r.totalAmount, voucher_types: r.voucherTypes },
      warning: r.warning,
    }
  },

  'tds-fvu-generator': async ({ inputs, options, progress }) => {
    const { doc, bytes } = inputs[0]
    progress(20)
    const lines = (...keys: string[]) => keys.map((k) => str(options[k]))
    const sameAddress = options.rp_same_address === true
    const r = await ComplianceService.tdsTextFile(bytes, {
      quarter: str(options.quarter, 'Q1'), fy: str(options.financial_year),
      tan: str(options.tan), pan: str(options.deductor_pan), name: str(options.deductor_name),
      type: str(options.deductor_type), gstin: str(options.deductor_gstin),
      address: lines('address1', 'address2', 'address3', 'address4', 'address5'),
      state: str(options.state), pincode: str(options.pincode), email: str(options.email), phone: str(options.phone),
      rpName: str(options.rp_name), rpDesignation: str(options.rp_designation), rpPan: str(options.rp_pan),
      rpAddress: sameAddress ? lines('address1', 'address2', 'address3', 'address4', 'address5')
        : lines('rp_address1', 'rp_address2', 'rp_address3', 'rp_address4', 'rp_address5'),
      rpState: str(sameAddress ? options.state : options.rp_state),
      rpPincode: str(sameAddress ? options.pincode : options.rp_pincode),
      rpEmail: str(options.rp_email) || str(options.email), rpPhone: str(options.rp_phone) || str(options.phone),
      filedEarlier: options.filed_earlier === true, previousToken: str(options.previous_token),
    })
    progress(90)
    return {
      filename: `${stripExtension(doc.originalFilename)}-Form140-${str(options.quarter, 'Q1')}.txt`,
      mime: OUTPUT_MIME.txt, bytes: r.bytes,
      meta: { deductees: r.deductees, challans: r.challans, skipped: r.skipped, total_tds: r.totalTds, form_type: 'Form 140', quarter: str(options.quarter, 'Q1') },
      warning: r.warning,
    }
  },

  'invoice-to-einvoice-json': async ({ inputs, progress }) => {
    const { doc, bytes } = inputs[0]
    progress(20)
    const r = await ComplianceService.invoiceToEInvoiceJson(bytes)
    progress(90)
    return {
      filename: withExtension(doc.originalFilename, 'json'), mime: OUTPUT_MIME.json, bytes: r.bytes,
      meta: { invoices: r.invoices, items: r.items, skipped: r.skipped, total_value: r.totalValue },
      warning: r.warning,
    }
  },
}

// ── Execution ────────────────────────────────────────────────────────────
const MAX_PARALLEL = 2
let running = 0
const queue: (() => void)[] = []

function slot(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => { running++; resolve(() => { running--; queue.shift()?.() }) }
    if (running < MAX_PARALLEL) grant()
    else queue.push(grant)
  })
}

/** Fire-and-forget; the caller polls the job. Errors never escape. */
export function enqueue(session: Session, organisationId: string, jobId: string, tool: ToolDef, inputs: ToolDocumentRow[], options: Record<string, unknown>) {
  setImmediate(() => {
    execute(session, organisationId, jobId, tool, inputs, options).catch((err) => {
      console.error('[tools] runner crashed', err instanceof Error ? err.message : err)
    })
  })
}

async function execute(session: Session, organisationId: string, jobId: string, tool: ToolDef, inputDocs: ToolDocumentRow[], options: Record<string, unknown>) {
  const release = await slot()
  const primary = inputDocs[0]
  const expectedName = withExtension(primary?.originalFilename ?? tool.id, tool.outputType)
  try {
    await ToolJobService.updateStatus(jobId, 'processing', { progress: 1 })
    await AuditLogService.log({ session, action: 'conversion_started', toolId: tool.id, documentId: primary?.id ?? null, jobId, status: 'info', meta: { inputs: inputDocs.map((d) => d.originalFilename) } })

    const impl = IMPLEMENTATIONS[tool.id]
    if (!impl) throw new ToolError('engine_unavailable', 'This tool is not available yet.')
    const inputs = await Promise.all(inputDocs.map(async (doc) => ({ doc, bytes: await DocumentService.readBytes(doc) })))
    const out = await impl({
      session, organisationId, tool, inputs, options, jobId,
      progress: (pct) => { void ToolJobService.progress(jobId, pct) },
    })

    const outputDoc = await DocumentService.saveGeneratedDocument({
      session, organisationId, toolId: tool.id, filename: out.filename, mimeType: out.mime, bytes: out.bytes,
      parentDocumentId: primary?.id ?? null,
      meta: { ...(out.meta ?? {}), ...(out.warning ? { warning: out.warning } : {}), inputs: inputDocs.map((d) => ({ id: d.id, filename: d.originalFilename, size: d.fileSize })) },
    })
    const extraOutputs: { id: string; filename: string; size: number }[] = []
    for (const extra of out.extras ?? []) {
      const extraDoc = await DocumentService.saveGeneratedDocument({
        session, organisationId, toolId: tool.id, filename: extra.filename, mimeType: extra.mime, bytes: extra.bytes,
        parentDocumentId: primary?.id ?? null, meta: { ...(extra.meta ?? {}), companion_of: outputDoc.id },
      })
      extraOutputs.push({ id: extraDoc.id, filename: extra.filename, size: extra.bytes.length })
      await AuditLogService.log({ session, action: 'conversion_completed', toolId: tool.id, documentId: extraDoc.id, jobId, status: 'success', meta: { from: inputDocs.map((d) => d.originalFilename).join(', '), to: extra.filename, size: extra.bytes.length } })
    }
    await ToolJobService.completeJob(jobId, outputDoc.id, { output: out.filename, warning: out.warning ?? null, ...(out.meta ?? {}), ...(extraOutputs.length ? { extra_outputs: extraOutputs } : {}) })
    await AuditLogService.log({
      session, action: 'conversion_completed', toolId: tool.id, documentId: outputDoc.id, jobId, status: 'success',
      meta: { from: inputDocs.map((d) => d.originalFilename).join(', '), to: out.filename, size: out.bytes.length, ...(out.warning ? { warning: out.warning } : {}) },
    })
  } catch (err) {
    const { code, message } = userMessage(err)
    if (code === 'failed') console.error('[tools] job failed', tool.id, err instanceof Error ? err.stack ?? err.message : err)
    const failedDoc = await DocumentService.saveFailedDocument({
      session, organisationId, toolId: tool.id, filename: expectedName, mimeType: OUTPUT_MIME[tool.outputType],
      parentDocumentId: primary?.id ?? null, errorMessage: message, meta: { code },
    }).catch(() => null)
    await ToolJobService.failJob(jobId, message, failedDoc?.id ?? null, { code }).catch(() => undefined)
    await AuditLogService.log({ session, action: 'conversion_failed', toolId: tool.id, documentId: failedDoc?.id ?? primary?.id ?? null, jobId, status: 'failed', meta: { code, message, from: inputDocs.map((d) => d.originalFilename).join(', ') } })
  } finally {
    release()
  }
}

export function isImplemented(toolId: string): boolean {
  return Boolean(IMPLEMENTATIONS[toolId]) && getTool(toolId)?.status === 'active'
}
