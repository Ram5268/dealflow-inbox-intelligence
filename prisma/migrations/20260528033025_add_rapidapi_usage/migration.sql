-- CreateTable
CREATE TABLE "RapidApiUsage" (
    "id" TEXT NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "callsConsumed" INTEGER NOT NULL DEFAULT 0,
    "monthlyBudget" INTEGER NOT NULL DEFAULT 5000,
    "warnedAt80" BOOLEAN NOT NULL DEFAULT false,
    "warnedAt90" BOOLEAN NOT NULL DEFAULT false,
    "warnedAt95" BOOLEAN NOT NULL DEFAULT false,
    "pausedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RapidApiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RapidApiUsage_yearMonth_key" ON "RapidApiUsage"("yearMonth");
