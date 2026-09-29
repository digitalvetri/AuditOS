-- PAYROLL DATABASE INVARIANTS
--
-- PayrollRun periods are one calendar month: start on day 1 and end on the
-- last day of the SAME month. Enforced at the DB so a caller that skips the
-- application-level derivation (raw SQL, a legacy client, a bug) still
-- cannot create the 2026-12-30 → 2027-01-30 shape.
--
-- Idempotent — every statement DROP+ADD.
-- @@
ALTER TABLE "PayrollRun" DROP CONSTRAINT IF EXISTS "payroll_run_period_shape";
-- @@
-- period_start is the first day of a month AND period_end is the last day
-- of the same month. The three-way OR covers the four month lengths that
-- ever appear (28, 29, 30, 31). Only February in a leap year hits day 29,
-- so the day-28 arm alone would refuse 2024-02-29; we allow both.
ALTER TABLE "PayrollRun" ADD CONSTRAINT "payroll_run_period_shape"
  CHECK (
    "periodStart" ~ '^\d{4}-\d{2}-01$'
    AND SUBSTRING("periodStart" FROM 1 FOR 7) = SUBSTRING("periodEnd" FROM 1 FOR 7)
    AND (
      "periodEnd" ~ '^\d{4}-\d{2}-28$' OR
      "periodEnd" ~ '^\d{4}-\d{2}-29$' OR
      "periodEnd" ~ '^\d{4}-\d{2}-30$' OR
      "periodEnd" ~ '^\d{4}-\d{2}-31$'
    )
  );
-- @@
-- Uniqueness on (periodStart, periodEnd) already exists via @@unique; add
-- an index on periodStart to keep the "runs for month" lookup fast.
CREATE INDEX IF NOT EXISTS "payroll_run_period_start_idx"
  ON "PayrollRun" ("periodStart");
