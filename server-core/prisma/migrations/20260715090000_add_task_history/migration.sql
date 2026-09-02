-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "tasks" ADD COLUMN "completedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "task_monthly_snapshots" (
    "id" SERIAL NOT NULL,
    "department" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "totalTasks" INTEGER NOT NULL,
    "completedTasks" INTEGER NOT NULL,
    "overdueTasks" INTEGER NOT NULL,
    "avgTatDays" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "task_monthly_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "task_monthly_snapshots_department_zone_month_key" ON "task_monthly_snapshots"("department", "zone", "month");
CREATE INDEX "task_monthly_snapshots_month_idx" ON "task_monthly_snapshots"("month");
