/**
 * CSV invoice import for the Zoho Payments integration
 * (docs/zoho-payments/README.md §9).
 *
 * The CSV shape (header row required, column names case-insensitive):
 *
 *   invoice_number  REQUIRED  the string that appears on the invoice
 *   issued_on       REQUIRED  ISO date (YYYY-MM-DD)
 *   amount          REQUIRED  RUPEES-as-decimal (25000 or 25000.00)
 *   status          optional  open | paid | cancelled  (default: open)
 *   due_date        optional  ISO date
 *   client_code     optional  matches Client.clientCode; null if absent
 *
 * Extra columns are ignored. Missing required columns fail the whole
 * upload with a 400 — anything less would silently import garbage.
 * Rows with a bad amount / date fail individually with a row-scoped
 * error, so a 200-row CSV with one bad row still lands 199 invoices.
 *
 * Idempotent — the upsert key is `(billingAccountId, invoiceNumber)`,
 * so re-uploading the same CSV merges instead of duplicating. Status
 * transitions on re-import (an invoice flipping from `open` to `paid`
 * in the source system is exactly what the operator wants to see).
 *
 * Amounts convert from decimal rupees to INTEGER paise HERE and nowhere
 * else — the same boundary rule as sync.ts.
 */
import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'

const REQUIRED_COLUMNS = ['invoice_number', 'issued_on', 'amount'] as const
const KNOWN_STATUSES = ['open', 'paid', 'cancelled'] as const

export interface ImportOutcome {
  inserted: number
  updated: number
  skipped: number
  errors: { row: number; message: string }[]
  warnings: { row: number; message: string }[]
}

export interface ImportInput {
  billingAccountId: string
  organisationId: string
  actorUserId: string
  csv: string
}

