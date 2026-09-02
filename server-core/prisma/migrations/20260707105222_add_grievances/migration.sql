-- CreateEnum
CREATE TYPE "GrievanceCategory" AS ENUM ('Harassment', 'Payroll', 'Facilities', 'Management', 'Peer Conflict');

-- CreateEnum
CREATE TYPE "GrievanceSeverity" AS ENUM ('Critical', 'High', 'Medium', 'Low');

-- CreateEnum
CREATE TYPE "GrievanceSentiment" AS ENUM ('Hostile', 'Frustrated', 'Neutral', 'Anxious');

-- CreateEnum
CREATE TYPE "GrievanceStatus" AS ENUM ('New', 'Under Investigation', 'Resolved', 'Escalated');

-- CreateTable
CREATE TABLE "grievances" (
    "id" TEXT NOT NULL,
    "category" "GrievanceCategory" NOT NULL,
    "submitterId" TEXT,
    "isAnonymous" BOOLEAN NOT NULL DEFAULT false,
    "department" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "aiSummary" TEXT,
    "severity" "GrievanceSeverity" NOT NULL,
    "sentiment" "GrievanceSentiment" NOT NULL,
    "status" "GrievanceStatus" NOT NULL DEFAULT 'New',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grievances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grievance_updates" (
    "id" SERIAL NOT NULL,
    "grievanceId" TEXT NOT NULL,
    "status" "GrievanceStatus" NOT NULL,
    "note" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grievance_updates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "grievances_submitterId_idx" ON "grievances"("submitterId");

-- CreateIndex
CREATE INDEX "grievance_updates_grievanceId_idx" ON "grievance_updates"("grievanceId");

-- AddForeignKey
ALTER TABLE "grievances" ADD CONSTRAINT "grievances_submitterId_fkey" FOREIGN KEY ("submitterId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grievance_updates" ADD CONSTRAINT "grievance_updates_grievanceId_fkey" FOREIGN KEY ("grievanceId") REFERENCES "grievances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
