-- REPOTIC Phase 2+3 tables. Standalone SQL applied via `prisma db execute`
-- because the main migrate stream also contains unrelated pending changes
-- from other branches that must not be dragged in here.

CREATE TABLE IF NOT EXISTS "RpParsedRow" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "sourceRowIndex" INTEGER NOT NULL,
    "txType" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "invoiceDate" TEXT,
    "invoiceAmount" INTEGER NOT NULL,
    "taxableValue" INTEGER NOT NULL,
    "cgstTax" INTEGER NOT NULL DEFAULT 0,
    "sgstTax" INTEGER NOT NULL DEFAULT 0,
    "igstTax" INTEGER NOT NULL DEFAULT 0,
    "cessTax" INTEGER NOT NULL DEFAULT 0,
    "rate" INTEGER NOT NULL DEFAULT 0,
    "hsn" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "shipToState" TEXT,
    "sellerGstin" TEXT,
    "stateCodeIntra" BOOLEAN NOT NULL DEFAULT false,
    "creditNoteNumber" TEXT,
    "creditNoteDate" TEXT,
    "rawJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RpParsedRow_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RpParsedRow_organisationId_uploadId_idx"
    ON "RpParsedRow"("organisationId", "uploadId");

CREATE INDEX IF NOT EXISTS "RpParsedRow_organisationId_uploadId_txType_idx"
    ON "RpParsedRow"("organisationId", "uploadId", "txType");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'RpParsedRow_uploadId_fkey'
    ) THEN
        ALTER TABLE "RpParsedRow"
            ADD CONSTRAINT "RpParsedRow_uploadId_fkey"
            FOREIGN KEY ("uploadId") REFERENCES "RpEcommerceUpload"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS "RpGstr1Build" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "gstin" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "builtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "builtByUserId" TEXT NOT NULL,
    "tableCountsJson" TEXT NOT NULL,
    "previewJson" TEXT NOT NULL,
    CONSTRAINT "RpGstr1Build_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RpGstr1Build_organisationId_clientId_gstin_period_idx"
    ON "RpGstr1Build"("organisationId", "clientId", "gstin", "period");
