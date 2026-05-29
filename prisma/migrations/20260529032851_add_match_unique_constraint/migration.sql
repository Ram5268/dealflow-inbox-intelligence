-- CreateIndex
CREATE UNIQUE INDEX "Match_opportunityId_counterpartId_counterpartType_key" ON "Match"("opportunityId", "counterpartId", "counterpartType");
