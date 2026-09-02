-- AlterTable
ALTER TABLE "users" ADD COLUMN     "employeeId" TEXT;

-- CreateTable
CREATE TABLE "leave_balances" (
    "id" SERIAL NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveType" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "entitled" INTEGER NOT NULL,
    "availed" INTEGER NOT NULL,
    "balance" INTEGER NOT NULL,

    CONSTRAINT "leave_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_policies" (
    "id" SERIAL NOT NULL,
    "employeeId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "policyNumber" TEXT NOT NULL,
    "sumInsured" INTEGER NOT NULL,
    "premium" INTEGER NOT NULL,
    "validTill" TEXT NOT NULL,

    CONSTRAINT "insurance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leave_balances_employeeId_idx" ON "leave_balances"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "leave_balances_employeeId_leaveType_year_key" ON "leave_balances"("employeeId", "leaveType", "year");

-- CreateIndex
CREATE INDEX "insurance_policies_employeeId_idx" ON "insurance_policies"("employeeId");

-- CreateIndex
CREATE INDEX "users_employeeId_idx" ON "users"("employeeId");

-- AddForeignKey
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
