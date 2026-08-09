-- CreateEnum
CREATE TYPE "MatchTier" AS ENUM ('HOT', 'WARM', 'POSSIBLE');

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "tier" "MatchTier";
