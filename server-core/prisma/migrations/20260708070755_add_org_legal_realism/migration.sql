-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "disciplinaryFlag" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "disciplinaryNote" TEXT;

-- CreateTable
CREATE TABLE "department_profiles" (
    "department" TEXT NOT NULL,
    "headName" TEXT NOT NULL,
    "headTitle" TEXT NOT NULL,
    "budgetCr" DOUBLE PRECISION NOT NULL,
    "auditStatus" TEXT NOT NULL,
    "lastAuditDate" TEXT NOT NULL,

    CONSTRAINT "department_profiles_pkey" PRIMARY KEY ("department")
);

-- CreateTable
CREATE TABLE "vacancies" (
    "id" SERIAL NOT NULL,
    "department" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "sanctioned" INTEGER NOT NULL,

    CONSTRAINT "vacancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "progressPct" INTEGER NOT NULL,
    "startDate" TEXT NOT NULL,
    "targetDate" TEXT NOT NULL,
    "budgetCr" DOUBLE PRECISION NOT NULL,
    "leadEmployeeId" TEXT,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_cases" (
    "id" TEXT NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "court" TEXT NOT NULL,
    "filedDate" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "nextHearing" TEXT,
    "exposureLakh" INTEGER NOT NULL,
    "aiSummary" TEXT NOT NULL,

    CONSTRAINT "legal_cases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vacancies_department_idx" ON "vacancies"("department");

-- CreateIndex
CREATE INDEX "projects_department_idx" ON "projects"("department");
