-- Multiple inbound surfaces per access token.
--
-- `surface` held one id, or NULL for "every surface". A client that
-- legitimately speaks two — Codex uses /v1/responses and
-- /v1/chat/completions — could then only be given an unscoped token,
-- which is the scoping switched off rather than widened.
--
-- Hand-written rather than generated so the backfill sits between the
-- add and the drop: `prisma migrate diff` emits the two ALTERs alone,
-- which would silently unpin every scoped token.
ALTER TABLE "AccessToken" ADD COLUMN "surfaces" TEXT[];

-- A pinned token stays pinned; an unscoped one becomes an explicit empty
-- array rather than SQL NULL, so "every surface" has one representation.
UPDATE "AccessToken" SET "surfaces" = ARRAY["surface"] WHERE "surface" IS NOT NULL;
UPDATE "AccessToken" SET "surfaces" = ARRAY[]::TEXT[] WHERE "surface" IS NULL;

ALTER TABLE "AccessToken" DROP COLUMN "surface";
