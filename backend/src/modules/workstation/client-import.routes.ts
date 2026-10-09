import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { Router, type Response } from 'express'
import multer from 'multer'
import ExcelJS from 'exceljs'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession, type Session } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { scanUploads } from '../../platform/virusScan.js'
import { notifyEmployee } from '../../platform/notify.js'
import { writeActivity } from '../../platform/workstation/activity.js'
import { nextClientCode } from '../../platform/workstation/codes.js'
import {
  assignedClientIds, requireWorkstation, seesAllClients,
} from '../../platform/workstation/scope.js'
import { employeeMap, ORGANIZATION_REF } from '../../api/workstation.serialize.js'
import { entityTypeOf } from '../compliance/engine.js'
import { CIN_RE, isValidGstin, LLPIN_RE } from '../gst/validate.js'
import { body, CLIENT_STATUSES, FieldErrors } from './validate.js'
import {
  BUSINESS_TYPES, bumpClientCode, clientListWhere, clientOrderBy, createClientRow, readClientFields,
  type ClientFields,
} from './clients.shared.js'

/**
 * CLIENT IMPORT, EXPORT AND BULK ACTIONS (mounted on /api/clients ahead of
 * the main clients router, so `/export` is never read as a client id).
 *
 *   GET  /import/template   the .xlsx to fill in
 *   POST /import            multipart `file` (+ `dry_run`): validate every
 *                           row; a real run creates them all or none
 *   GET  /export            the current list filters as .xlsx
 *   POST /bulk              assign account manager / change status
 *
 * The import creates clients through the same field rules and the same
 * insert as POST /api/clients (clients.shared.ts).
 */
export const clientImportRouter = Router()

const MAX_MB = 5
const MAX_ROWS = 2000
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 } })

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// ── Template ────────────────────────────────────────────────────────────────

/** Column order of the template. `key` is the field the row errors are reported under. */
const COLUMNS = [
  { key: 'company_name', header: 'Company Name *', width: 34 },
  { key: 'legal_name', header: 'Legal Name', width: 34 },
  { key: 'business_type', header: 'Business Type', width: 26 },
  { key: 'pan', header: 'PAN', width: 14, text: true },
  { key: 'gstin', header: 'GSTIN', width: 19, text: true },
  { key: 'tan', header: 'TAN', width: 14, text: true },
  { key: 'cin', header: 'CIN / LLPIN', width: 24, text: true },
  { key: 'email', header: 'Email', width: 28 },
  { key: 'contact_person', header: 'Contact Person *', width: 24 },
  { key: 'contact_number', header: 'Contact Number *', width: 17, text: true },
  { key: 'address', header: 'Address', width: 40 },
  { key: 'account_manager', header: 'Account Manager * (employee code or email)', width: 30 },
  { key: 'onboarding_date', header: 'Onboarding Date (YYYY-MM-DD)', width: 18 },
] as const
type ColumnKey = (typeof COLUMNS)[number]['key']

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
/** Header text (normalised) → field. Prefix match, so "Account Manager * (…)" works. */
const HEADER_ALIASES: [string, ColumnKey][] = [
  ['companyname', 'company_name'], ['clientname', 'company_name'],
  ['legalname', 'legal_name'],
  ['businesstype', 'business_type'], ['entitytype', 'business_type'],
  ['pan', 'pan'], ['gstin', 'gstin'], ['tan', 'tan'],
  ['cinllpin', 'cin'], ['cin', 'cin'], ['llpin', 'cin'],
  ['email', 'email'],
  ['contactperson', 'contact_person'],
  ['contactnumber', 'contact_number'], ['contactno', 'contact_number'], ['mobile', 'contact_number'], ['phone', 'contact_number'],
  ['address', 'address'],
  ['accountmanager', 'account_manager'],
  ['onboardingdate', 'onboarding_date'],
]

