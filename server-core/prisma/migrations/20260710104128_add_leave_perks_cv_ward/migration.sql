-- CreateEnum
CREATE TYPE "PerkType" AS ENUM ('Flexible Hours', 'Sponsored Certification', 'Fast-Track Training', 'Recognition Award', 'Parking Spot', 'Other');

-- AlterEnum
ALTER TYPE "TaskCategory" ADD VALUE 'Development';

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "ward" TEXT;

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveType" TEXT NOT NULL,
    "fromDate" TEXT NOT NULL,
    "toDate" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "perks" (
    "id" SERIAL NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "PerkType" NOT NULL,
    "customLabel" TEXT,
    "note" TEXT,
    "grantedBy" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "perks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "education_records" (
    "id" SERIAL NOT NULL,
    "employeeId" TEXT NOT NULL,
    "degree" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "fieldOfStudy" TEXT,
    "yearCompleted" INTEGER,

    CONSTRAINT "education_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_experience" (
    "id" SERIAL NOT NULL,
    "employeeId" TEXT NOT NULL,
    "organization" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "fromYear" INTEGER,
    "toYear" INTEGER,
    "description" TEXT,

    CONSTRAINT "work_experience_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leave_requests_employeeId_idx" ON "leave_requests"("employeeId");

-- CreateIndex
CREATE INDEX "perks_employeeId_idx" ON "perks"("employeeId");

-- CreateIndex
CREATE INDEX "education_records_employeeId_idx" ON "education_records"("employeeId");

-- CreateIndex
CREATE INDEX "work_experience_employeeId_idx" ON "work_experience"("employeeId");

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perks" ADD CONSTRAINT "perks_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "education_records" ADD CONSTRAINT "education_records_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_experience" ADD CONSTRAINT "work_experience_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
