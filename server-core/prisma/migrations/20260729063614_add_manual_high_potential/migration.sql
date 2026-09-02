-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "manualHighPotential" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "manualHighPotentialAt" TIMESTAMP(3),
ADD COLUMN     "manualHighPotentialBy" TEXT;
