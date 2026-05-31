-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Category" ADD VALUE 'COMING_SOON_RENTAL';
ALTER TYPE "Category" ADD VALUE 'SPONSOR_UNIT';
ALTER TYPE "Category" ADD VALUE 'MARKET_REPORT';
ALTER TYPE "Category" ADD VALUE 'REAL_ESTATE_EVENT';
ALTER TYPE "Category" ADD VALUE 'CLIENT_CONVERSATION';
ALTER TYPE "Category" ADD VALUE 'SHOWING_CONFIRMATION';
ALTER TYPE "Category" ADD VALUE 'COMING_SOON_DEVELOPMENT';

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "sessionId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ExtractedOpportunity" ADD COLUMN     "duplicateOfId" TEXT,
ADD COLUMN     "isTestData" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "processingStatus" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "propertyId" TEXT,
ADD COLUMN     "streetEasyCheckedAt" TIMESTAMP(3),
ADD COLUMN     "streetEasyId" TEXT,
ADD COLUMN     "streetEasyStatus" TEXT;

-- AlterTable
ALTER TABLE "RapidApiUsage" ALTER COLUMN "monthlyBudget" SET DEFAULT 10000;

-- AlterTable
ALTER TABLE "RawEmail" ADD COLUMN     "classifierCategory" TEXT,
ADD COLUMN     "classifierConfidence" DOUBLE PRECISION,
ADD COLUMN     "classifierStatus" TEXT,
ADD COLUMN     "embeddedAt" TIMESTAMP(3),
ADD COLUMN     "extractionAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "extractionStatus" TEXT,
ADD COLUMN     "extractorType" TEXT,
ADD COLUMN     "extractorVersion" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "lastProcessedAt" TIMESTAMP(3),
ADD COLUMN     "matchedAt" TIMESTAMP(3),
ADD COLUMN     "processingError" TEXT;

-- CreateIndex
CREATE INDEX "ExtractedOpportunity_processingStatus_idx" ON "ExtractedOpportunity"("processingStatus");

-- CreateIndex
CREATE INDEX "ExtractedOpportunity_category_processingStatus_idx" ON "ExtractedOpportunity"("category", "processingStatus");

-- AddForeignKey
ALTER TABLE "ExtractedOpportunity" ADD CONSTRAINT "ExtractedOpportunity_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "ExtractedOpportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_rawEmailId_fkey" FOREIGN KEY ("rawEmailId") REFERENCES "RawEmail"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

