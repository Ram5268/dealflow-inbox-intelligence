-- CreateTable
CREATE TABLE "CallQueueEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "priorityScore" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "primaryMatchId" TEXT,
    "contributingMatchIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contributions" JSONB,
    "generationRunId" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallQueueEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "queueEntryId" TEXT,
    "disposition" TEXT NOT NULL,
    "notes" TEXT,
    "durationSec" INTEGER,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CallLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CallQueueEntry_organizationId_generationRunId_idx" ON "CallQueueEntry"("organizationId", "generationRunId");

-- CreateIndex
CREATE INDEX "CallQueueEntry_organizationId_rank_idx" ON "CallQueueEntry"("organizationId", "rank");

-- CreateIndex
CREATE INDEX "CallQueueEntry_generatedAt_idx" ON "CallQueueEntry"("generatedAt");

-- CreateIndex
CREATE INDEX "CallLog_organizationId_initiatedAt_idx" ON "CallLog"("organizationId", "initiatedAt");

-- CreateIndex
CREATE INDEX "CallLog_contactId_initiatedAt_idx" ON "CallLog"("contactId", "initiatedAt");

-- AddForeignKey
ALTER TABLE "CallQueueEntry" ADD CONSTRAINT "CallQueueEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallQueueEntry" ADD CONSTRAINT "CallQueueEntry_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "MojoContact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "MojoContact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
