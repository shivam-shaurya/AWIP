-- AlterTable
ALTER TABLE "leave_requests" ADD COLUMN     "managerDecidedAt" TIMESTAMP(3),
ADD COLUMN     "managerId" TEXT,
ADD COLUMN     "managerNote" TEXT,
ADD COLUMN     "managerStatus" TEXT NOT NULL DEFAULT 'Pending';

-- AlterTable
ALTER TABLE "leave_rules" ADD COLUMN     "minNoticeDays" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "leave_blackouts" (
    "id" SERIAL NOT NULL,
    "fromDate" TEXT NOT NULL,
    "toDate" TEXT NOT NULL,
    "department" TEXT,
    "reason" TEXT NOT NULL,

    CONSTRAINT "leave_blackouts_pkey" PRIMARY KEY ("id")
);
