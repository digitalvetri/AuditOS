import { PrismaClient } from '@prisma/client'

/** Shared client across the test files; setup.env.ts set DATABASE_URL. */
export const prisma = new PrismaClient()

let seq = 0
export function uid(prefix = 'id') { return `${prefix}-${Date.now().toString(36)}-${++seq}` }
