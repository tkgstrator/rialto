-- CreateTable
CREATE TABLE "RoutingDecision" (
    "id" TEXT NOT NULL,
    "reqId" TEXT NOT NULL,
    "requestBody" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "predictedTier" TEXT,
    "confidence" DOUBLE PRECISION,
    "probabilities" JSONB,
    "chosenProbability" DOUBLE PRECISION,
    "decisionAccepted" BOOLEAN NOT NULL,
    "minConfidence" DOUBLE PRECISION NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "httpStatus" INTEGER,
    "expectedTier" TEXT,
    "evaluationStatus" TEXT NOT NULL DEFAULT 'unrated',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutingDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoutingDecision_reqId_idx" ON "RoutingDecision"("reqId");

-- CreateIndex
CREATE INDEX "RoutingDecision_createdAt_idx" ON "RoutingDecision"("createdAt");