clientImportRouter.get('/import/template', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.client.manage')

  const staff = await prisma.employee.findMany({
    where: { ...alive, status: { not: 'inactive' } }, select: { employeeCode: true }, orderBy: { employeeCode: 'asc' },
  })

  const wb = new ExcelJS.Workbook()
  wb.creator = 'AuditOS'
  const ws = wb.addWorksheet('Clients', { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width, ...('text' in c && c.text ? { style: { numFmt: '@' } } : {}) }))
  const head = ws.getRow(1)
  head.font = { bold: true }
  head.alignment = { vertical: 'middle', wrapText: true }
  head.height = 30
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFE9FF' } }
  })

  // Dropdown values live on a hidden sheet: an inline list over 255
  // characters is silently dropped by Excel.
  const lists = wb.addWorksheet('Lists', { state: 'hidden' })
  BUSINESS_TYPES.forEach((t, i) => { lists.getCell(i + 1, 1).value = t })
  staff.forEach((e, i) => { lists.getCell(i + 1, 2).value = e.employeeCode })

  const btCol = COLUMNS.findIndex((c) => c.key === 'business_type') + 1
  const amCol = COLUMNS.findIndex((c) => c.key === 'account_manager') + 1
  const dateCol = COLUMNS.findIndex((c) => c.key === 'onboarding_date') + 1
  for (let r = 2; r <= MAX_ROWS + 1; r++) {
    ws.getCell(r, btCol).dataValidation = {
      type: 'list', allowBlank: true, formulae: [`Lists!$A$1:$A$${BUSINESS_TYPES.length}`],
      showErrorMessage: true, errorTitle: 'Business type', error: 'Choose a business type from the list.',
    }
    if (staff.length) {
      // Codes offered, but an email is accepted too — so no error on other values.
      ws.getCell(r, amCol).dataValidation = {
        type: 'list', allowBlank: true, formulae: [`Lists!$B$1:$B$${staff.length}`], showErrorMessage: false,
      }
    }
    ws.getCell(r, dateCol).numFmt = 'yyyy-mm-dd'
  }

  const help = wb.addWorksheet('Instructions')
  help.getColumn(1).width = 110
  ;[
    'How to fill in the client import',
    '',
    '• One client per row on the "Clients" sheet. Columns marked * are required. Do not rename or reorder the headings.',
    '• Business Type: pick from the dropdown — it decides which statutory forms the compliance calendar expects.',
    '• PAN (AAACK1234F), GSTIN (33AAACK1234F1Z5) and TAN (CHEK09876B) are checked for shape; the GSTIN check character must be right and its PAN must match the PAN column.',
    '• Contact Number: a 10-digit Indian mobile number (a +91 prefix is fine).',
    '• Account Manager: the employee code (dropdown) or the employee\'s email.',
    '• Onboarding Date: YYYY-MM-DD or DD/MM/YYYY. Leave blank for today.',
    '• A PAN or GSTIN that already belongs to a client, or appears twice in the file, is rejected.',
    '• Upload the file in AuditOS → Clients → Import from Excel. You see every row checked before anything is saved, and the import saves all rows or none.',
  ].forEach((line, i) => {
    const c = help.getCell(i + 1, 1)
    c.value = line
    c.alignment = { wrapText: true }
    if (i === 0) c.font = { bold: true, size: 13 }
  })

  await sendWorkbook(res, wb, 'client-import-template.xlsx')
}))

async function sendWorkbook(res: Response, wb: ExcelJS.Workbook, filename: string) {
  const buf = await wb.xlsx.writeBuffer()
  res.setHeader('Content-Type', XLSX_MIME)
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('Cache-Control', 'no-store')
  res.end(Buffer.from(buf as ArrayBuffer))
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/** Any cell as trimmed text: hyperlinks, formulas, rich text, dates, numbers. */
function cellText(v: ExcelJS.CellValue | undefined): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('').trim()
    if ('formula' in v || 'sharedFormula' in v) return cellText((v as { result?: ExcelJS.CellValue }).result)
    if ('text' in v) return String((v as { text: unknown }).text ?? '').trim()
    if ('error' in v) return ''
    return ''
  }
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v)
  return String(v).trim()
}

/** 'YYYY-MM-DD', 'DD/MM/YYYY' or 'DD-MM-YYYY' → 'YYYY-MM-DD'; anything else unchanged (and then rejected). */
function normDate(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return s
}

