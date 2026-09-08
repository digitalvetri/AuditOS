-- BOOKS INVARIANTS — SQLite.
--
-- Applied idempotently at API start-up, by the seed and by the test harness
-- (server/src/modules/books/db/invariants.ts). Statements are separated by
-- lines containing only "-- @@" because trigger bodies contain semicolons.
--
-- Rules:
--   1. A journal cannot be INSERTED as posted; it becomes posted by an UPDATE,
--      and that UPDATE is refused unless debits == credits and lines >= 2.
--   2. Lines of a posted or void journal cannot be added, changed or deleted
--      (reconciliation columns excepted).
--   3. A posted journal's financial columns are frozen; the only status move
--      is posted -> void; void is terminal; nothing posted is ever deleted.
--   4. Line amounts are positive and sides are 'debit' | 'credit'.
--   5. Audit events are append-only.

CREATE TRIGGER IF NOT EXISTS books_journal_no_direct_post
BEFORE INSERT ON BooksJournal
WHEN NEW.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'books: a journal is inserted as draft and posted by update');
END;
-- @@
CREATE TRIGGER IF NOT EXISTS books_journal_balance_on_post
BEFORE UPDATE OF status ON BooksJournal
WHEN NEW.status = 'posted' AND OLD.status = 'draft'
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM BooksJournalLine WHERE journalId = NEW.id) < 2
      THEN RAISE(ABORT, 'books: journal needs at least two lines')
    WHEN (SELECT COALESCE(SUM(CASE WHEN side = 'debit' THEN amount ELSE 0 END), 0) FROM BooksJournalLine WHERE journalId = NEW.id)
      <> (SELECT COALESCE(SUM(CASE WHEN side = 'credit' THEN amount ELSE 0 END), 0) FROM BooksJournalLine WHERE journalId = NEW.id)
      THEN RAISE(ABORT, 'books: journal is not balanced')
    WHEN (SELECT COUNT(*) FROM BooksJournalLine WHERE journalId = NEW.id AND booksOrgId <> NEW.booksOrgId) > 0
      THEN RAISE(ABORT, 'books: journal lines belong to another set of books')
  END;
END;
-- @@
CREATE TRIGGER IF NOT EXISTS books_journal_status_transitions
BEFORE UPDATE OF status ON BooksJournal
WHEN NOT (
  (OLD.status = 'draft' AND NEW.status IN ('draft', 'posted'))
  OR (OLD.status = 'posted' AND NEW.status IN ('posted', 'void'))
  OR (OLD.status = 'void' AND NEW.status = 'void')
)
BEGIN
  SELECT RAISE(ABORT, 'books: illegal journal status transition');
END;
-- @@
CREATE TRIGGER IF NOT EXISTS books_journal_frozen_when_posted
BEFORE UPDATE OF date, number, voucherType, currency, exchangeRate, totalDebit, totalCredit, sourceModule, sourceId, booksOrgId ON BooksJournal
WHEN OLD.status IN ('posted', 'void')
BEGIN
  SELECT RAISE(ABORT, 'books: a posted journal cannot be edited; void it and post a new one');
END;
-- @@
CREATE TRIGGER IF NOT EXISTS books_journal_no_delete
BEFORE DELETE ON BooksJournal
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'books: posted journals are never deleted');
END;
-- @@
CREATE TRIGGER IF NOT EXISTS books_line_valid_on_insert
BEFORE INSERT ON BooksJournalLine
WHEN NEW.amount <= 0 OR NEW.fxAmount <= 0 OR NEW.side NOT IN ('debit', 'credit')
BEGIN
  SELECT RAISE(ABORT, 'books: line amount must be positive and side debit or credit');
END;
-- @@
CREATE TRIGGER IF NOT EXISTS books_line_no_insert_when_posted
BEFORE INSERT ON BooksJournalLine
WHEN (SELECT status FROM BooksJournal WHERE id = NEW.journalId) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'books: cannot add a line to a posted journal');
END;
-- @@
CREATE TRIGGER IF NOT EXISTS books_line_frozen_when_posted
BEFORE UPDATE OF journalId, booksOrgId, lineNo, ledgerId, side, amount, fxCurrency, fxAmount, exchangeRate, partyLedgerId, taxRateId ON BooksJournalLine
WHEN (SELECT status FROM BooksJournal WHERE id = OLD.journalId) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'books: cannot change a line of a posted journal');
END;
-- @@
CREATE TRIGGER IF NOT EXISTS books_line_no_delete_when_posted
BEFORE DELETE ON BooksJournalLine
WHEN (SELECT status FROM BooksJournal WHERE id = OLD.journalId) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'books: cannot delete a line of a posted journal');
END;
-- @@
CREATE TRIGGER IF NOT EXISTS books_audit_no_update
BEFORE UPDATE ON BooksAuditEvent
BEGIN
  SELECT RAISE(ABORT, 'books: audit events are append-only');
END;
-- @@
CREATE TRIGGER IF NOT EXISTS books_audit_no_delete
BEFORE DELETE ON BooksAuditEvent
BEGIN
  SELECT RAISE(ABORT, 'books: audit events are append-only');
END;
