/*
  Warnings:

  - You are about to drop the `AppDevice` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `AuthorizedApp` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "AppDevice" DROP CONSTRAINT "AppDevice_accessTokenId_fkey";

-- DropForeignKey
ALTER TABLE "AppDevice" DROP CONSTRAINT "AppDevice_authorizedAppId_fkey";

-- DropForeignKey
ALTER TABLE "AuthorizedApp" DROP CONSTRAINT "AuthorizedApp_planId_fkey";

-- DropTable
DROP TABLE "AppDevice";

-- DropTable
DROP TABLE "AuthorizedApp";
