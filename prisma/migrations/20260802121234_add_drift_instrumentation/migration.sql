-- CreateTable
CREATE TABLE "DriftInteraction" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "query" TEXT NOT NULL,
    "parsedFilters" JSONB,
    "topCards" JSONB NOT NULL,
    "responseTimeMs" INTEGER NOT NULL,
    "modelUsed" TEXT NOT NULL,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "costUsd" DOUBLE PRECISION,

    CONSTRAINT "DriftInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriftInteractionClick" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "interactionId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "cardKind" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,

    CONSTRAINT "DriftInteractionClick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriftInteractionFeedback" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "interactionId" TEXT NOT NULL,
    "vote" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "DriftInteractionFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DriftInteraction_createdAt_idx" ON "DriftInteraction"("createdAt");

-- CreateIndex
CREATE INDEX "DriftInteractionClick_interactionId_idx" ON "DriftInteractionClick"("interactionId");

-- CreateIndex
CREATE INDEX "DriftInteractionFeedback_interactionId_idx" ON "DriftInteractionFeedback"("interactionId");

-- AddForeignKey
ALTER TABLE "DriftInteractionClick" ADD CONSTRAINT "DriftInteractionClick_interactionId_fkey" FOREIGN KEY ("interactionId") REFERENCES "DriftInteraction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriftInteractionFeedback" ADD CONSTRAINT "DriftInteractionFeedback_interactionId_fkey" FOREIGN KEY ("interactionId") REFERENCES "DriftInteraction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
