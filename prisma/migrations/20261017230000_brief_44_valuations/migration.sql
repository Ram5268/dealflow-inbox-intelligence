SET lock_timeout = '5s'; -- Brief 44 (engineering precaution): fail within 5 s instead of queueing behind the nightly run or the CRM sync for a lock.

-- CreateTable
CREATE TABLE "ValuationRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "asOf" DATE NOT NULL,
    "dataThrough" DATE NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "gatesPassed" BOOLEAN NOT NULL,
    "gatesJson" JSONB NOT NULL,
    "metricsJson" JSONB NOT NULL,
    "scoreboardJson" JSONB,
    "sourcesJson" JSONB,
    "countsJson" JSONB NOT NULL,
    "expectedRows" INTEGER NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ValuationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyValuation" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "bbl" TEXT,
    "value" DOUBLE PRECISION,
    "low" DOUBLE PRECISION,
    "high" DOUBLE PRECISION,
    "asOf" DATE NOT NULL,
    "reason" TEXT,
    "factsJson" JSONB,
    "compsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropertyValuation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceKey" (
    "id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "ServiceKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ValuationRun_organizationId_published_publishedAt_idx" ON "ValuationRun"("organizationId", "published", "publishedAt");

-- CreateIndex
CREATE INDEX "PropertyValuation_contactId_createdAt_idx" ON "PropertyValuation"("contactId", "createdAt");

-- CreateIndex
CREATE INDEX "PropertyValuation_organizationId_idx" ON "PropertyValuation"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyValuation_runId_contactId_key" ON "PropertyValuation"("runId", "contactId");

-- AddForeignKey
ALTER TABLE "ValuationRun" ADD CONSTRAINT "ValuationRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyValuation" ADD CONSTRAINT "PropertyValuation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ValuationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyValuation" ADD CONSTRAINT "PropertyValuation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyValuation" ADD CONSTRAINT "PropertyValuation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "MojoContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

