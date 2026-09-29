/*
  Warnings:

  - You are about to drop the column `dailyRequestLimit` on the `Plan` table. All the data in the column will be lost.
  - You are about to drop the `AccessTokenDailyUsage` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "AccessTokenDailyUsage" DROP CONSTRAINT "AccessTokenDailyUsage_accessTokenId_fkey";

-- AlterTable
ALTER TABLE "Plan" DROP COLUMN "dailyRequestLimit",
ADD COLUMN     "fiveHourRequestLimit" INTEGER,
ADD COLUMN     "fiveHourSpendLimitUsd" DOUBLE PRECISION,
ADD COLUMN     "sevenDayRequestLimit" INTEGER,
ADD COLUMN     "sevenDaySpendLimitUsd" DOUBLE PRECISION;

-- DropTable
DROP TABLE "AccessTokenDailyUsage";

-- CreateTable
CREATE TABLE "AccessTokenUsageWindow" (
    "accessTokenId" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "AccessTokenUsageWindow_pkey" PRIMARY KEY ("accessTokenId","window")
);

-- AddForeignKey
ALTER TABLE "AccessTokenUsageWindow" ADD CONSTRAINT "AccessTokenUsageWindow_accessTokenId_fkey" FOREIGN KEY ("accessTokenId") REFERENCES "AccessToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;
