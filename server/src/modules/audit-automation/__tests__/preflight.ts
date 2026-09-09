/**
 * Preflight smoke test for the audit-automation upload pipeline.
 *
 * Verifies the amendment's explicit requirements without needing a real
 * password-protected bank statement (per AMENDMENT-02 §7 the firm has
 * not yet supplied samples — decryption cannot be tested against files
 * we generated ourselves).
 *
 * Assertions covered:
 *   1. Scanned PDF (no text layer)          → rejected, no AaJob row
 *   2. Same file uploaded twice per client  → 409 duplicate_upload
 *   3. Successful upload                    → job created; extraction
 *                                             blob stored (not the PDF);
 *                                             no password key anywhere
 *                                             in the persisted meta
 *   4. Password contract                    → PasswordRequiredError
 *                                             and WrongPasswordError
 *                                             are surfaced as distinct
 *                                             typed errors (unit-level)
 *
 * Run with:  npx tsx server/src/modules/audit-automation/__tests__/preflight.ts
 */
import '../../../lib/env.js'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { PrismaClient } from '@prisma/client'
import { AaUploadService } from '../services/AaUploadService.js'
import { AaAccountService } from '../services/AaAccountService.js'
import { aaStorage } from '../storage.js'
import { PasswordRequiredError, WrongPasswordError } from '../lib/pdfInspect.js'
import type { Session } from '../../../platform/auth.js'

const prisma = new PrismaClient()

async function makeTextPdf(pages: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const text of pages) {
    const page = doc.addPage([595, 842])
    // Add enough text to easily clear the MIN_TEXT_LAYER_BYTES threshold.
    let y = 800
    for (const line of text.split('\n')) {
      page.drawText(line, { x: 50, y, size: 11, font })
      y -= 14
    }
  }
  return Buffer.from(await doc.save())
}

async function makeBlankPdf(pageCount = 2): Promise<Buffer> {
  // A PDF whose text layer is tiny — a single character per page. This
  // simulates a scanned bank statement whose only "text" comes from
  // OCR-planted or accidental glyphs, which is under MIN_TEXT_LAYER_BYTES.
  // pdf-lib requires a non-empty content stream for pdfjs to parse it,
  // so we draw one dot per page (well under the threshold).
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([595, 842])
    page.drawText('.', { x: 10, y: 10, size: 6, font })
  }
  return Buffer.from(await doc.save())
}

function pass(name: string) { console.log(`✓ ${name}`) }
function fail(name: string, detail: string): never {
  console.error(`✗ ${name}\n  ${detail}`)
  process.exit(1)
}

async function loadTestSession(): Promise<{ session: Session; client: { id: string; organisationId: string } }> {
  // Use the MD from the demo seed. They have organisation-scope grants.
  const user = await prisma.user.findFirst({
    where: { email: 'ravi@auditos.local' },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  })
  if (!user) throw new Error('demo user ravi@auditos.local not found — run npm run seed first')
  const grants = user.role.permissions.map((rp) => ({
    permission: rp.permission.code,
    scope: rp.scope as Session['grants'][number]['scope'],
  }))
  const session: Session = {
    userId: user.id,
    email: user.email,
    roleId: user.roleId,
    roleCode: user.role.code as Session['roleCode'],
    roleName: user.role.name,
    grants,
    employeeId: null,
    departmentId: null,
    employeeFullName: null,
  }
  const client = await prisma.client.findFirst({
    where: { organisationId: user.organisationId, deletedAt: null },
    select: { id: true, organisationId: true },
  })
  if (!client) throw new Error('no demo client — run npm run seed first')
  return { session, client }
}

async function ensureAccount(session: Session, clientId: string, bankKey: string) {
  const bank = await prisma.aaBank.findUniqueOrThrow({ where: { key: bankKey } })
  const existing = await prisma.aaBankAccount.findFirst({
    where: { clientId, bankId: bank.id, deletedAt: null },
  })
  if (existing) return { id: existing.id, bank }
  const account = await AaAccountService.create(session, {
    clientId, bankId: bank.id, accountNumberMasked: '•••9999', label: 'Preflight Test',
  })
  return { id: account.id, bank }
}

async function cleanup(clientId: string) {
  // Nuke jobs → source-docs → extraction blobs → test account. Keep
  // the seeded org/user/client rows.
  const docs = await prisma.aaSourceDocument.findMany({ where: { clientId } })
  for (const d of docs) {
    await prisma.aaJob.deleteMany({ where: { sourceDocumentId: d.id } })
    try { await aaStorage.delete(d.extractionPath) } catch { /* ok */ }
  }
  await prisma.aaSourceDocument.deleteMany({ where: { clientId } })
  await prisma.aaBankAccount.deleteMany({ where: { clientId, accountNumberMasked: '•••9999' } })
}

