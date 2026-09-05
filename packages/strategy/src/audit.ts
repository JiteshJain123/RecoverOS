/**
 * Audit sink for the Recovery Strategy Engine.
 *
 * The engine is pure; persistence is a port. The service emits three
 * append-only audit events through this sink:
 *   - `recovery.strategy.generated` — a valid plan was produced for a case
 *   - `recovery.strategy.rejected`  — a produced plan failed validation
 *   - `recovery.strategy.changed`   — the chosen strategy differs from before
 *
 * Metadata never contains secrets or provider credentials — only case ids,
 * strategy names, rule ids, confidences and (for rejections) the validation
 * issues. A Prisma-backed implementation that writes to `AuditLog` lives in
 * `./adapters/prisma-audit-sink.ts`; the in-memory sink here is for tests/dev.
 */

/** Append-only audit record written by the strategy service. */
export interface StrategyAuditEntry {
  actorType: "SYSTEM";
  action:
    | "recovery.strategy.generated"
    | "recovery.strategy.rejected"
    | "recovery.strategy.changed";
  entityType: "RecoveryCase";
  entityId: string;
  summary: string;
  metadata: Record<string, unknown>;
}

/** Tenant scope carried on every audit write. */
export interface AuditTenantContext {
  tenantId: string;
}

/** The port the service depends on. */
export interface StrategyAuditSink {
  append(ctx: AuditTenantContext, entry: StrategyAuditEntry): Promise<void>;
}

/** A recorded entry (tenant scope + entry) as seen by the in-memory sink. */
export interface RecordedStrategyAudit extends StrategyAuditEntry {
  tenantId: string;
}

/** In-memory sink for tests and local development. */
export class InMemoryStrategyAuditSink implements StrategyAuditSink {
  readonly entries: RecordedStrategyAudit[] = [];

  async append(ctx: AuditTenantContext, entry: StrategyAuditEntry): Promise<void> {
    this.entries.push({ tenantId: ctx.tenantId, ...entry });
  }

  /** Convenience: entries with a given action, in insertion order. */
  byAction(action: StrategyAuditEntry["action"]): RecordedStrategyAudit[] {
    return this.entries.filter((e) => e.action === action);
  }
}
