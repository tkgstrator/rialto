-- Routed mode is gone: every inbound surface sends the model the caller
-- names, so the tables that held the routing tables, their per-provider
-- aliases and the per-token / per-surface profile pointers have no reader.
-- Plan, AccessToken and their usage windows are not touched.

-- DropForeignKey
ALTER TABLE "ProviderTierAlias" DROP CONSTRAINT "ProviderTierAlias_modelId_fkey";

-- DropForeignKey
ALTER TABLE "ProviderTierAlias" DROP CONSTRAINT "ProviderTierAlias_providerId_fkey";

-- DropForeignKey
ALTER TABLE "RouterPreferenceEntry" DROP CONSTRAINT "RouterPreferenceEntry_modelId_fkey";

-- DropForeignKey
ALTER TABLE "RouterPreferenceEntry" DROP CONSTRAINT "RouterPreferenceEntry_profileId_fkey";

-- DropForeignKey
ALTER TABLE "TierRoute" DROP CONSTRAINT "TierRoute_profileId_fkey";

-- DropForeignKey
ALTER TABLE "TierRoute" DROP CONSTRAINT "TierRoute_providerId_fkey";

-- AlterTable
ALTER TABLE "AccessToken" DROP COLUMN "profileKey";

-- AlterTable
ALTER TABLE "InboundSurfaceConfig" DROP COLUMN "profileKey",
DROP COLUMN "routingMode";

-- DropTable
DROP TABLE "ProviderTierAlias";

-- DropTable
DROP TABLE "RouterPreferenceEntry";

-- DropTable
DROP TABLE "RouterPreferenceProfile";

-- DropTable
DROP TABLE "TierRoute";

-- DropEnum
DROP TYPE "RouterPreferenceKind";

-- DropEnum
DROP TYPE "ScenarioKey";
