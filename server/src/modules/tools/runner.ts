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
