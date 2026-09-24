-- Re-key the stored routes by scenario and lane instead of by the tier the
-- caller asked for. A requested tier is not a scenario, so the rows keyed
-- that way cannot be carried over; they are dropped, and every profile's
-- conversion mark is cleared so the next `db seed` converts its old chain
-- (RouterPreferenceEntry, still intact) again — this time for default,
-- think and longContext, in both the agent and the subagent lane.
DELETE FROM "TierRoute";

-- DropIndex
DROP INDEX "TierRoute_profileId_requestedTier_priority_key";

-- DropIndex
DROP INDEX "TierRoute_profileId_requestedTier_providerId_targetTier_key";

-- AlterTable
ALTER TABLE "TierRoute" DROP COLUMN "requestedTier",
ADD COLUMN     "lane" TEXT NOT NULL,
ADD COLUMN     "scenario" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "TierRoute_profileId_scenario_lane_priority_key" ON "TierRoute"("profileId", "scenario", "lane", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "TierRoute_profileId_scenario_lane_providerId_targetTier_key" ON "TierRoute"("profileId", "scenario", "lane", "providerId", "targetTier");

-- Convert again at the next seed.
UPDATE "RouterPreferenceProfile" SET "chainBackfilledAt" = NULL;
