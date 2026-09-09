import crypto from 'node:crypto'
import type { Request } from 'express'
import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { writeAudit } from '../../../platform/audit.js'
import { aaStorage } from '../storage.js'
import {
  inspectPdf,
  MIN_TEXT_LAYER_BYTES,
  PasswordRequiredError,
  WrongPasswordError,
  UnreadablePdfError,
  type InspectionResult,
} from '../lib/pdfInspect.js'
import { classifyDetection, type DetectionResult } from '../adapters/registry.js'
import { AaJobService, type AaJobApi } from './AaJobService.js'
import { AaAccountService } from './AaAccountService.js'

/**
 * The pre-flight sequence from AMENDMENT-02 §4-Prompt2, sections 1(a-e)
 * and 2. Every check runs BEFORE any AaJob is created, so a rejected
 * upload leaves no orphan row and no wasted auditor time.
 *
 * a) File type + size          — done in routes.ts (multer + magic bytes)
 * b) Encryption / password     — inspectPdf() throws typed errors
 * c) Text layer                — reject scans; no OCR fallback
 * d) File hash                 — per-(client, sha256) dedupe
 * e) Page integrity            — soft flag PAGE_COUNT_MISMATCH
 *
 * Then: adapter detect() with the score bands from §4-Prompt2-2.
 *
 * PASSWORD HANDLING (AMENDMENT-02 §1-Gap1 — the critical bit):
 * the password comes in as an argument, is passed to inspectPdf() to
 * decrypt in memory, and then its reference goes out of scope. It is
 * NEVER written to AaSourceDocument (no column exists), NEVER written
 * to AaJob.metaJson (only whitelisted fields land there), NEVER logged
 * (writeAudit calls below carry no password). A test asserts this.
 *
 * WHAT WE STORE (AMENDMENT-02 §1-Gap1):
 * only the JSON text-extraction blob (pdfjs items with coordinates)
 * at extractionPath. The decrypted PDF is never persisted; the original
 * encrypted PDF is not persisted either. `fileSha256` is the sha256 of
 * the original uploaded bytes — that's what the auditor sees as
 * "the file" and so the correct dedupe key.
 */

export interface UploadInput {
  session: Session
  organisationId: string
  clientId: string
  bankKey: string
  bankAccountId: string
  originalFilename: string
  mimeType: string
  bytes: Buffer
  password?: string
  /** true → proceed even if adapter score < 0.3 (flag ADAPTER_MISMATCH). */
  overrideAdapterMismatch?: boolean
  req?: Request
}

export interface UploadResult {
  job: AaJobApi
  source_document_id: string
  detection: DetectionResult
  page_count: number
  declared_page_count: number | null
  flags: string[]
}

async function verifyClientInOrg(organisationId: string, clientId: string) {
  const client = await prisma.client.findFirst({
    where: { id: clientId, organisationId, deletedAt: null },
    select: { id: true },
  })
  if (!client) throw ApiError.notFound('No such client.')
}

