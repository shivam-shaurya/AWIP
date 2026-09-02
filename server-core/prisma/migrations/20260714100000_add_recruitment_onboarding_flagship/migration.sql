-- AlterTable: flagship tier marker + skill acquisition date
ALTER TABLE "employees" ADD COLUMN "isFlagship" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "employee_skills" ADD COLUMN "acquiredDate" TEXT;

-- CreateTable: Recruitment pipeline
CREATE TABLE "candidates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "department" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "vacancyId" INTEGER,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "appliedDate" TEXT NOT NULL,
    "resumeScore" INTEGER,
    "experienceYears" DOUBLE PRECISION,
    "expectedCtc" INTEGER,
    "aiSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "candidates_department_idx" ON "candidates"("department");
CREATE INDEX "candidates_vacancyId_idx" ON "candidates"("vacancyId");
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_vacancyId_fkey"
  FOREIGN KEY ("vacancyId") REFERENCES "vacancies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "candidate_interviews" (
    "id" SERIAL NOT NULL,
    "candidateId" TEXT NOT NULL,
    "round" TEXT NOT NULL,
    "scheduledAt" TEXT NOT NULL,
    "interviewer" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "feedback" TEXT,
    "rating" DOUBLE PRECISION,

    CONSTRAINT "candidate_interviews_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "candidate_interviews_candidateId_idx" ON "candidate_interviews"("candidateId");
ALTER TABLE "candidate_interviews" ADD CONSTRAINT "candidate_interviews_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: Onboarding checklist
CREATE TABLE "onboarding_cases" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT,
    "employeeId" TEXT,
    "name" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "buddyEmployeeId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NotStarted',
    "progressPct" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_cases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "onboarding_cases_candidateId_key" ON "onboarding_cases"("candidateId");
CREATE UNIQUE INDEX "onboarding_cases_employeeId_key" ON "onboarding_cases"("employeeId");
CREATE INDEX "onboarding_cases_department_idx" ON "onboarding_cases"("department");
ALTER TABLE "onboarding_cases" ADD CONSTRAINT "onboarding_cases_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "onboarding_cases" ADD CONSTRAINT "onboarding_cases_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "onboarding_cases" ADD CONSTRAINT "onboarding_cases_buddyEmployeeId_fkey"
  FOREIGN KEY ("buddyEmployeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "onboarding_tasks" (
    "id" SERIAL NOT NULL,
    "onboardingCaseId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "dueDate" TEXT,
    "completedDate" TEXT,
    "assignedTo" TEXT,

    CONSTRAINT "onboarding_tasks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "onboarding_tasks_onboardingCaseId_idx" ON "onboarding_tasks"("onboardingCaseId");
ALTER TABLE "onboarding_tasks" ADD CONSTRAINT "onboarding_tasks_onboardingCaseId_fkey"
  FOREIGN KEY ("onboardingCaseId") REFERENCES "onboarding_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
