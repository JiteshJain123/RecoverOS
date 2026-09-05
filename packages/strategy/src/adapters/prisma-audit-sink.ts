/**
 * Prisma-backed StrategyAuditSink (production). Writes the strategy service's
 * append-only events to the shared `AuditLog` table, tenant-scoped.
 *
 * This adapter only records audit rows — it never touches money, decisions, or
 * actions. It is the single place this package depends on the database, keeping
 * the pure strategy core (rules, schema, service) free of persistence concerns.
 */
import { prisma, type Prisma } from "@recoveros/database";
import type { AuditTenantContext, StrategyAuditEntry, StrategyAuditSink } from "../audit";

export class PrismaStrategyAuditSink implements StrategyAuditSink {
  async append(ctx: AuditTenantContext, entry: StrategyAuditEntry): Promise<void> {
    await prisma.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorType: "SYSTEM",
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        summary: entry.summary,
        metadata: entry.metadata as Prisma.InputJsonValue,
      },
    });
  }
}
