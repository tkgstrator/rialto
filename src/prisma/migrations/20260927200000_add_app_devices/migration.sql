-- AlterTable
ALTER TABLE "AccessToken" ADD COLUMN     "dailyRequestLimit" INTEGER,
ADD COLUMN     "modelPin" TEXT,
ADD COLUMN     "plan" TEXT;

-- CreateTable
CREATE TABLE "AccessTokenDailyUsage" (
    "accessTokenId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AccessTokenDailyUsage_pkey" PRIMARY KEY ("accessTokenId","day")
);

-- CreateTable
CREATE TABLE "AppDevice" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "signCount" INTEGER NOT NULL DEFAULT 0,
    "environment" TEXT NOT NULL,
    "accessTokenId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppDevice_keyId_key" ON "AppDevice"("keyId");

-- CreateIndex
CREATE UNIQUE INDEX "AppDevice_accessTokenId_key" ON "AppDevice"("accessTokenId");

-- AddForeignKey
ALTER TABLE "AccessTokenDailyUsage" ADD CONSTRAINT "AccessTokenDailyUsage_accessTokenId_fkey" FOREIGN KEY ("accessTokenId") REFERENCES "AccessToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppDevice" ADD CONSTRAINT "AppDevice_accessTokenId_fkey" FOREIGN KEY ("accessTokenId") REFERENCES "AccessToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

