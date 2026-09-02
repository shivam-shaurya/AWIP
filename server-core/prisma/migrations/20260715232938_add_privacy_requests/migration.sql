-- CreateEnum
CREATE TYPE "PrivacyRequestType" AS ENUM ('Access', 'Correction', 'Erasure');

-- CreateEnum
CREATE TYPE "PrivacyRequestStatus" AS ENUM ('New', 'In Progress', 'Resolved');

-- DropForeignKey
ALTER TABLE "candidate_interviews" DROP CONSTRAINT "candidate_interviews_candidateId_fkey";

-- DropForeignKey
ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_userId_fkey";

-- DropForeignKey
ALTER TABLE "onboarding_tasks" DROP CONSTRAINT "onboarding_tasks_onboardingCaseId_fkey";

-- CreateTable
CREATE TABLE "privacy_requests" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "PrivacyRequestType" NOT NULL,
    "description" TEXT NOT NULL,
    "status" "PrivacyRequestStatus" NOT NULL DEFAULT 'New',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "privacy_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "privacy_requests_employeeId_idx" ON "privacy_requests"("employeeId");

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_interviews" ADD CONSTRAINT "candidate_interviews_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_tasks" ADD CONSTRAINT "onboarding_tasks_onboardingCaseId_fkey" FOREIGN KEY ("onboardingCaseId") REFERENCES "onboarding_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
