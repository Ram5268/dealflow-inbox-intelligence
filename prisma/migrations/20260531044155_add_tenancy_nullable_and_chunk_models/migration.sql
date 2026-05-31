-- AlterTable
ALTER TABLE "AIExtractionLog" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "imageCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "llamaParseJobId" TEXT,
ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "parseProvider" TEXT,
ADD COLUMN     "parsedPages" JSONB,
ADD COLUMN     "tableCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "ChatSession" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "ConnectedMailbox" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "CriteriaProfile" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "ExtractedOpportunity" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "InstantlyEvent" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "ListingStatusHistory" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "MojoContact" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "OutcomeFeedback" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "PropertyIntelligence" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "PushSubscription" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "RawEmail" ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "threadId" TEXT;

-- AlterTable
ALTER TABLE "ReviewQueueItem" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "SearchQuery" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "mojo_raw" ADD COLUMN     "organizationId" TEXT;

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'trial',
    "dpaSignedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentChunk" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "parentEmailId" TEXT,
    "parentAttachmentId" TEXT,
    "parentLinkedResourceId" TEXT,
    "threadId" TEXT,
    "chunkType" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "pageNumber" INTEGER,
    "sectionHeading" TEXT,
    "hasTable" BOOLEAN NOT NULL DEFAULT false,
    "hasImage" BOOLEAN NOT NULL DEFAULT false,
    "tokenCount" INTEGER,
    "embeddingModel" TEXT NOT NULL,
    "embeddingVersion" TEXT NOT NULL,
    "embeddedAt" TIMESTAMP(3),
    "qdrantPointId" TEXT,
    "propertyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailThread" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "graphConversationId" TEXT NOT NULL,
    "subjectRoot" TEXT NOT NULL,
    "participants" TEXT[],
    "firstMessageAt" TIMESTAMP(3) NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkedResource" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "parentEmailId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "fetchStatus" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3),
    "fetchError" TEXT,
    "parsedMarkdown" TEXT,
    "parsedAttachmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkedResource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentChunk_qdrantPointId_key" ON "DocumentChunk"("qdrantPointId");

-- CreateIndex
CREATE INDEX "DocumentChunk_organizationId_chunkType_idx" ON "DocumentChunk"("organizationId", "chunkType");

-- CreateIndex
CREATE INDEX "DocumentChunk_organizationId_parentEmailId_idx" ON "DocumentChunk"("organizationId", "parentEmailId");

-- CreateIndex
CREATE INDEX "DocumentChunk_organizationId_threadId_idx" ON "DocumentChunk"("organizationId", "threadId");

-- CreateIndex
CREATE INDEX "DocumentChunk_organizationId_propertyId_idx" ON "DocumentChunk"("organizationId", "propertyId");

-- CreateIndex
CREATE INDEX "EmailThread_organizationId_lastMessageAt_idx" ON "EmailThread"("organizationId", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailThread_organizationId_graphConversationId_key" ON "EmailThread"("organizationId", "graphConversationId");

-- CreateIndex
CREATE INDEX "LinkedResource_organizationId_parentEmailId_idx" ON "LinkedResource"("organizationId", "parentEmailId");

-- CreateIndex
CREATE INDEX "LinkedResource_fetchStatus_idx" ON "LinkedResource"("fetchStatus");

-- CreateIndex
CREATE INDEX "AIExtractionLog_organizationId_idx" ON "AIExtractionLog"("organizationId");

-- CreateIndex
CREATE INDEX "Attachment_organizationId_idx" ON "Attachment"("organizationId");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_idx" ON "AuditLog"("organizationId");

-- CreateIndex
CREATE INDEX "ChatMessage_organizationId_idx" ON "ChatMessage"("organizationId");

-- CreateIndex
CREATE INDEX "ChatSession_organizationId_idx" ON "ChatSession"("organizationId");

-- CreateIndex
CREATE INDEX "ConnectedMailbox_organizationId_idx" ON "ConnectedMailbox"("organizationId");

-- CreateIndex
CREATE INDEX "CriteriaProfile_organizationId_idx" ON "CriteriaProfile"("organizationId");

-- CreateIndex
CREATE INDEX "ExtractedOpportunity_organizationId_idx" ON "ExtractedOpportunity"("organizationId");

-- CreateIndex
CREATE INDEX "InstantlyEvent_organizationId_idx" ON "InstantlyEvent"("organizationId");

-- CreateIndex
CREATE INDEX "ListingStatusHistory_organizationId_idx" ON "ListingStatusHistory"("organizationId");

-- CreateIndex
CREATE INDEX "Match_organizationId_idx" ON "Match"("organizationId");

-- CreateIndex
CREATE INDEX "MojoContact_organizationId_idx" ON "MojoContact"("organizationId");

-- CreateIndex
CREATE INDEX "OutcomeFeedback_organizationId_idx" ON "OutcomeFeedback"("organizationId");

-- CreateIndex
CREATE INDEX "Property_organizationId_idx" ON "Property"("organizationId");

-- CreateIndex
CREATE INDEX "PropertyIntelligence_organizationId_idx" ON "PropertyIntelligence"("organizationId");

-- CreateIndex
CREATE INDEX "PushSubscription_organizationId_idx" ON "PushSubscription"("organizationId");

-- CreateIndex
CREATE INDEX "RawEmail_organizationId_idx" ON "RawEmail"("organizationId");

-- CreateIndex
CREATE INDEX "RawEmail_threadId_idx" ON "RawEmail"("threadId");

-- CreateIndex
CREATE INDEX "ReviewQueueItem_organizationId_idx" ON "ReviewQueueItem"("organizationId");

-- CreateIndex
CREATE INDEX "SearchQuery_organizationId_idx" ON "SearchQuery"("organizationId");

-- CreateIndex
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- CreateIndex
CREATE INDEX "mojo_raw_organizationId_idx" ON "mojo_raw"("organizationId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectedMailbox" ADD CONSTRAINT "ConnectedMailbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawEmail" ADD CONSTRAINT "RawEmail_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawEmail" ADD CONSTRAINT "RawEmail_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "EmailThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedOpportunity" ADD CONSTRAINT "ExtractedOpportunity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchQuery" ADD CONSTRAINT "SearchQuery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mojo_raw" ADD CONSTRAINT "mojo_raw_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MojoContact" ADD CONSTRAINT "MojoContact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstantlyEvent" ADD CONSTRAINT "InstantlyEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingStatusHistory" ADD CONSTRAINT "ListingStatusHistory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyIntelligence" ADD CONSTRAINT "PropertyIntelligence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CriteriaProfile" ADD CONSTRAINT "CriteriaProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewQueueItem" ADD CONSTRAINT "ReviewQueueItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIExtractionLog" ADD CONSTRAINT "AIExtractionLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutcomeFeedback" ADD CONSTRAINT "OutcomeFeedback_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_parentAttachmentId_fkey" FOREIGN KEY ("parentAttachmentId") REFERENCES "Attachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_parentLinkedResourceId_fkey" FOREIGN KEY ("parentLinkedResourceId") REFERENCES "LinkedResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkedResource" ADD CONSTRAINT "LinkedResource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
