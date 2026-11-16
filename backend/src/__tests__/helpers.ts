import { PrismaClient } from '@prisma/client'

/** Shared client across the test files; setup.env.ts set DATABASE_URL. */
export const prisma = new PrismaClient()

let seq = 0
export function uid(prefix = 'id') { return `${prefix}-${Date.now().toString(36)}-${++seq}` }

/**
 * The firm's GSTIN in settings (Organisation.gstin). Invoices cannot be sent
 * without it, so billing suites set it in beforeAll. Every organisation in
 * the shared test DB gets it, because the invoice service reads the first.
 */
export const FIRM_GSTIN_TN = '33AWHPN2628Q1Z2'
export async function setFirmGstin(gstin: string | null = FIRM_GSTIN_TN) {
  await prisma.organisation.updateMany({ data: { gstin } })
}
