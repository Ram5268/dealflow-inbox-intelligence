/*
  Warnings:

  - Made the column `organizationId` on table `AIExtractionLog` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `Attachment` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `AuditLog` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `ChatMessage` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `ChatSession` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `ConnectedMailbox` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `CriteriaProfile` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `ExtractedOpportunity` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `InstantlyEvent` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `ListingStatusHistory` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `Match` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `MojoContact` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `OutcomeFeedback` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `Property` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `PropertyIntelligence` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `PushSubscription` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `RawEmail` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `ReviewQueueItem` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `SearchQuery` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `User` required. This step will fail if there are existing NULL values in that column.
  - Made the column `organizationId` on table `mojo_raw` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "AIExtractionLog" DROP CONSTRAINT "AIExtractionLog_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "Attachment" DROP CONSTRAINT "Attachment_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "ChatMessage" DROP CONSTRAINT "ChatMessage_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "ChatSession" DROP CONSTRAINT "ChatSession_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "ConnectedMailbox" DROP CONSTRAINT "ConnectedMailbox_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "CriteriaProfile" DROP CONSTRAINT "CriteriaProfile_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "ExtractedOpportunity" DROP CONSTRAINT "ExtractedOpportunity_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "InstantlyEvent" DROP CONSTRAINT "InstantlyEvent_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "ListingStatusHistory" DROP CONSTRAINT "ListingStatusHistory_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "Match" DROP CONSTRAINT "Match_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "MojoContact" DROP CONSTRAINT "MojoContact_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "OutcomeFeedback" DROP CONSTRAINT "OutcomeFeedback_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "Property" DROP CONSTRAINT "Property_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "PropertyIntelligence" DROP CONSTRAINT "PropertyIntelligence_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "PushSubscription" DROP CONSTRAINT "PushSubscription_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "RawEmail" DROP CONSTRAINT "RawEmail_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewQueueItem" DROP CONSTRAINT "ReviewQueueItem_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "SearchQuery" DROP CONSTRAINT "SearchQuery_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "mojo_raw" DROP CONSTRAINT "mojo_raw_organizationId_fkey";

-- AlterTable
ALTER TABLE "AIExtractionLog" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Attachment" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "AuditLog" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ChatMessage" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ChatSession" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ConnectedMailbox" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CriteriaProfile" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ExtractedOpportunity" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "InstantlyEvent" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ListingStatusHistory" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Match" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "MojoContact" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "OutcomeFeedback" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Property" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PropertyIntelligence" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PushSubscription" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "RawEmail" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ReviewQueueItem" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "SearchQuery" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "mojo_raw" ALTER COLUMN "organizationId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectedMailbox" ADD CONSTRAINT "ConnectedMailbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawEmail" ADD CONSTRAINT "RawEmail_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedOpportunity" ADD CONSTRAINT "ExtractedOpportunity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchQuery" ADD CONSTRAINT "SearchQuery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mojo_raw" ADD CONSTRAINT "mojo_raw_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MojoContact" ADD CONSTRAINT "MojoContact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstantlyEvent" ADD CONSTRAINT "InstantlyEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingStatusHistory" ADD CONSTRAINT "ListingStatusHistory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyIntelligence" ADD CONSTRAINT "PropertyIntelligence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CriteriaProfile" ADD CONSTRAINT "CriteriaProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewQueueItem" ADD CONSTRAINT "ReviewQueueItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIExtractionLog" ADD CONSTRAINT "AIExtractionLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutcomeFeedback" ADD CONSTRAINT "OutcomeFeedback_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
