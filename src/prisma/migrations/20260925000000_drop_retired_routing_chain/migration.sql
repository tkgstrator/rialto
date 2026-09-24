-- Contract step of the move to the tier map: drop the per-scenario chain,
-- the scheduler's weight log, and the manual tier override. Ships one
-- release after the build that converted every profile's chain into tier
-- routes at `db seed` (marked on RouterPreferenceProfile.chainBackfilledAt).
--
-- Guard: a profile that still holds chain entries but was never converted
-- would lose its routing here without a trace. That happens only when this
-- release is deployed straight over one older than the converting release.
-- Refuse, and say how to get past it, rather than drop the only copy. The
-- check runs before any DDL, so a refusal leaves the schema untouched;
-- Prisma still records the attempt as failed, hence the resolve step.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "RouterPreferenceProfile" p
    WHERE p."chainBackfilledAt" IS NULL
      AND EXISTS (SELECT 1 FROM "RouterPreferenceEntry" e WHERE e."profileId" = p."id")
  ) THEN
    RAISE EXCEPTION 'A routing profile still holds a chain that was never converted into the tier map. Nothing was dropped. Run: prisma migrate resolve --rolled-back 20260925000000_drop_retired_routing_chain; start the previous release once (its db seed converts every chain); then deploy this one again.';
  END IF;
END $$;

-- DropForeignKey
ALTER TABLE "RouterPreferenceEntry" DROP CONSTRAINT "RouterPreferenceEntry_modelId_fkey";

-- DropForeignKey
ALTER TABLE "RouterPreferenceEntry" DROP CONSTRAINT "RouterPreferenceEntry_profileId_fkey";

-- AlterTable
ALTER TABLE "Model" DROP COLUMN "manualTier";

-- AlterTable
ALTER TABLE "RouterPreferenceProfile" DROP COLUMN "chainBackfilledAt";

-- DropTable
DROP TABLE "RouterPreferenceEntry";

-- DropTable
DROP TABLE "RoutingWeightChange";

-- DropEnum
DROP TYPE "RouterPreferenceKind";

-- DropEnum
DROP TYPE "ScenarioKey";
