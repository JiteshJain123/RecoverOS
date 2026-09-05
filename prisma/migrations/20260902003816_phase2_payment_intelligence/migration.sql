-- CreateEnum
CREATE TYPE "RootCause" AS ENUM ('BANK_DECLINE', 'INSUFFICIENT_FUNDS', 'TIMEOUT', 'GATEWAY_ERROR', 'CUSTOMER_ABANDONMENT', 'EXPIRED_CHECKOUT', 'UNKNOWN');

-- AlterTable
ALTER TABLE "recovery_cases" ADD COLUMN     "detectionRuleVersion" TEXT,
ADD COLUMN     "lastDetectedAt" TIMESTAMP(3),
ADD COLUMN     "priorityComponents" JSONB,
ADD COLUMN     "priorityScore" INTEGER,
ADD COLUMN     "riskSignals" JSONB,
ADD COLUMN     "rootCause" "RootCause";

-- CreateIndex
CREATE INDEX "recovery_cases_tenantId_priorityScore_idx" ON "recovery_cases"("tenantId", "priorityScore");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_cases_tenantId_paymentId_key" ON "recovery_cases"("tenantId", "paymentId");

