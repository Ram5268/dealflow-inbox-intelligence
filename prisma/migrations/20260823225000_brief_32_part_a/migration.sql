-- DropForeignKey
ALTER TABLE "Match" DROP CONSTRAINT "Match_opportunityId_fkey";

-- AlterTable
ALTER TABLE "ExtractedOpportunity" ADD COLUMN     "buyerArchetype" TEXT,
ADD COLUMN     "lotSizeSqft" DOUBLE PRECISION,
ADD COLUMN     "monthlyCommonCharges" DOUBLE PRECISION,
ADD COLUMN     "monthlyMaintenance" DOUBLE PRECISION,
ADD COLUMN     "monthlyTaxes" DOUBLE PRECISION,
ADD COLUMN     "yearBuilt" INTEGER,
ADD COLUMN     "zoningCode" TEXT;

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "captureProbability" DOUBLE PRECISION,
ADD COLUMN     "contributions" JSONB,
ADD COLUMN     "expectedGrossCompensation" DOUBLE PRECISION,
ADD COLUMN     "opportunityType" TEXT NOT NULL DEFAULT 'opportunity',
ADD COLUMN     "unknownFactors" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "MojoContact" ADD COLUMN     "additionalEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "additionalPhones" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "alternateAddress" TEXT,
ADD COLUMN     "batchRankCategory" TEXT,
ADD COLUMN     "buildingSqft" DOUBLE PRECISION,
ADD COLUMN     "coOwnerFullName" TEXT,
ADD COLUMN     "foreclosureAuctionDate" TIMESTAMP(3),
ADD COLUMN     "isVacant" BOOLEAN,
ADD COLUMN     "lastSaleDate" TIMESTAMP(3),
ADD COLUMN     "lastSalePrice" DOUBLE PRECISION,
ADD COLUMN     "lotSizeSqft" DOUBLE PRECISION,
ADD COLUMN     "ownerOccupied" BOOLEAN,
ADD COLUMN     "phoneDncFlags" BOOLEAN[] DEFAULT ARRAY[]::BOOLEAN[],
ADD COLUMN     "phoneTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "preForeclosureStatus" TEXT,
ADD COLUMN     "priorListingBrokerage" TEXT,
ADD COLUMN     "priorListingDom" INTEGER,
ADD COLUMN     "priorListingPrice" DOUBLE PRECISION,
ADD COLUMN     "priorListingStatus" TEXT,
ADD COLUMN     "propertyBaths" DOUBLE PRECISION,
ADD COLUMN     "propertyBeds" DOUBLE PRECISION,
ADD COLUMN     "propertyTypeDetail" TEXT,
ADD COLUMN     "unitCount" INTEGER,
ADD COLUMN     "yearBuilt" INTEGER,
ADD COLUMN     "zoningCode" TEXT;
