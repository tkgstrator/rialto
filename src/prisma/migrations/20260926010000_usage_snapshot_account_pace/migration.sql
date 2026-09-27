-- Preserve aggregate history without pretending it can be split back into accounts.
ALTER TABLE "UsageSnapshot"
ADD COLUMN "subAccountId" TEXT,
ADD COLUMN "planWeight" DOUBLE PRECISION,
ADD COLUMN "projectedPct" DOUBLE PRECISION;
