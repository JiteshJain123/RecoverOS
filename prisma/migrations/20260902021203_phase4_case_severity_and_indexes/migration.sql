-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- DropIndex
DROP INDEX "recovery_cases_paymentId_idx";

-- AlterTable
ALTER TABLE "recovery_cases" ADD COLUMN     "severity" "Severity";

-- CreateIndex
CREATE INDEX "recovery_cases_tenantId_severity_idx" ON "recovery_cases"("tenantId", "severity");

-- CreateIndex
CREATE INDEX "recovery_cases_tenantId_rootCause_idx" ON "recovery_cases"("tenantId", "rootCause");

-- CreateIndex
CREATE INDEX "recovery_cases_tenantId_openedAt_idx" ON "recovery_cases"("tenantId", "openedAt");