async function readSheet(file: Express.Multer.File): Promise<{ row: number; values: Record<ColumnKey, string> }[]> {
  const wb = new ExcelJS.Workbook()
  const name = file.originalname.toLowerCase()
  const isCsv = name.endsWith('.csv') || file.mimetype === 'text/csv'
  try {
    if (isCsv) {
      // map: keep every value as the text that was typed (no number/date guessing).
      await wb.csv.read(Readable.from(file.buffer), { map: (v: unknown) => v } as never)
    } else {
      await wb.xlsx.load(file.buffer as unknown as ArrayBuffer)
    }
  } catch {
    throw ApiError.badRequest('That file could not be read. Upload the .xlsx template (or a .csv with the same headings).')
  }
  const ws = wb.getWorksheet('Clients') ?? wb.worksheets[0]
  if (!ws) throw ApiError.badRequest('The file has no sheet to read.')

  // The header row: the first of the top five rows naming "Company Name".
  let headerRow = 0
  const colOf = new Map<ColumnKey, number>()
  for (let r = 1; r <= Math.min(5, ws.rowCount) && !headerRow; r++) {
    const row = ws.getRow(r)
    const found = new Map<ColumnKey, number>()
    row.eachCell((cell, col) => {
      const h = norm(cellText(cell.value))
      if (!h) return
      const hit = HEADER_ALIASES.find(([alias]) => h.startsWith(alias))
      if (hit && !found.has(hit[1])) found.set(hit[1], col)
    })
    if (found.has('company_name')) {
      headerRow = r
      for (const [k, c] of found) colOf.set(k, c)
    }
  }
  if (!headerRow) throw ApiError.badRequest('No "Company Name" heading found. Start from the template so the columns line up.')

  const out: { row: number; values: Record<ColumnKey, string> }[] = []
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const values = {} as Record<ColumnKey, string>
    for (const c of COLUMNS) {
      const col = colOf.get(c.key)
      values[c.key] = col ? cellText(row.getCell(col).value) : ''
    }
    if (Object.values(values).every((v) => !v)) continue // blank row
    out.push({ row: r, values })
    if (out.length > MAX_ROWS) throw ApiError.badRequest(`The file has more than ${MAX_ROWS} clients. Split it into smaller files.`)
  }
  return out
}

// ── Validation ──────────────────────────────────────────────────────────────

/** Row errors use the template's column keys; the shared reader names the manager field differently. */
const FIELD_ALIAS: Record<string, ColumnKey> = { account_manager_id: 'account_manager' }

export interface ImportRow {
  row: number
  values: Record<ColumnKey, string>
  errors: Record<string, string>
  account_manager: { id: string; name: string } | null
}

