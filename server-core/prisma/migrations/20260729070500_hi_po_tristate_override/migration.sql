-- AlterTable
ALTER TABLE "employees" DROP COLUMN "manualHighPotential",
DROP COLUMN "manualHighPotentialAt",
DROP COLUMN "manualHighPotentialBy",
ADD COLUMN     "hiPoOverride" BOOLEAN,
ADD COLUMN     "hiPoOverrideAt" TIMESTAMP(3),
ADD COLUMN     "hiPoOverrideBy" TEXT;
