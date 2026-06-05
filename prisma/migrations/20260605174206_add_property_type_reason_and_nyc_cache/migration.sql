-- AlterTable
ALTER TABLE "ExtractedOpportunity" ADD COLUMN     "propertyTypeReason" TEXT;

-- CreateTable
CREATE TABLE "NycParcelCache" (
    "id" TEXT NOT NULL,
    "normalizedAddress" TEXT NOT NULL,
    "bbl" TEXT,
    "bin" TEXT,
    "borough" TEXT,
    "geosearchConfidence" DOUBLE PRECISION,
    "geosearchLabel" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "bldgclass" TEXT,
    "ownername" TEXT,
    "unitsRes" INTEGER,
    "unitsTotal" INTEGER,
    "yearBuilt" INTEGER,
    "plutoVersion" TEXT,
    "hasCondoDecl" BOOLEAN,
    "propertyType" TEXT,
    "propertyTypeReason" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "NycParcelCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NycParcelCache_normalizedAddress_key" ON "NycParcelCache"("normalizedAddress");

-- CreateIndex
CREATE INDEX "NycParcelCache_organizationId_idx" ON "NycParcelCache"("organizationId");

-- CreateIndex
CREATE INDEX "NycParcelCache_bbl_idx" ON "NycParcelCache"("bbl");

-- AddForeignKey
ALTER TABLE "NycParcelCache" ADD CONSTRAINT "NycParcelCache_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
