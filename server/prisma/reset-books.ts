import { PrismaClient } from '@prisma/client'
import { applyBooksInvariants } from '../src/modules/books/db/invariants.js'
import { seedBooks } from './seed-books.js'

/**
 * DEVELOPMENT ONLY — wipe the Books data and re-seed the demo.
 *
 * The ledger invariants forbid deleting a posted journal, and rightly so, so
 * a reset has to drop the triggers, clear the tables and put them back. That
 * is the only supported way to erase posted history, and it exists for the
 * demo database alone: it refuses to run when NODE_ENV is production.
 *
 *   npm run books:reset
 */
const TABLES = [
  'BooksBillAllocation', 'BooksBill', 'BooksJournalLine', 'BooksJournal', 'BooksDocumentLine', 'BooksDocument',
  'BooksPayment', 'BooksBankTransfer', 'BooksBankStatementLine', 'BooksRevaluation', 'BooksExchangeRate',
  'BooksRecurringProfile', 'BooksNumberSequence', 'BooksAuditEvent', 'BooksItem', 'BooksTaxRate',
  'BooksContactPerson', 'BooksAddress', 'BooksContact', 'BooksLedger', 'BooksAccountGroup', 'BooksMembership', 'BooksOrganisation',
]
const TRIGGERS = [
  'books_journal_no_direct_post', 'books_journal_balance_on_post', 'books_journal_status_transitions',
  'books_journal_frozen_when_posted', 'books_journal_no_delete', 'books_line_valid_on_insert',
  'books_line_no_insert_when_posted', 'books_line_frozen_when_posted', 'books_line_no_delete_when_posted',
  'books_audit_no_update', 'books_audit_no_delete',
]

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('books:reset never runs against production.')
  const prisma = new PrismaClient()
  try {
    for (const t of TRIGGERS) await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${t}`)
    for (const t of TABLES) await prisma.$executeRawUnsafe(`DELETE FROM ${t}`)
    const n = await applyBooksInvariants(prisma)
    console.log(`Books data cleared; ${n} invariant statements re-applied.`)
    const org = await prisma.organisation.findFirstOrThrow({ where: { deletedAt: null } })
    await seedBooks(prisma, org.id)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1 })
