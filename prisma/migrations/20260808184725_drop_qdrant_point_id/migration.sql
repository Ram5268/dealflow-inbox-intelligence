/*
  Warnings:

  - You are about to drop the column `qdrantPointId` on the `DocumentChunk` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "DocumentChunk_qdrantPointId_key";

-- AlterTable
ALTER TABLE "DocumentChunk" DROP COLUMN "qdrantPointId";
