-- Brief 7.2 — Mojo restructure: intent + buyer/renter criteria columns,
-- metadata catch-all, and the raw Zapier ingest log.

-- AlterTable
ALTER TABLE "MojoContact"
    ADD COLUMN "isTestData" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "intent" TEXT DEFAULT 'SELLER',
    ADD COLUMN "bedsMin" INTEGER,
    ADD COLUMN "bedsMax" INTEGER,
    ADD COLUMN "budgetMin" DOUBLE PRECISION,
    ADD COLUMN "budgetMax" DOUBLE PRECISION,
    ADD COLUMN "cashOnly" BOOLEAN,
    ADD COLUMN "timing" TEXT,
    ADD COLUMN "initialNeighborhood" TEXT,
    ADD COLUMN "metadata" JSONB;

-- Backfill: every existing row is a seller lead until proven otherwise.
UPDATE "MojoContact" SET "intent" = 'SELLER' WHERE "intent" IS NULL;

-- CreateTable
CREATE TABLE "zapier_ingest_log" (
    "id" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT NOT NULL,
    "headers" JSONB NOT NULL,
    "body" JSONB NOT NULL,
    "resultStatus" TEXT NOT NULL DEFAULT 'pending',
    "resultReason" TEXT,
    "resultContactId" TEXT,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "zapier_ingest_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "zapier_ingest_log_organizationId_receivedAt_idx" ON "zapier_ingest_log"("organizationId", "receivedAt");

-- AddForeignKey
ALTER TABLE "zapier_ingest_log" ADD CONSTRAINT "zapier_ingest_log_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
