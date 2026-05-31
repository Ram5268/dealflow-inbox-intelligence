-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "ChatSession" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mojo_raw" (
    "id" SERIAL NOT NULL,
    "mojoId" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "phone" TEXT,
    "phone2" TEXT,
    "email" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zipCode" TEXT,
    "status" TEXT,
    "notes" TEXT,
    "tags" TEXT,
    "mojoList" TEXT,
    "lastCalled" TEXT,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mojo_raw_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MojoContact" (
    "id" TEXT NOT NULL,
    "mojoId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zipCode" TEXT,
    "neighborhood" TEXT,
    "status" TEXT,
    "tags" TEXT[],
    "notes" TEXT,
    "mojoGroup" TEXT,
    "mojoList" TEXT,
    "lastCalled" TIMESTAMP(3),
    "embedding" vector(1536),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "currentLTV" DOUBLE PRECISION,
    "equityBalance" DOUBLE PRECISION,
    "estimatedValue" DOUBLE PRECISION,
    "groups" TEXT[],
    "lastDialDate" TIMESTAMP(3),
    "loanInterestRate" DOUBLE PRECISION,
    "totalLoanBalance" DOUBLE PRECISION,
    "instantlyCampaignId" TEXT,
    "instantlyStatus" TEXT,

    CONSTRAINT "MojoContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstantlyEvent" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "contactId" TEXT,
    "campaignId" TEXT,
    "campaignName" TEXT,
    "eventType" TEXT NOT NULL,
    "payload" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstantlyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "counterpartId" TEXT NOT NULL,
    "counterpartType" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "reason" TEXT,
    "seen" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "rawEmailId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "extractedText" TEXT,
    "parseError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Property" (
    "id" TEXT NOT NULL,
    "normalizedAddress" TEXT NOT NULL,
    "unitNumber" TEXT,
    "neighborhood" TEXT,
    "borough" TEXT,
    "zip" TEXT,
    "propertyType" TEXT,
    "block" TEXT,
    "lot" TEXT,
    "bbl" TEXT,
    "currentOwner" TEXT,
    "lastSaleDate" TEXT,
    "lastSalePrice" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingStatusHistory" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT,
    "opportunityId" TEXT,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyIntelligence" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "dataJson" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "propertyId" TEXT,

    CONSTRAINT "PropertyIntelligence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CriteriaProfile" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT,
    "type" TEXT NOT NULL,
    "agentName" TEXT,
    "agentEmail" TEXT,
    "brokerage" TEXT,
    "neighborhoods" TEXT[],
    "borough" TEXT,
    "minPrice" DOUBLE PRECISION,
    "maxPrice" DOUBLE PRECISION,
    "minBeds" INTEGER,
    "maxBeds" INTEGER,
    "propertyTypes" TEXT[],
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CriteriaProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewQueueItem" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT,
    "rawEmailId" TEXT,
    "flagReason" TEXT NOT NULL,
    "suggestedAction" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "userCorrectedFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewQueueItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIExtractionLog" (
    "id" TEXT NOT NULL,
    "rawEmailId" TEXT,
    "opportunityId" TEXT,
    "idempotencyKey" TEXT,
    "model" TEXT NOT NULL,
    "extractorType" TEXT,
    "extractorVersion" TEXT NOT NULL DEFAULT '1.0',
    "promptVersion" TEXT NOT NULL DEFAULT '1.0',
    "schemaVersion" TEXT NOT NULL DEFAULT '1.0',
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estimatedCostUsd" DOUBLE PRECISION,
    "confidenceScore" DOUBLE PRECISION,
    "durationMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIExtractionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutcomeFeedback" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT,
    "matchId" TEXT,
    "action" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutcomeFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MojoContact_mojoId_key" ON "MojoContact"("mojoId");

-- CreateIndex
CREATE INDEX "Match_seen_idx" ON "Match"("seen");

-- CreateIndex
CREATE INDEX "Match_createdAt_idx" ON "Match"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "Property_normalizedAddress_idx" ON "Property"("normalizedAddress");

-- CreateIndex
CREATE INDEX "Property_bbl_idx" ON "Property"("bbl");

-- CreateIndex
CREATE INDEX "PropertyIntelligence_expiresAt_idx" ON "PropertyIntelligence"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyIntelligence_address_source_key" ON "PropertyIntelligence"("address", "source");

-- CreateIndex
CREATE UNIQUE INDEX "CriteriaProfile_opportunityId_key" ON "CriteriaProfile"("opportunityId");

-- CreateIndex
CREATE INDEX "ReviewQueueItem_status_idx" ON "ReviewQueueItem"("status");

-- CreateIndex
CREATE INDEX "ReviewQueueItem_createdAt_idx" ON "ReviewQueueItem"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AIExtractionLog_idempotencyKey_key" ON "AIExtractionLog"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AIExtractionLog_rawEmailId_idx" ON "AIExtractionLog"("rawEmailId");

-- CreateIndex
CREATE INDEX "AIExtractionLog_createdAt_idx" ON "AIExtractionLog"("createdAt");

-- CreateIndex
CREATE INDEX "OutcomeFeedback_opportunityId_idx" ON "OutcomeFeedback"("opportunityId");

-- AddForeignKey
ALTER TABLE "InstantlyEvent" ADD CONSTRAINT "InstantlyEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "MojoContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingStatusHistory" ADD CONSTRAINT "ListingStatusHistory_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyIntelligence" ADD CONSTRAINT "PropertyIntelligence_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

