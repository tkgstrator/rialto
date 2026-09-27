-- AlterTable
ALTER TABLE "AccessToken" ADD COLUMN     "planId" TEXT;

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "models" TEXT[],
    "defaultModel" TEXT NOT NULL,
    "dailyRequestLimit" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthorizedApp" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "appleAppId" TEXT NOT NULL,
    "allowDevelopment" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "planId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthorizedApp_pkey" PRIMARY KEY ("id")
);

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
    "authorizedAppId" TEXT NOT NULL,
    "accessTokenId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_name_key" ON "Plan"("name");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorizedApp_appleAppId_key" ON "AuthorizedApp"("appleAppId");

-- CreateIndex
CREATE UNIQUE INDEX "AppDevice_keyId_key" ON "AppDevice"("keyId");

-- CreateIndex
CREATE UNIQUE INDEX "AppDevice_accessTokenId_key" ON "AppDevice"("accessTokenId");

-- CreateIndex
CREATE INDEX "AppDevice_authorizedAppId_idx" ON "AppDevice"("authorizedAppId");

-- CreateIndex
CREATE INDEX "AccessToken_planId_idx" ON "AccessToken"("planId");

-- AddForeignKey
ALTER TABLE "AccessToken" ADD CONSTRAINT "AccessToken_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorizedApp" ADD CONSTRAINT "AuthorizedApp_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessTokenDailyUsage" ADD CONSTRAINT "AccessTokenDailyUsage_accessTokenId_fkey" FOREIGN KEY ("accessTokenId") REFERENCES "AccessToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppDevice" ADD CONSTRAINT "AppDevice_authorizedAppId_fkey" FOREIGN KEY ("authorizedAppId") REFERENCES "AuthorizedApp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppDevice" ADD CONSTRAINT "AppDevice_accessTokenId_fkey" FOREIGN KEY ("accessTokenId") REFERENCES "AccessToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

