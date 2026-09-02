-- AlterTable
ALTER TABLE "service_book_entries" ADD COLUMN     "description" TEXT;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "eta" TEXT,
ADD COLUMN     "lastReassignReason" TEXT,
ADD COLUMN     "lastReassignedAt" TEXT,
ADD COLUMN     "lastReassignedFrom" TEXT,
ADD COLUMN     "milestone" TEXT,
ADD COLUMN     "projectedCompletion" TEXT,
ADD COLUMN     "sow" TEXT;

-- CreateTable
CREATE TABLE "employee_assets" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "assignedDate" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "serialNo" TEXT,

    CONSTRAINT "employee_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_events" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "date" TEXT NOT NULL,
    "description" TEXT,
    "awardedBy" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "employee_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_finance" (
    "id" SERIAL NOT NULL,
    "department" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "allocatedBudget" INTEGER NOT NULL,
    "amountSpent" INTEGER NOT NULL,
    "category" TEXT,

    CONSTRAINT "department_finance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_assets_employeeId_idx" ON "employee_assets"("employeeId");

-- CreateIndex
CREATE INDEX "employee_events_employeeId_idx" ON "employee_events"("employeeId");

-- CreateIndex
CREATE INDEX "department_finance_department_idx" ON "department_finance"("department");

-- CreateIndex
CREATE UNIQUE INDEX "department_finance_department_month_category_key" ON "department_finance"("department", "month", "category");

-- CreateIndex
CREATE INDEX "service_book_entries_employeeId_idx" ON "service_book_entries"("employeeId");

-- AddForeignKey
ALTER TABLE "employee_assets" ADD CONSTRAINT "employee_assets_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_events" ADD CONSTRAINT "employee_events_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
