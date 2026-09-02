-- CreateTable
CREATE TABLE "workforce_snapshot" (
    "id" SERIAL NOT NULL,
    "dept" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "attendance" DOUBLE PRECISION NOT NULL,
    "vacancies" INTEGER NOT NULL,

    CONSTRAINT "workforce_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workforce_snapshot_dept_key" ON "workforce_snapshot"("dept");