async function validateRows(session: Session, parsed: Awaited<ReturnType<typeof readSheet>>) {
  const staff = await prisma.employee.findMany({
    where: { ...alive, status: { not: 'inactive' } },
    select: { id: true, employeeCode: true, email: true, fullName: true },
  })
  const byCode = new Map(staff.map((e) => [e.employeeCode.toLowerCase(), e]))
  const byEmail = new Map(staff.filter((e) => e.email).map((e) => [e.email.toLowerCase(), e]))

  const pans = parsed.map((p) => p.values.pan.toUpperCase()).filter(Boolean)
  const gstins = parsed.map((p) => p.values.gstin.toUpperCase()).filter(Boolean)
  const existing = pans.length || gstins.length
    ? await prisma.client.findMany({
      where: { ...alive, OR: [...(pans.length ? [{ pan: { in: pans } }] : []), ...(gstins.length ? [{ gstin: { in: gstins } }] : [])] },
      select: { id: true, clientCode: true, companyName: true, pan: true, gstin: true },
    })
    : []
  const visible = existing.length ? await assignedClientIds(session, 'organisation') : 'ALL'
  const canSee = (id: string) => visible === 'ALL' || visible.includes(id)
  const panOwner = new Map(existing.filter((c) => c.pan).map((c) => [c.pan!.toUpperCase(), c]))
  const gstinOwner = new Map(existing.filter((c) => c.gstin).map((c) => [c.gstin!.toUpperCase(), c]))
  const already = (c: { id: string; clientCode: string; companyName: string }, what: string) =>
    canSee(c.id) ? `${c.clientCode} · ${c.companyName} already has this ${what}.` : `A client with this ${what} already exists.`

  const seenPan = new Map<string, number>()
  const seenGstin = new Map<string, number>()
  const fieldsByRow = new Map<number, ClientFields>()
  const rows: ImportRow[] = []

  for (const p of parsed) {
    const val = p.values
    const v = new FieldErrors()
    const amRaw = val.account_manager.trim().toLowerCase()
    const am = amRaw ? (byCode.get(amRaw) ?? byEmail.get(amRaw) ?? null) : null

    const f = readClientFields(v, {
      company_name: val.company_name,
      legal_name: val.legal_name,
      business_type: val.business_type,
      contact_person: val.contact_person,
      contact_number: val.contact_number,
      email: val.email,
      address: val.address,
      gstin: val.gstin,
      pan: val.pan,
      tan: val.tan,
      cin: val.cin,
      account_manager_id: am?.id ?? '',
      onboarding_date: val.onboarding_date ? normDate(val.onboarding_date) : '',
    })
    const errors: Record<string, string> = {}
    // Re-key the shared reader's errors onto the template columns.
    for (const [k, msg] of Object.entries(v.fields)) errors[FIELD_ALIAS[k] ?? k] = msg
    const add = (k: ColumnKey, msg: string) => { if (!errors[k]) errors[k] = msg }

    if (amRaw && !am) errors.account_manager = 'No active employee has this code or email.'
    // Staff who see only their own clients stay on what they import (same rule as Add Client).
    if (am && !seesAllClients(session) && session.employeeId && am.id !== session.employeeId) {
      add('account_manager', 'You can only import clients assigned to you.')
    }
    if (val.business_type && entityTypeOf(val.business_type) === 'any') {
      add('business_type', 'Choose a business type from the list.')
    }
    const gstin = val.gstin.toUpperCase()
    const pan = val.pan.toUpperCase()
    if (gstin && !errors.gstin && !isValidGstin(gstin)) add('gstin', 'This GSTIN’s check character is wrong — one of the characters is mistyped.')
    if (gstin && pan && !errors.gstin && !errors.pan && gstin.slice(2, 12) !== pan) add('gstin', 'The PAN inside this GSTIN (characters 3–12) does not match the PAN column.')
    const cin = val.cin.toUpperCase()
    if (cin && !CIN_RE.test(cin) && !LLPIN_RE.test(cin)) add('cin', 'Enter a valid CIN (U74999TN2020PTC123456) or LLPIN (AAB-1234).')

    // Duplicates: against the firm's clients, then within this file.
    if (pan && !errors.pan) {
      const owner = panOwner.get(pan)
      if (owner) add('pan', already(owner, 'PAN'))
      else if (seenPan.has(pan)) add('pan', `Same PAN as row ${seenPan.get(pan)}.`)
      else seenPan.set(pan, p.row)
    }
    if (gstin && !errors.gstin) {
      const owner = gstinOwner.get(gstin)
      if (owner) add('gstin', already(owner, 'GSTIN'))
      else if (seenGstin.has(gstin)) add('gstin', `Same GSTIN as row ${seenGstin.get(gstin)}.`)
      else seenGstin.set(gstin, p.row)
    }

    if (!Object.keys(errors).length) fieldsByRow.set(p.row, f)
    rows.push({ row: p.row, values: val, errors, account_manager: am ? { id: am.id, name: am.fullName } : null })
  }
  return { rows, fieldsByRow }
}

// ── Import ──────────────────────────────────────────────────────────────────

