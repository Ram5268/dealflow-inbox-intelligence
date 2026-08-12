-- CreateTable
CREATE TABLE "GuardFireEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userTurn" TEXT NOT NULL,
    "priorAssistantTurn" TEXT,
    "assistantAttempt" TEXT NOT NULL,
    "toolCallsAttempted" JSONB NOT NULL,
    "verifierVerdict" TEXT NOT NULL,
    "verifierReason" TEXT,
    "finalResponseSent" TEXT,

    CONSTRAINT "GuardFireEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuardFireEvent_organizationId_createdAt_idx" ON "GuardFireEvent"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "GuardFireEvent_verifierVerdict_idx" ON "GuardFireEvent"("verifierVerdict");
