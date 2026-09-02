-- CreateTable
CREATE TABLE "agent_runs" (
    "id" SERIAL NOT NULL,
    "agentKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "findings" JSONB NOT NULL,
    "narrative" TEXT NOT NULL,
    "recommendedAction" TEXT NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_runs_agentKey_ranAt_idx" ON "agent_runs"("agentKey", "ranAt");
