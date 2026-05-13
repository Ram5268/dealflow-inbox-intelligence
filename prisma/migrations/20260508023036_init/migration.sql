-- CreateEnum
CREATE TYPE "Category" AS ENUM ('COMING_SOON_SALE', 'OFF_MARKET_SALE', 'ACTIVE_SALE_LISTING', 'RENTAL_LISTING', 'BUYER_ISO', 'RENTER_INQUIRY', 'SELLER_LEAD', 'LANDLORD_LEAD', 'DEVELOPMENT_INVENTORY', 'OPEN_HOUSE', 'PRICE_DROP', 'BACK_ON_MARKET', 'NOISE');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('SALE', 'RENTAL', 'BUYER_NEED', 'RENTER_NEED', 'SELLER_LEAD', 'LANDLORD_LEAD', 'UNKNOWN');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "microsoftUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectedMailbox" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'microsoft',
    "accessTokenEncrypted" TEXT,
    "refreshTokenEncrypted" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "deltaLink" TEXT,
    "readOnlyMode" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedMailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawEmail" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "mailboxId" TEXT,
    "graphMessageId" TEXT NOT NULL,
    "internetMessageId" TEXT,
    "subject" TEXT NOT NULL,
    "senderName" TEXT,
    "senderEmail" TEXT,
    "receivedDateTime" TIMESTAMP(3) NOT NULL,
    "bodyPreview" TEXT,
    "bodyContent" TEXT,
    "bodyContentType" TEXT,
    "webLink" TEXT,
    "rawJson" JSONB,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RawEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractedOpportunity" (
    "id" TEXT NOT NULL,
    "rawEmailId" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "transactionType" "TransactionType" NOT NULL,
    "propertyType" TEXT,
    "address" TEXT,
    "neighborhood" TEXT,
    "borough" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "price" DOUBLE PRECISION,
    "minPrice" DOUBLE PRECISION,
    "maxPrice" DOUBLE PRECISION,
    "beds" DOUBLE PRECISION,
    "baths" DOUBLE PRECISION,
    "units" DOUBLE PRECISION,
    "squareFeet" DOUBLE PRECISION,
    "availabilityDate" TEXT,
    "sourceAgentName" TEXT,
    "sourceAgentEmail" TEXT,
    "sourceBrokerage" TEXT,
    "clientSide" TEXT,
    "status" TEXT,
    "extractedTitle" TEXT NOT NULL,
    "extractedSummary" TEXT NOT NULL,
    "classificationReason" TEXT NOT NULL,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "isDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "duplicateGroupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractedOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchQuery" (
    "id" TEXT NOT NULL,
    "queryText" TEXT NOT NULL,
    "parsedCriteriaJson" JSONB,
    "resultCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detailsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RawEmail_graphMessageId_key" ON "RawEmail"("graphMessageId");

-- AddForeignKey
ALTER TABLE "ConnectedMailbox" ADD CONSTRAINT "ConnectedMailbox_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawEmail" ADD CONSTRAINT "RawEmail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawEmail" ADD CONSTRAINT "RawEmail_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "ConnectedMailbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedOpportunity" ADD CONSTRAINT "ExtractedOpportunity_rawEmailId_fkey" FOREIGN KEY ("rawEmailId") REFERENCES "RawEmail"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
