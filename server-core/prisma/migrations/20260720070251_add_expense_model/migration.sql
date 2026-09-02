-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "submitter" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expenses_department_idx" ON "expenses"("department");
