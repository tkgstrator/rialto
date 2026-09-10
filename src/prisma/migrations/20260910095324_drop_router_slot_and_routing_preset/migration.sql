-- Drop the scenario-slot selector and the saved Router snapshots.
--
-- RouterSlot was the per-scenario primary/fallback map a second selector
-- read; RoutingPreset stored named snapshots of it. Only the chain
-- (RouterPreferenceProfile / RouterPreferenceEntry) routes now, and the
-- slots are deliberately NOT backfilled into it: a chain the operator
-- did not write is not theirs, and an empty lane routes the caller's own
-- model, which is what an unconfigured install should do.
--
-- One value is carried over. The manual longContext threshold lived on
-- the longContext slot's `params.threshold`; the classifier now reads it
-- from the live profile's `constraints.longContextThreshold`. Copied only
-- when it is actually a number — `null` there meant "auto", which is the
-- constraint's default too.
UPDATE "RouterPreferenceProfile" p
SET "constraints" = COALESCE(p."constraints", '{}'::jsonb)
                    || jsonb_build_object('longContextThreshold', s."params"->'threshold')
FROM "RouterSlot" s
WHERE p."key" = 'live'
  AND s."scenario" = 'longContext'
  AND jsonb_typeof(s."params"->'threshold') = 'number';

-- DropForeignKey
ALTER TABLE "RouterSlot" DROP CONSTRAINT IF EXISTS "RouterSlot_modelId_fkey";

-- DropForeignKey
ALTER TABLE "RouterSlot" DROP CONSTRAINT IF EXISTS "RouterSlot_subagentModelId_fkey";

-- DropTable
DROP TABLE IF EXISTS "RouterSlot";

-- DropTable
DROP TABLE IF EXISTS "RoutingPreset";
