-- CreateTable
CREATE TABLE "personal_events" (
    "id" SERIAL NOT NULL,
    "employeeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personal_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "personal_events_employeeId_idx" ON "personal_events"("employeeId");

-- AddForeignKey
ALTER TABLE "personal_events" ADD CONSTRAINT "personal_events_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
