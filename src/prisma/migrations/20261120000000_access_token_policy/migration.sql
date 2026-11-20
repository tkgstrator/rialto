CREATE TYPE "TokenProviderMode" AS ENUM ('system', 'subscription_only', 'api_key_only', 'subscription_first', 'api_key_first');

CREATE TABLE "AccessTokenFolder" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "parentId" TEXT REFERENCES "AccessTokenFolder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "defaultPlanId" TEXT REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "defaultProviderMode" "TokenProviderMode" NOT NULL DEFAULT 'system',
  "defaultProviderFallback" BOOLEAN NOT NULL DEFAULT false
);

ALTER TABLE "AccessToken"
  ADD COLUMN "folderId" TEXT REFERENCES "AccessTokenFolder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN "restrictModels" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "allowedModels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "providerMode" "TokenProviderMode" NOT NULL DEFAULT 'system',
  ADD COLUMN "providerFallback" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "AccessTokenFolder_parentId_idx" ON "AccessTokenFolder"("parentId");
CREATE INDEX "AccessTokenFolder_defaultPlanId_idx" ON "AccessTokenFolder"("defaultPlanId");
CREATE INDEX "AccessToken_folderId_idx" ON "AccessToken"("folderId");

INSERT INTO "Model" ("id", "providerId", "name", "inputPer1M", "outputPer1M", "cachedInputPer1M", "updatedAt")
SELECT 'openai-image-' || model.name || '-' || provider.id, provider.id, model.name, 5, 30, 1.25, CURRENT_TIMESTAMP
FROM "Provider" provider
CROSS JOIN (VALUES ('gpt-image-2.6-flare'), ('gpt-image-2.6-sunburst')) AS model(name)
WHERE provider.name = 'openai' AND provider."authMode" = 'api_key'
  AND provider."apiBaseUrl" ~ '^https://api[.]openai[.]com/v1(/(chat/completions|responses))?/?$'
ON CONFLICT ("providerId", "name") DO UPDATE
SET "inputPer1M" = COALESCE("Model"."inputPer1M", EXCLUDED."inputPer1M"),
    "outputPer1M" = COALESCE("Model"."outputPer1M", EXCLUDED."outputPer1M"),
    "cachedInputPer1M" = COALESCE("Model"."cachedInputPer1M", EXCLUDED."cachedInputPer1M");
