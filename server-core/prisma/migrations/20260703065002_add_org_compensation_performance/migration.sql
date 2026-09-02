-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "managerId" TEXT;

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "headId" TEXT,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compensation" (
    "id" SERIAL NOT NULL,
    "employeeId" TEXT NOT NULL,
    "payGrade" TEXT NOT NULL,
    "basicPay" INTEGER NOT NULL,
    "daPercent" DOUBLE PRECISION NOT NULL,
    "daAmount" INTEGER NOT NULL,
    "hraPercent" DOUBLE PRECISION NOT NULL,
    "hraAmount" INTEGER NOT NULL,
    "grossPay" INTEGER NOT NULL,

    CONSTRAINT "compensation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_records" (
    "id" SERIAL NOT NULL,
    "employeeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "rating" DOUBLE PRECISION NOT NULL,
    "attritionRiskScore" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "performance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_records" (
    "id" SERIAL NOT NULL,
    "employeeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "completionDate" TEXT NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "training_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_skills" (
    "id" SERIAL NOT NULL,
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "proficiency" TEXT NOT NULL,

    CONSTRAINT "employee_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_summary" (
    "id" SERIAL NOT NULL,
    "employeeId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "presentDays" INTEGER NOT NULL,
    "totalDays" INTEGER NOT NULL,

    CONSTRAINT "attendance_summary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");

-- CreateIndex
CREATE UNIQUE INDEX "compensation_employeeId_key" ON "compensation"("employeeId");

-- CreateIndex
CREATE INDEX "performance_records_employeeId_idx" ON "performance_records"("employeeId");

-- CreateIndex
CREATE INDEX "training_records_employeeId_idx" ON "training_records"("employeeId");

-- CreateIndex
CREATE INDEX "employee_skills_employeeId_idx" ON "employee_skills"("employeeId");

-- CreateIndex
CREATE INDEX "attendance_summary_employeeId_idx" ON "attendance_summary"("employeeId");

-- CreateIndex
CREATE INDEX "employees_departmentId_idx" ON "employees"("departmentId");

-- CreateIndex
CREATE INDEX "employees_managerId_idx" ON "employees"("managerId");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation" ADD CONSTRAINT "compensation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_records" ADD CONSTRAINT "performance_records_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_records" ADD CONSTRAINT "training_records_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_summary" ADD CONSTRAINT "attendance_summary_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
