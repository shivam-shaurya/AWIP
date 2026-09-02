-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('Active', 'On Leave', 'Suspended', 'Deputation');

-- CreateEnum
CREATE TYPE "TaskCategory" AS ENUM ('Inspection', 'Survey', 'Maintenance', 'Approval', 'Audit', 'Drive');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('High', 'Medium', 'Low');

-- CreateEnum
CREATE TYPE "SlaStatus" AS ENUM ('On Track', 'At Risk', 'Breached');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('Pending', 'In Progress', 'Escalated', 'Overdue', 'Completed');

-- CreateEnum
CREATE TYPE "DelayRisk" AS ENUM ('Low', 'Medium', 'High');

-- CreateEnum
CREATE TYPE "DocStatus" AS ENUM ('Verified', 'Pending Review', 'Missing');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('HR Admin', 'Department Head');

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "cadre" TEXT NOT NULL,
    "doj" TEXT NOT NULL,
    "retirement" TEXT NOT NULL,
    "status" "EmployeeStatus" NOT NULL,
    "posting" TEXT NOT NULL,
    "promotionDue" BOOLEAN NOT NULL DEFAULT false,
    "retirementDue" BOOLEAN NOT NULL DEFAULT false,
    "appraisalPending" BOOLEAN NOT NULL DEFAULT false,
    "trainingPending" BOOLEAN NOT NULL DEFAULT false,
    "missingDocs" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "project" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "TaskCategory" NOT NULL,
    "employeeId" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "priority" "TaskPriority" NOT NULL,
    "dueIn" INTEGER NOT NULL,
    "tatDays" INTEGER NOT NULL,
    "slaStatus" "SlaStatus" NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL,
    "aiSummary" TEXT NOT NULL,
    "delayRisk" "DelayRisk" NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_book_entries" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "ocrScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "DocStatus" NOT NULL,

    CONSTRAINT "service_book_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_summary" (
    "id" SERIAL NOT NULL,
    "totalDisbursement" TEXT NOT NULL,
    "processedEmployees" INTEGER NOT NULL,
    "pendingApprovals" INTEGER NOT NULL,
    "arrearsPending" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_summary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "initials" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_book_entries" ADD CONSTRAINT "service_book_entries_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
