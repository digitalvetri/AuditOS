-- TASK MODULE DATABASE INVARIANTS
--
-- The rules below are enforced by PostgreSQL, not by application code, so a
-- double-clicked Start button, a retried request or a second browser tab
-- cannot produce two concurrent work sessions on the same task. The service
-- layer checks the same things first and returns a readable error; this is
-- the backstop for the race it cannot see.
--
-- Idempotent: every statement is IF NOT EXISTS / DROP+ADD, so it is safe to
-- run at API start-up, from the seed and from the test harness.
-- @@
CREATE UNIQUE INDEX IF NOT EXISTS "task_one_open_session"
  ON "TaskTimeSession" ("taskId")
  WHERE "endedAt" IS NULL;
-- @@
CREATE UNIQUE INDEX IF NOT EXISTS "employee_one_open_session"
  ON "TaskTimeSession" ("employeeId")
  WHERE "endedAt" IS NULL;
-- @@
ALTER TABLE "TaskTimeSession" DROP CONSTRAINT IF EXISTS "task_session_ends_after_start";
-- @@
ALTER TABLE "TaskTimeSession" ADD CONSTRAINT "task_session_ends_after_start"
  CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt");
-- @@
ALTER TABLE "TaskTimeSession" DROP CONSTRAINT IF EXISTS "task_session_duration_non_negative";
-- @@
ALTER TABLE "TaskTimeSession" ADD CONSTRAINT "task_session_duration_non_negative"
  CHECK ("durationMinutes" IS NULL OR "durationMinutes" >= 0);
-- @@
ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS "task_durations_non_negative";
-- @@
ALTER TABLE "Task" ADD CONSTRAINT "task_durations_non_negative"
  CHECK ("actualMinutes" >= 0 AND "totalPauseMinutes" >= 0
         AND ("estimatedMinutes" IS NULL OR "estimatedMinutes" >= 0));
-- @@
ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS "task_status_known";
-- @@
ALTER TABLE "Task" ADD CONSTRAINT "task_status_known"
  CHECK ("status" IN ('pending', 'in_progress', 'paused', 'completed', 'cancelled',
                      'open', 'blocked', 'done'));
-- @@
ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS "task_priority_known";
-- @@
ALTER TABLE "Task" ADD CONSTRAINT "task_priority_known"
  CHECK ("priority" IN ('low', 'medium', 'high', 'urgent'));
