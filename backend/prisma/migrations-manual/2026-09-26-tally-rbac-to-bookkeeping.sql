-- Rename the 11 `tools.audit_automation.tally.*` permission codes to
-- `tools.audit_automation.bookkeeping.*`. RolePermission grants follow.
--
-- Excel-to-Tally-XML converter permission (tools.excel_to_tally_xml) is
-- deliberately preserved — that "Tally" is the external Tally ERP file
-- format we export TO, not our internal engine.
--
-- Idempotent: re-running after a full migrate is a no-op because the source
-- rows no longer exist.

BEGIN;

INSERT INTO "Permission" (id, code, description, "createdAt", "updatedAt")
SELECT
  REPLACE(id, '.tally.', '.bookkeeping.'),
  REPLACE(code, '.tally.', '.bookkeeping.'),
  description,
  "createdAt",
  now()
FROM "Permission"
WHERE code LIKE 'tools.audit_automation.tally.%';

UPDATE "RolePermission"
SET "permissionId" = REPLACE("permissionId", '.tally.', '.bookkeeping.')
WHERE "permissionId" LIKE 'perm-tools.audit_automation.tally.%';

DELETE FROM "Permission" WHERE code LIKE 'tools.audit_automation.tally.%';

COMMIT;
