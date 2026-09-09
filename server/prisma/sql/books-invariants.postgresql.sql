-- BOOKS INVARIANTS — PostgreSQL twin of books-invariants.sqlite.sql.
-- Same rules, expressed as trigger functions. Written for the provider
-- switch; the development database is SQLite, so treat this as reviewed
-- but not yet exercised by the test-suite.

CREATE OR REPLACE FUNCTION books_journal_no_direct_post() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'books: a journal is inserted as draft and posted by update';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
-- @@
DROP TRIGGER IF EXISTS books_journal_no_direct_post ON "BooksJournal";
-- @@
CREATE TRIGGER books_journal_no_direct_post BEFORE INSERT ON "BooksJournal"
FOR EACH ROW EXECUTE FUNCTION books_journal_no_direct_post();
-- @@
CREATE OR REPLACE FUNCTION books_journal_guard_update() RETURNS trigger AS $$
DECLARE d BIGINT; c BIGINT; n INT; foreign_lines INT;
BEGIN
  IF NOT (
    (OLD.status = 'draft' AND NEW.status IN ('draft', 'posted'))
    OR (OLD.status = 'posted' AND NEW.status IN ('posted', 'void'))
    OR (OLD.status = 'void' AND NEW.status = 'void')
  ) THEN
    RAISE EXCEPTION 'books: illegal journal status transition';
  END IF;
  IF OLD.status IN ('posted', 'void') AND (
    NEW.date IS DISTINCT FROM OLD.date OR NEW.number IS DISTINCT FROM OLD.number
    OR NEW."voucherType" IS DISTINCT FROM OLD."voucherType" OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW."exchangeRate" IS DISTINCT FROM OLD."exchangeRate" OR NEW."totalDebit" IS DISTINCT FROM OLD."totalDebit"
    OR NEW."totalCredit" IS DISTINCT FROM OLD."totalCredit" OR NEW."sourceModule" IS DISTINCT FROM OLD."sourceModule"
    OR NEW."sourceId" IS DISTINCT FROM OLD."sourceId" OR NEW."booksOrgId" IS DISTINCT FROM OLD."booksOrgId"
  ) THEN
    RAISE EXCEPTION 'books: a posted journal cannot be edited; void it and post a new one';
  END IF;
  IF NEW.status = 'posted' AND OLD.status = 'draft' THEN
    SELECT COUNT(*), COALESCE(SUM(CASE WHEN side = 'debit' THEN amount ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN side = 'credit' THEN amount ELSE 0 END), 0),
           COUNT(*) FILTER (WHERE "booksOrgId" <> NEW."booksOrgId")
      INTO n, d, c, foreign_lines FROM "BooksJournalLine" WHERE "journalId" = NEW.id;
    IF n < 2 THEN RAISE EXCEPTION 'books: journal needs at least two lines'; END IF;
    IF d <> c THEN RAISE EXCEPTION 'books: journal is not balanced'; END IF;
    IF foreign_lines > 0 THEN RAISE EXCEPTION 'books: journal lines belong to another set of books'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
-- @@
DROP TRIGGER IF EXISTS books_journal_guard_update ON "BooksJournal";
-- @@
CREATE TRIGGER books_journal_guard_update BEFORE UPDATE ON "BooksJournal"
FOR EACH ROW EXECUTE FUNCTION books_journal_guard_update();
-- @@
CREATE OR REPLACE FUNCTION books_journal_no_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'books: posted journals are never deleted'; END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
-- @@
DROP TRIGGER IF EXISTS books_journal_no_delete ON "BooksJournal";
-- @@
CREATE TRIGGER books_journal_no_delete BEFORE DELETE ON "BooksJournal"
FOR EACH ROW EXECUTE FUNCTION books_journal_no_delete();
-- @@
CREATE OR REPLACE FUNCTION books_line_guard() RETURNS trigger AS $$
DECLARE st TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.amount <= 0 OR NEW."fxAmount" <= 0 OR NEW.side NOT IN ('debit', 'credit') THEN
      RAISE EXCEPTION 'books: line amount must be positive and side debit or credit';
    END IF;
    SELECT status INTO st FROM "BooksJournal" WHERE id = NEW."journalId";
    IF st <> 'draft' THEN RAISE EXCEPTION 'books: cannot add a line to a posted journal'; END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT status INTO st FROM "BooksJournal" WHERE id = OLD."journalId";
    IF st <> 'draft' AND (
      NEW."journalId" IS DISTINCT FROM OLD."journalId" OR NEW."booksOrgId" IS DISTINCT FROM OLD."booksOrgId"
      OR NEW."lineNo" IS DISTINCT FROM OLD."lineNo" OR NEW."ledgerId" IS DISTINCT FROM OLD."ledgerId"
      OR NEW.side IS DISTINCT FROM OLD.side OR NEW.amount IS DISTINCT FROM OLD.amount
      OR NEW."fxCurrency" IS DISTINCT FROM OLD."fxCurrency" OR NEW."fxAmount" IS DISTINCT FROM OLD."fxAmount"
      OR NEW."exchangeRate" IS DISTINCT FROM OLD."exchangeRate" OR NEW."partyLedgerId" IS DISTINCT FROM OLD."partyLedgerId"
      OR NEW."taxRateId" IS DISTINCT FROM OLD."taxRateId"
    ) THEN
      RAISE EXCEPTION 'books: cannot change a line of a posted journal';
    END IF;
    RETURN NEW;
  ELSE
    SELECT status INTO st FROM "BooksJournal" WHERE id = OLD."journalId";
    IF st <> 'draft' THEN RAISE EXCEPTION 'books: cannot delete a line of a posted journal'; END IF;
    RETURN OLD;
  END IF;
END $$ LANGUAGE plpgsql;
-- @@
DROP TRIGGER IF EXISTS books_line_guard ON "BooksJournalLine";
-- @@
CREATE TRIGGER books_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "BooksJournalLine"
FOR EACH ROW EXECUTE FUNCTION books_line_guard();
-- @@
CREATE OR REPLACE FUNCTION books_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'books: audit events are append-only';
END $$ LANGUAGE plpgsql;
-- @@
DROP TRIGGER IF EXISTS books_audit_append_only ON "BooksAuditEvent";
-- @@
CREATE TRIGGER books_audit_append_only BEFORE UPDATE OR DELETE ON "BooksAuditEvent"
FOR EACH ROW EXECUTE FUNCTION books_audit_append_only();
