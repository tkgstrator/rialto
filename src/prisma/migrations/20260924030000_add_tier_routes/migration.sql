-- AlterTable
ALTER TABLE "RouterPreferenceProfile" ADD COLUMN     "chainBackfilledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ProviderTierAlias" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderTierAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TierRoute" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "requestedTier" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "providerId" TEXT NOT NULL,
    "targetTier" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "TierRoute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderTierAlias_modelId_idx" ON "ProviderTierAlias"("modelId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderTierAlias_providerId_tier_key" ON "ProviderTierAlias"("providerId", "tier");

-- CreateIndex
CREATE INDEX "TierRoute_profileId_idx" ON "TierRoute"("profileId");

-- CreateIndex
CREATE INDEX "TierRoute_providerId_idx" ON "TierRoute"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "TierRoute_profileId_requestedTier_priority_key" ON "TierRoute"("profileId", "requestedTier", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "TierRoute_profileId_requestedTier_providerId_targetTier_key" ON "TierRoute"("profileId", "requestedTier", "providerId", "targetTier");

-- AddForeignKey
ALTER TABLE "ProviderTierAlias" ADD CONSTRAINT "ProviderTierAlias_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderTierAlias" ADD CONSTRAINT "ProviderTierAlias_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TierRoute" ADD CONSTRAINT "TierRoute_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "RouterPreferenceProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TierRoute" ADD CONSTRAINT "TierRoute_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
