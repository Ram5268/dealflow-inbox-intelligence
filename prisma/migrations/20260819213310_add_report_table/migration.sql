-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "attachedFragment" JSONB,
ADD COLUMN     "attachedReport" JSONB;

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "sections" JSONB NOT NULL,
    "markdown" TEXT NOT NULL,
    "sources" JSONB NOT NULL,
    "sessionId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "buyerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Report_sessionId_idx" ON "Report"("sessionId");

-- CreateIndex
CREATE INDEX "Report_templateId_idx" ON "Report"("templateId");

-- CreateIndex
CREATE INDEX "Report_buyerId_idx" ON "Report"("buyerId");

-- CreateIndex
CREATE INDEX "Report_opportunityId_idx" ON "Report"("opportunityId");

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "ExtractedOpportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
