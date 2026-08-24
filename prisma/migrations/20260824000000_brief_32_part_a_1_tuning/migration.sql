-- Brief 32.A.1 — honesty pass. Drops are intentional/safe: the Match regen
-- rewrites every seed row with the new schema.

-- DropColumn (fabricated numeric captureProbability + always-null stub)
ALTER TABLE "Match" DROP COLUMN "captureProbability";
ALTER TABLE "Match" DROP COLUMN "expectedGrossCompensation";

-- AddColumn (honest categorical + confidence meta-signal)
ALTER TABLE "Match" ADD COLUMN "captureStatus" TEXT;
ALTER TABLE "Match" ADD COLUMN "matchFitConfidence" TEXT;

-- AddColumn (buyer-side baths preference — unblocks the baths feature)
ALTER TABLE "ExtractedOpportunity" ADD COLUMN "bathsMin" INTEGER;
ALTER TABLE "ExtractedOpportunity" ADD COLUMN "bathsMax" INTEGER;
