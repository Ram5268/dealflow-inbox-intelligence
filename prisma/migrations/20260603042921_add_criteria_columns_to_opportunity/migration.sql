-- AlterTable
ALTER TABLE "ExtractedOpportunity" ADD COLUMN     "criteriaActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "dealbreakers" TEXT,
ADD COLUMN     "maxBeds" INTEGER,
ADD COLUMN     "minBeds" INTEGER,
ADD COLUMN     "mustHaves" TEXT,
ADD COLUMN     "neighborhoods" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "propertyTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "timeline" TEXT;

-- CreateIndex
CREATE INDEX "ExtractedOpportunity_neighborhoods_idx" ON "ExtractedOpportunity" USING GIN ("neighborhoods" array_ops);

-- CreateIndex
CREATE INDEX "ExtractedOpportunity_propertyTypes_idx" ON "ExtractedOpportunity" USING GIN ("propertyTypes" array_ops);