clientImportRouter.post('/import', (req, res, next) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return scanUploads(req, res, next)
    if ((err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
      return next(ApiError.unprocessable('too_large', `The file is larger than the ${MAX_MB} MB limit.`))
    }
    next(ApiError.badRequest('Upload could not be read.'))
  })
}, handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.client.manage')
  const file = req.file
  if (!file) throw ApiError.badRequest('Choose the filled-in template to upload.', { file: 'Choose a file.' })
  const fields = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const dryRun = String(fields.dry_run ?? req.query.dry_run ?? '') === 'true' || String(fields.dry_run ?? req.query.dry_run ?? '') === '1'

  const parsed = await readSheet(file)
  if (!parsed.length) throw ApiError.badRequest('The file has no client rows under the headings.')
  const { rows, fieldsByRow } = await validateRows(session, parsed)
  const invalid = rows.filter((r) => Object.keys(r.errors).length > 0).length
  const summary = { dry_run: dryRun, total: rows.length, valid: rows.length - invalid, invalid, rows }

  if (dryRun) { ok(res, summary); return }
  if (invalid > 0) {
    throw ApiError.unprocessable('import_invalid', `${invalid} row${invalid === 1 ? ' has' : 's have'} problems — nothing was imported. Fix them and upload again.`, summary)
  }

  // All or nothing: one transaction, a run of Client IDs taken under the
  // sequence lock. Lookups were all done above, so the transaction only writes.
  const created = await prisma.$transaction(async (tx) => {
    let code = await nextClientCode(tx)
    const out = []
    for (const r of rows) {
      out.push(await createClientRow(tx, fieldsByRow.get(r.row)!, session.userId, code))
      code = bumpClientCode(code)
    }
    return out
  }, { timeout: 120_000, maxWait: 10_000 })

  for (const c of created) {
    await writeActivity({
      session, subjectType: 'client', subjectId: c.id, action: 'client.created',
      description: `Client ${c.clientCode} created by import from ${file.originalname}.`,
    })
  }
  await writeAudit({
    actorUserId: session.userId, action: 'client.import', entityType: 'Client',
    entityId: `import-${crypto.randomUUID()}`,
    after: { file: file.originalname, count: created.length, client_codes: created.map((c) => c.clientCode) },
    req,
  })
  // One note per account manager, not one per client.
  const perManager = new Map<string, number>()
  for (const c of created) perManager.set(c.accountManagerId, (perManager.get(c.accountManagerId) ?? 0) + 1)
  for (const [staff, n] of perManager) {
    if (staff === session.employeeId) continue
    await notifyEmployee(staff, {
      type: 'client.assigned', module: 'system',
      title: n === 1 ? 'Client assigned to you' : `${n} clients assigned to you`,
      body: `Imported from ${file.originalname}`,
      entityType: 'Client', entityId: created.find((c) => c.accountManagerId === staff)!.id,
      actionUrl: '/workstation/clients?view=mine',
    })
  }

  ok(res, {
    ...summary,
    created: created.length,
    clients: created.map((c) => ({ id: c.id, client_id: c.clientCode, company_name: c.companyName })),
  }, 201)
}))

// ── Export ──────────────────────────────────────────────────────────────────

clientImportRouter.get('/export', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.client.read', 'workstation.client.manage')
  const query = req.query as Record<string, unknown>
  const rows = await prisma.client.findMany({
    where: await clientListWhere(session, scope, query),
    include: { parentClient: { select: ORGANIZATION_REF }, services: { where: alive, include: { service: true } } },
    orderBy: clientOrderBy(query),
    take: 20_000,
  })
  const m = await employeeMap(rows.flatMap((r) => [r.accountManagerId, r.secondaryManagerId]))
  const name = (id: string | null) => (id ? m.get(id)?.full_name ?? '' : '')

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Clients', { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = [
    { header: 'Client ID', key: 'code', width: 12 },
    { header: 'Company Name', key: 'company', width: 34 },
    { header: 'Legal Name', key: 'legal', width: 34 },
    { header: 'Business Type', key: 'type', width: 22 },
    { header: 'Status', key: 'status', width: 18 },
    { header: 'PAN', key: 'pan', width: 13 },
    { header: 'GSTIN', key: 'gstin', width: 18 },
    { header: 'TAN', key: 'tan', width: 13 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Contact Person', key: 'person', width: 22 },
    { header: 'Contact Number', key: 'phone', width: 15 },
    { header: 'Address', key: 'address', width: 40 },
    { header: 'Account Manager', key: 'am', width: 22 },
    { header: 'Second Staff', key: 'second', width: 22 },
    { header: 'Organization', key: 'org', width: 26 },
    { header: 'Services', key: 'services', width: 40 },
    { header: 'Onboarding Date', key: 'onboarded', width: 15 },
  ]
  ws.getRow(1).font = { bold: true }
  for (const r of rows) {
    ws.addRow({
      code: r.clientCode, company: r.companyName, legal: r.legalName ?? '', type: r.businessType ?? '',
      status: r.status.replace(/_/g, ' '), pan: r.pan ?? '', gstin: r.gstin ?? '', tan: r.tan ?? '',
      email: r.email ?? '', person: r.contactPerson, phone: r.contactNumber, address: r.address ?? '',
      am: name(r.accountManagerId), second: name(r.secondaryManagerId), org: r.parentClient?.companyName ?? '',
      services: r.services.map((s) => s.service.name).join(', '), onboarded: r.onboardingDate,
    })
  }
  await writeAudit({
    actorUserId: session.userId, action: 'client.export', entityType: 'Client', entityId: `export-${crypto.randomUUID()}`,
    after: { count: rows.length, filters: query }, req,
  })
  await sendWorkbook(res, wb, `clients-${new Date().toISOString().slice(0, 10)}.xlsx`)
}))

