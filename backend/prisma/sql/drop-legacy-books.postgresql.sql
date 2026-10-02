-- Old native Books ledger (replaced by Tools → Books on Zoho Books).
-- Drops its tables so `prisma db push` can apply the new schema without
-- --accept-data-loss. IF EXISTS makes it a no-op once they are gone; it
-- names every table explicitly and touches nothing else.
DROP TABLE IF EXISTS
  "BooksAccountGroup",
  "BooksAddress",
  "BooksAuditEvent",
  "BooksBankStatementLine",
  "BooksBankTransfer",
  "BooksBill",
  "BooksBillAllocation",
  "BooksContact",
  "BooksContactPerson",
  "BooksDocument",
  "BooksDocumentLine",
  "BooksExchangeRate",
  "BooksItem",
  "BooksJournal",
  "BooksJournalLine",
  "BooksLedger",
  "BooksMembership",
  "BooksNumberSequence",
  "BooksOrganisation",
  "BooksPayment",
  "BooksRecurringProfile",
  "BooksRevaluation",
  "BooksTaxRate"
CASCADE;
