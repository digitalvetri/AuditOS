import type { Prisma, PrismaClient } from '@prisma/client'

/**
 * Everything a posting or service call needs to know about who is acting
 * and on which set of books. Built by scope.ts from the HTTP session, or
 * directly by tests.
 */
export type MembershipRole = 'admin' | 'staff' | 'viewer'

export interface BooksContext {
  booksOrgId: string
  /** The firm-level organisation that owns these books. */
  organisationId: string
  userId: string | null
  role: MembershipRole
  baseCurrency: string
  stateCode: string | null
  tdsEnabled: boolean
  ip?: string | null
}

export type Db = PrismaClient | Prisma.TransactionClient
