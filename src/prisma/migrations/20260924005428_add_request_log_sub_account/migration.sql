-- AlterTable
ALTER TABLE "RequestLog" ADD COLUMN     "cacheWrite1hTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "subAccountId" TEXT;