// ── Bulk actions ────────────────────────────────────────────────────────────

clientImportRouter.post('/bulk', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.client.manage')
  const b = body(req)
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.filter((x): x is string => typeof x === 'string' && !!x))] : []
  if (!ids.length) throw ApiError.badRequest('Select at least one client.', { ids: 'Select at least one client.' })
  if (ids.length > 500) throw ApiError.badRequest('Select at most 500 clients at a time.', { ids: 'At most 500.' })
  const action = b.action
  if (action !== 'assign_account_manager' && action !== 'set_status') {
    throw ApiError.badRequest('Unknown bulk action.', { action: 'Must be assign_account_manager or set_status.' })
  }

  const v = new FieldErrors()
  let managerId: string | undefined
  let status: string | undefined
  if (action === 'assign_account_manager') {
    // Who a client is assigned to decides who can see it (same rule as PATCH).
    if (!seesAllClients(session)) {
      throw ApiError.forbidden('Only an Admin, Senior Associate or Super Admin can change who a client is assigned to.')
    }
    managerId = v.str('account_manager_id', b.account_manager_id)
    v.throwIfAny()
    if (!(await prisma.employee.findFirst({ where: { id: managerId!, ...alive } }))) {
      throw ApiError.badRequest('Select a valid employee.', { account_manager_id: 'Select a valid employee.' })
    }
  } else {
    status = v.oneOf('status', b.status, CLIENT_STATUSES)
    v.throwIfAny()
  }

  // Every client must exist and be one the caller may see — or nothing changes.
  const visible = await assignedClientIds(session, scope)
  if (visible !== 'ALL' && ids.some((id) => !visible.includes(id))) throw ApiError.forbidden()
  const before = await prisma.client.findMany({ where: { id: { in: ids }, ...alive } })
  if (before.length !== ids.length) throw ApiError.notFound('One or more clients were not found.')

  const m = managerId ? await employeeMap([managerId]) : null
  const changed = await prisma.$transaction(async (tx) => {
    const out = []
    for (const c of before) {
      if (managerId) {
        if (c.accountManagerId === managerId) continue
        out.push(await tx.client.update({
          where: { id: c.id },
          // A second staff who becomes the account manager is no longer "second".
          data: { accountManagerId: managerId, ...(c.secondaryManagerId === managerId ? { secondaryManagerId: null } : {}), updatedBy: session.userId },
        }))
      } else {
        if (c.status === status) continue
        out.push(await tx.client.update({ where: { id: c.id }, data: { status: status!, updatedBy: session.userId } }))
      }
    }
    return out
  })

  const beforeById = new Map(before.map((c) => [c.id, c]))
  for (const c of changed) {
    await writeActivity({
      session, subjectType: 'client', subjectId: c.id,
      action: managerId ? 'client.staff_assigned' : 'client.status_updated',
      description: managerId
        ? `Account manager changed to ${m?.get(managerId)?.full_name ?? 'another employee'} (bulk action).`
        : `Client status changed to ${String(status).replace(/_/g, ' ')} (bulk action).`,
    })
    await writeAudit({
      actorUserId: session.userId, action: 'client.update', entityType: 'Client', entityId: c.id,
      before: beforeById.get(c.id), after: c, req,
    })
  }
  if (managerId && changed.length && managerId !== session.employeeId) {
    await notifyEmployee(managerId, {
      type: 'client.assigned', module: 'system',
      title: changed.length === 1 ? 'Client assigned to you' : `${changed.length} clients assigned to you`,
      body: changed.slice(0, 3).map((c) => c.clientCode).join(', ') + (changed.length > 3 ? '…' : ''),
      entityType: 'Client', entityId: changed[0].id, actionUrl: '/workstation/clients?view=mine',
    })
  }

  ok(res, { action, requested: ids.length, updated: changed.length })
}))