/**
 * Parse a CSV into a matrix of trimmed strings. Handles quoted cells,
 * escaped quotes (`""`), CRLF and LF line endings. Not a full RFC 4180
 * (multi-line quoted cells are supported; leading BOM is stripped).
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const rows: string[][] = []
  let cell = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; continue }
        inQuotes = false
        continue
      }
      cell += ch
      continue
    }
    if (ch === '"') { inQuotes = true; continue }
    if (ch === ',') { row.push(cell); cell = ''; continue }
    if (ch === '\r') continue
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue }
    cell += ch
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row) }
  // Drop trailing all-empty rows (a CSV that ends with a newline).
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop()
  return rows
}

export async function importInvoicesCsv(input: ImportInput): Promise<ImportOutcome> {
  const account = await prisma.zpayAccount.findFirst({
    where: {
      id: input.billingAccountId,
      deletedAt: null,
      connection: { organisationId: input.organisationId, deletedAt: null },
    },
    select: { id: true },
  })
  if (!account) throw ApiError.notFound('No such Zoho Payments account.')

  const rows = parseCsv(input.csv)
  if (rows.length === 0) {
    throw ApiError.badRequest('CSV appears to be empty.')
  }
  const header = rows[0].map((c) => c.trim().toLowerCase())
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c))
  if (missing.length) {
    throw ApiError.badRequest(
      `Missing required columns: ${missing.join(', ')}. Required: ${REQUIRED_COLUMNS.join(', ')}.`,
    )
  }
  const col = (name: string): number => header.indexOf(name)
  const idx = {
    invoiceNumber: col('invoice_number'),
    issuedOn: col('issued_on'),
    amount: col('amount'),
    status: col('status'),
    dueDate: col('due_date'),
    clientCode: col('client_code'),
  }

  // Pre-load clients for code lookup. A CSV with 500 rows and a client
  // per row would otherwise fire 500 queries.
  const clientCodes = new Set<string>()
  for (let r = 1; r < rows.length; r++) {
    const code = idx.clientCode >= 0 ? (rows[r][idx.clientCode] ?? '').trim() : ''
    if (code) clientCodes.add(code)
  }
  const clientsByCode = new Map<string, string>()
  if (clientCodes.size > 0) {
    const found = await prisma.client.findMany({
      where: {
        organisationId: input.organisationId,
        clientCode: { in: [...clientCodes] },
        deletedAt: null,
      },
      select: { id: true, clientCode: true },
    })
    for (const c of found) clientsByCode.set(c.clientCode, c.id)
  }

  const outcome: ImportOutcome = {
    inserted: 0, updated: 0, skipped: 0, errors: [], warnings: [],
  }

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    // Skip fully-empty rows silently.
    if (row.every((c) => c.trim() === '')) { outcome.skipped++; continue }

    const invoiceNumber = (row[idx.invoiceNumber] ?? '').trim()
    const issuedOnRaw = (row[idx.issuedOn] ?? '').trim()
    const amountRaw = (row[idx.amount] ?? '').trim()

    if (!invoiceNumber) {
      outcome.errors.push({ row: r + 1, message: 'invoice_number is empty' })
      continue
    }
    const issuedOn = normaliseIsoDate(issuedOnRaw)
    if (!issuedOn) {
      outcome.errors.push({ row: r + 1, message: `issued_on is not a valid date: "${issuedOnRaw}"` })
      continue
    }
    const amountPaise = rupeesToPaise(amountRaw)
    if (amountPaise === null) {
      outcome.errors.push({ row: r + 1, message: `amount is not a valid number: "${amountRaw}"` })
      continue
    }
    let status: string = 'open'
    if (idx.status >= 0) {
      const raw = (row[idx.status] ?? '').trim().toLowerCase()
      if (raw) {
        if (!(KNOWN_STATUSES as readonly string[]).includes(raw)) {
          outcome.errors.push({
            row: r + 1,
            message: `status is not one of open | paid | cancelled: "${raw}"`,
          })
          continue
        }
        status = raw
      }
    }
    let dueDate: string | null = null
    if (idx.dueDate >= 0) {
      const raw = (row[idx.dueDate] ?? '').trim()
      if (raw) {
        const iso = normaliseIsoDate(raw)
        if (!iso) {
          outcome.errors.push({ row: r + 1, message: `due_date is not a valid date: "${raw}"` })
          continue
        }
        dueDate = iso
      }
    }
    let clientId: string | null = null
    if (idx.clientCode >= 0) {
      const raw = (row[idx.clientCode] ?? '').trim()
      if (raw) {
        const found = clientsByCode.get(raw)
        if (found) clientId = found
        else outcome.warnings.push({ row: r + 1, message: `client_code "${raw}" did not resolve to a client — imported without a client link` })
      }
    }

    const data = {
      status,
      amountPaise,
      issuedOn,
      dueDate,
      clientId,
      source: 'csv',
      importedAt: new Date(),
      importedBy: input.actorUserId,
      updatedBy: input.actorUserId,
    }

    const existing = await prisma.zpayExternalInvoice.findUnique({
      where: {
        billingAccountId_invoiceNumber: {
          billingAccountId: account.id,
          invoiceNumber,
        },
      },
      select: { id: true },
    })
    if (existing) {
      await prisma.zpayExternalInvoice.update({
        where: { id: existing.id },
        data,
      })
      outcome.updated++
    } else {
      await prisma.zpayExternalInvoice.create({
        data: {
          ...data,
          organisationId: input.organisationId,
          billingAccountId: account.id,
          invoiceNumber,
          createdBy: input.actorUserId,
        },
      })
      outcome.inserted++
    }
  }

  return outcome
}

function normaliseIsoDate(raw: string): string | null {
  if (!raw) return null
  // Already ISO: YYYY-MM-DD (allow YYYY/MM/DD as well).
  const iso = raw.replaceAll('/', '-')
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (isoMatch) {
    const y = Number(isoMatch[1]), m = Number(isoMatch[2]), d = Number(isoMatch[3])
    if (isValidDate(y, m, d)) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`
  }
  // DD-MM-YYYY (Indian everyday format) / DD/MM/YYYY.
  const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(iso)
  if (dmy) {
    const d = Number(dmy[1]), m = Number(dmy[2]), y = Number(dmy[3])
    if (isValidDate(y, m, d)) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`
  }
  return null
}

function isValidDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

function rupeesToPaise(raw: string): number | null {
  if (!raw) return null
  // Strip thousands separators — Indian CSVs often carry "25,000" or "1,25,000".
  const cleaned = raw.replaceAll(',', '').trim()
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}
