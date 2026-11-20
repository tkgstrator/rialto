ALTER TABLE "Provider"
ADD COLUMN "organizationId" TEXT,
ADD COLUMN "workspaceId" TEXT;

UPDATE "Provider"
SET "displayName" = NULL
WHERE "name" ~ '^anthropic-key-[a-f0-9]{32}$'
  AND "displayName" = 'anthropic · ' || substring("name" from 15 for 6);
