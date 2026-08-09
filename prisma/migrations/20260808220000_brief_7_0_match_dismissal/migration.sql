-- Brief 7.0 — MatchDismissal table + DismissalReason enum.
-- CreateEnum
CREATE TYPE "DismissalReason" AS ENUM ('WRONG_PRICE', 'WRONG_NEIGHBORHOOD', 'WRONG_TIMING', 'GHOSTED', 'OTHER');

-- CreateTable
CREATE TABLE "MatchDismissal" (
    "id" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedBy" TEXT,
    "dismissalReason" "DismissalReason",
    CONSTRAINT "MatchDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MatchDismissal_partyId_listingId_key" ON "MatchDismissal"("partyId", "listingId");
CREATE INDEX "MatchDismissal_partyId_idx" ON "MatchDismissal"("partyId");
CREATE INDEX "MatchDismissal_listingId_idx" ON "MatchDismissal"("listingId");
