-- AlterTable
ALTER TABLE "InboundSurfaceConfig" ADD COLUMN     "deniedTargets" TEXT[] DEFAULT ARRAY[]::TEXT[];
