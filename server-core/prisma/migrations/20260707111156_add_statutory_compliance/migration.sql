-- CreateTable
CREATE TABLE "statutory_compliance" (
    "id" SERIAL NOT NULL,
    "employeeId" TEXT NOT NULL,
    "pfNumber" TEXT NOT NULL,
    "pfMonthlyContribution" INTEGER NOT NULL,
    "esicApplicable" BOOLEAN NOT NULL,
    "esicNumber" TEXT,
    "esicMonthlyContribution" INTEGER,
    "cghsNumber" TEXT,
    "gratuityEligible" BOOLEAN NOT NULL,
    "gratuityAccrued" INTEGER NOT NULL,
    "tdsMonthlyDeduction" INTEGER NOT NULL,
    "maternityBenefitStatus" TEXT NOT NULL,

    CONSTRAINT "statutory_compliance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holiday_calendar" (
    "id" SERIAL NOT NULL,
    "date" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,

    CONSTRAINT "holiday_calendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_rules" (
    "leaveType" TEXT NOT NULL,
    "entitledDaysPerYear" INTEGER NOT NULL,
    "carryForwardAllowed" BOOLEAN NOT NULL,
    "maxCarryForward" INTEGER NOT NULL,
    "eligibilityNote" TEXT NOT NULL,

    CONSTRAINT "leave_rules_pkey" PRIMARY KEY ("leaveType")
);

-- CreateTable
CREATE TABLE "statutory_deadlines" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "recurrence" TEXT NOT NULL,
    "dueDayOfMonth" INTEGER,
    "dueDate" TEXT,

    CONSTRAINT "statutory_deadlines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "statutory_compliance_employeeId_key" ON "statutory_compliance"("employeeId");

-- AddForeignKey
ALTER TABLE "statutory_compliance" ADD CONSTRAINT "statutory_compliance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
