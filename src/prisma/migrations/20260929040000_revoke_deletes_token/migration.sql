-- Revoking a token now deletes its row. Rows already revoked go the same way; their
-- RequestLog rows keep the id, and AccessTokenDailyUsage cascades.
DELETE FROM "AccessToken" WHERE "revokedAt" IS NOT NULL;

-- DropIndex
DROP INDEX "AccessToken_revokedAt_idx";

-- AlterTable
ALTER TABLE "AccessToken" DROP COLUMN "revokedAt";