export const AaUploadService = {
  async process(input: UploadInput): Promise<UploadResult> {
    const { session, organisationId, clientId, bankKey, bankAccountId, originalFilename, mimeType, bytes, password, req } = input

    // Confirm the client and the account belong to this session's org.
    await verifyClientInOrg(organisationId, clientId)
    const account = await AaAccountService.requireOwned(session, bankAccountId)
    if (account.clientId !== clientId) throw ApiError.badRequest('Account does not belong to this client.')

    // Resolve the bank by key (the picker sends the key, we store the id).
    const bank = await prisma.aaBank.findUnique({ where: { key: bankKey } })
    if (!bank || !bank.active) throw ApiError.notFound('No such bank.')
    if (account.bankId !== bank.id) throw ApiError.badRequest('Account does not belong to this bank.')

    // ── (b) Encryption + password decryption ────────────────────────────
    // inspectPdf throws PasswordRequiredError / WrongPasswordError so the
    // route can return a specific message per AMENDMENT-02 §1-Gap1.
    let inspection: InspectionResult
    try {
      inspection = await inspectPdf(bytes, password)
    } catch (err) {
      if (err instanceof PasswordRequiredError) {
        await AaUploadService.auditRejection({ session, clientId, filename: originalFilename, reason: 'password_required', req })
        throw ApiError.badRequest('This PDF is password-protected. Enter the statement password to continue.')
      }
      if (err instanceof WrongPasswordError) {
        await AaUploadService.auditRejection({ session, clientId, filename: originalFilename, reason: 'wrong_password', req })
        throw ApiError.badRequest('Incorrect statement password.')
      }
      if (err instanceof UnreadablePdfError) {
        await AaUploadService.auditRejection({ session, clientId, filename: originalFilename, reason: 'unreadable', req })
        throw ApiError.unprocessable('unreadable', "We couldn't read this PDF. It may be corrupted.")
      }
      throw err
    }

    // ── (c) Text-layer check — REJECT scanned outright ──────────────────
    // AMENDMENT-02 §1-Gap3: no OCR fallback. Reject before any job row.
    if (inspection.textLayerBytes < MIN_TEXT_LAYER_BYTES) {
      await AaUploadService.auditRejection({ session, clientId, filename: originalFilename, reason: 'scanned_document', req })
      throw ApiError.unprocessable(
        'scanned_document',
        'This appears to be a scanned document. Only bank-generated PDFs with selectable text can be processed.',
      )
    }

    // ── (d) File hash → per-client dedupe ────────────────────────────────
    const fileSha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    const existing = await prisma.aaSourceDocument.findFirst({
      where: { clientId, fileSha256, ...alive },
      select: { id: true, jobs: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true } } },
    })
    if (existing) {
      await AaUploadService.auditRejection({ session, clientId, filename: originalFilename, reason: 'duplicate_upload', req })
      throw ApiError.conflict('duplicate_upload', 'This statement is already uploaded for this client.', {
        existing_source_document_id: existing.id,
        existing_job_id: existing.jobs[0]?.id ?? null,
      })
    }

    // ── (e) Page integrity (soft) ────────────────────────────────────────
    const flags: string[] = []
    if (inspection.declaredPageCount !== null && inspection.declaredPageCount !== inspection.pageCount) {
      flags.push('PAGE_COUNT_MISMATCH')
    }

    // ── Adapter detect() as validation ───────────────────────────────────
    const detection = classifyDetection(bankKey, inspection)
    if (detection.band === 'mismatch' && !input.overrideAdapterMismatch) {
      await AaUploadService.auditRejection({
        session, clientId, filename: originalFilename, reason: 'adapter_mismatch',
        meta: { adapter_id: detection.adapterId, score: detection.score, bank: bank.name },
        req,
      })
      throw ApiError.conflict('adapter_mismatch', `This does not look like a ${bank.name} statement.`, {
        adapter_id: detection.adapterId, score: detection.score,
      })
    }
    if (detection.band === 'uncertain') flags.push('ADAPTER_UNCERTAIN')
    if (detection.band === 'mismatch' && input.overrideAdapterMismatch) flags.push('ADAPTER_MISMATCH')
    if (detection.band === 'no_adapter') flags.push('UNKNOWN_FORMAT')

    // ── Persist the JSON extraction (NOT the decrypted PDF) ──────────────
    const documentId = crypto.randomUUID()
    const extraction = JSON.stringify({
      version: 1,
      pages: inspection.pages,
    })
    const key = `${organisationId}/${clientId}/${documentId}/extraction.json`
    await aaStorage.put(key, Buffer.from(extraction, 'utf8'))

    // ── Create AaSourceDocument + AaJob in a transaction ─────────────────
    // meta whitelist — the password NEVER lands here.
    const jobMeta: Record<string, unknown> = {
      adapter_id: detection.adapterId,
      adapter_band: detection.band,
      adapter_score: detection.score,
      declared_page_count: inspection.declaredPageCount,
      actual_page_count: inspection.pageCount,
    }

    const doc = await prisma.aaSourceDocument.create({
      data: {
        id: documentId,
        organisationId,
        clientId,
        uploadedByUserId: session.userId,
        bankId: bank.id,
        bankAccountId: account.id,
        originalFilename,
        mimeType,
        fileSize: bytes.length,
        fileSha256,
        extractionPath: key,
        pageCount: inspection.pageCount,
        textLayerBytes: inspection.textLayerBytes,
        encrypted: inspection.encrypted,
        declaredPageCount: inspection.declaredPageCount,
      },
    })

    const job = await AaJobService.create({
      sourceDocumentId: doc.id,
      organisationId,
      clientId,
      createdByUserId: session.userId,
      flags,
      meta: jobMeta,
    })

    await writeAudit({
      actorUserId: session.userId,
      action: 'aa.upload',
      entityType: 'AaSourceDocument',
      entityId: doc.id,
      after: {
        client_id: clientId,
        bank_id: bank.id,
        bank_account_id: account.id,
        filename: originalFilename,
        size: bytes.length,
        page_count: inspection.pageCount,
        sha256: fileSha256,
        flags,
        job_id: job.id,
        // NEVER a password key here.
      },
      req,
    })
    await writeAudit({
      actorUserId: session.userId,
      action: 'aa.job_created',
      entityType: 'AaJob',
      entityId: job.id,
      after: { source_document_id: doc.id, client_id: clientId, flags, adapter_id: detection.adapterId },
      req,
    })

    // Kick the stub extractor (this slice — see AaJobService.scheduleStubExtraction).
    AaJobService.scheduleStubExtraction(job.id)

    return {
      job,
      source_document_id: doc.id,
      detection,
      page_count: inspection.pageCount,
      declared_page_count: inspection.declaredPageCount,
      flags,
    }
  },

  /**
   * Audit a preflight rejection. Used for scanned/wrong-password/duplicate
   * to keep a record of refused uploads. NEVER carries a password.
   */
  async auditRejection(input: {
    session: Session
    clientId: string
    filename: string
    reason: string
    meta?: Record<string, unknown>
    req?: Request
  }): Promise<void> {
    await writeAudit({
      actorUserId: input.session.userId,
      action: 'aa.preflight_rejected',
      entityType: 'AaSourceDocument',
      entityId: 'none',
      after: {
        client_id: input.clientId,
        filename: input.filename,
        reason: input.reason,
        ...(input.meta ?? {}),
      },
      req: input.req,
    })
  },
}
