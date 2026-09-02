-- CreateTable
CREATE TABLE "emergency_alerts" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "location" TEXT,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "reportedBy" TEXT,
    "authorityEmployeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "emergency_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_alert_updates" (
    "id" SERIAL NOT NULL,
    "alertId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "channel" TEXT,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emergency_alert_updates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "emergency_alert_updates_alertId_idx" ON "emergency_alert_updates"("alertId");

-- AddForeignKey
ALTER TABLE "emergency_alert_updates" ADD CONSTRAINT "emergency_alert_updates_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "emergency_alerts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
