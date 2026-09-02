-- AlterTable
ALTER TABLE "performance_records" ADD COLUMN "reviewComments" TEXT;
ALTER TABLE "performance_records" ADD COLUMN "reviewedBy" TEXT;

-- AlterTable
ALTER TABLE "vacancies" ADD COLUMN "criticality" TEXT;
ALTER TABLE "vacancies" ADD COLUMN "note" TEXT;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "description" TEXT;

-- AlterTable
ALTER TABLE "department_profiles" ADD COLUMN "headEmployeeId" TEXT;
ALTER TABLE "department_profiles" ADD COLUMN "riskNote" TEXT;