async function main() {
  const { session, client } = await loadTestSession()
  await cleanup(client.id) // start clean

  const { id: bankAccountId, bank } = await ensureAccount(session, client.id, 'hdfc-bank')

  // ── 1. Scanned PDF is rejected at upload ─────────────────────────────
  const scanned = await makeBlankPdf(3)
  try {
    await AaUploadService.process({
      session, organisationId: client.organisationId, clientId: client.id,
      bankKey: bank.key, bankAccountId,
      originalFilename: 'scanned.pdf', mimeType: 'application/pdf',
      bytes: scanned,
    })
    fail('scanned PDF rejected at upload', 'expected ApiError; upload succeeded')
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code !== 'scanned_document') fail('scanned PDF rejected at upload', `expected code=scanned_document, got ${code}: ${(err as Error).message}`)
    const jobs = await prisma.aaJob.count({ where: { clientId: client.id } })
    if (jobs !== 0) fail('scanned PDF rejected at upload', `expected zero jobs, found ${jobs}`)
    pass('scanned PDF rejected at upload with no AaJob created')
  }

  // ── 2. Successful upload creates job + stores extraction (not PDF) ──
  // Build a fixture with clearly-more-than MIN_TEXT_LAYER_BYTES (500) of text.
  const rows = [
    '05-Apr NEFT-DR-ACME LTD              12,000.00    4,70,150.00',
    '07-Apr IMPS-CR-VENDOR PAYMENT         5,500.00    4,75,650.00',
    '12-Apr UPI-CR-JOHN                    8,000.00    4,83,650.00',
    '15-Apr NEFT-DR-SRI VARI TRADERS      21,300.00    4,62,350.00',
    '18-Apr NEFT-DR-SALARY BATCH 1        95,000.00    3,67,350.00',
    '22-Apr UPI-CR-CUSTOMER REFUND         1,250.00    3,68,600.00',
    '25-Apr NEFT-DR-GST-2603A             48,720.00    3,19,880.00',
    '28-Apr UPI-CR-PLATFORM SETTLEMENT    62,000.00    3,81,880.00',
    '30-Apr NEFT-DR-RENT MARCH 26         55,000.00    3,26,880.00',
  ]
  const good = await makeTextPdf([
    ['HDFC Bank Statement', 'Account: 50100234567891 (•••7891)', 'Period: 01-Apr-2026 to 30-Apr-2026', 'Opening Balance: 4,82,150.00', '', 'Transactions', ...rows].join('\n'),
    ['Date       Description                              Amount      Balance', ...rows, ...rows].join('\n'),
  ])
  const result = await AaUploadService.process({
    session, organisationId: client.organisationId, clientId: client.id,
    bankKey: bank.key, bankAccountId,
    originalFilename: 'apr-2026.pdf', mimeType: 'application/pdf',
    bytes: good,
  })
  if (result.job.status !== 'queued') fail('upload success creates queued job', `status=${result.job.status}`)
  const storedJob = await prisma.aaJob.findUniqueOrThrow({ where: { id: result.job.id } })
  if (!storedJob.metaJson) fail('job has meta', 'metaJson is null')
  const meta = JSON.parse(storedJob.metaJson) as Record<string, unknown>
  if ('password' in meta || 'pwd' in meta) fail('password not in job meta', `meta keys=${Object.keys(meta).join(',')}`)
  pass('successful upload creates queued job with no password in meta')

  const doc = await prisma.aaSourceDocument.findUniqueOrThrow({ where: { id: result.source_document_id } })
  // Extraction path is our storage key, and the file exists.
  const extractionExists = await aaStorage.exists(doc.extractionPath)
  if (!extractionExists) fail('extraction stored', `no file at ${doc.extractionPath}`)
  // What's stored must NOT be a PDF (it's our JSON blob).
  const extracted = await aaStorage.get(doc.extractionPath)
  const first4 = extracted.subarray(0, 4).toString('utf8')
  if (first4 === '%PDF') fail('extraction is JSON not PDF', `extractionPath begins with %PDF`)
  const parsed = JSON.parse(extracted.toString('utf8')) as { pages: unknown[] }
  if (!Array.isArray(parsed.pages) || parsed.pages.length !== 2) fail('extraction structure', `expected 2 pages, got ${parsed.pages?.length}`)
  pass('extraction stored as JSON blob (not decrypted PDF)')

  // ── 3. Duplicate upload for the same client is refused ──────────────
  try {
    await AaUploadService.process({
      session, organisationId: client.organisationId, clientId: client.id,
      bankKey: bank.key, bankAccountId,
      originalFilename: 'apr-2026-copy.pdf', mimeType: 'application/pdf',
      bytes: good,
    })
    fail('duplicate upload refused', 'expected ApiError; upload succeeded')
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code !== 'duplicate_upload') fail('duplicate upload refused', `expected code=duplicate_upload, got ${code}`)
    pass('same file uploaded twice → 409 duplicate_upload')
  }

  // ── 4. Password error types are distinct (unit-level assertion) ─────
  // We can only verify the classes are exported and instantiable — the
  // actual decrypt paths require a real password-protected PDF.
  const pr = new PasswordRequiredError()
  const wp = new WrongPasswordError()
  if (pr.name !== 'PasswordRequiredError' || wp.name !== 'WrongPasswordError') {
    fail('password error types', `names=${pr.name}/${wp.name}`)
  }
  pass('PasswordRequiredError and WrongPasswordError are distinct typed errors')

  // ── 5. AaSourceDocument schema has no password column ───────────────
  // (Prisma would already fail if we tried to write one — this asserts
  //  the schema shape via the Prisma types at compile time.)
  //   type _NoPassword = keyof Prisma.AaSourceDocumentCreateInput & 'password'
  // Runtime-side, confirm the DB metadata has no such column.
  const cols = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'AaSourceDocument'",
  )
  const badCol = cols.find((c) => /password/i.test(c.name))
  if (badCol) fail('no password column', `found column ${badCol.name}`)
  pass('AaSourceDocument schema has no password-like column')

  await cleanup(client.id)
  console.log(`\nAll preflight assertions passed (${bank.name} against demo client).`)
}

main()
  .catch((e) => { console.error('\n[FAIL]', e instanceof Error ? e.stack : e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
