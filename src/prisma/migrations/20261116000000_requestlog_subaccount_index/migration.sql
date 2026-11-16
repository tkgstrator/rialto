-- Overview reads two aggregates keyed by subAccountId: the weekly
-- window each account is in and a flat last-30-days. Both filter
-- `subAccountId` first and then restrict by `createdAt`, so the
-- compound (subAccountId, createdAt) index turns the scan into a
-- per-account range lookup instead of a full window scan filtered
-- row by row.
CREATE INDEX "RequestLog_subAccountId_createdAt_idx"
  ON "RequestLog" ("subAccountId", "createdAt");
