/**
 * Read-side repository port for the dashboard API. Like the write ports, every
 * method REQUIRES a TenantContext and MUST scope all access to `ctx.tenantId`.
 * Resource lookups by id are always `(id, tenantId)` — a foreign tenant's row
 * is indistinguishable from a missing row (returns null → 404), so existence is
 * never leaked across tenants.
 *
 * The repository is responsible for pushing filtering/sorting/pagination and
 * aggregation to the data source (no N+1, no load-everything-then-filter).
 */
import type { TenantContext } from "../engine/ports";
import type {
  CaseDetailDTO,
  CaseListItemDTO,
  CaseListQuery,
  PaymentTimelineDTO,
  RootCauseBreakdownEntry,
  SeverityBreakdownEntry,
} from "./types";

/** Aggregates the service turns into an IntelligenceSummaryDTO. */
export interface SummaryAggregates {
  currency: string;
  revenueAtRiskMinor: number;
  affectedPayments: number;
  affectedCustomers: number;
  highPriorityCases: number;
  reviewRequiredCases: number;
  recoveredRevenueMinor: number;
  resolvedRecoveredCount: number;
  resolvedFailedCount: number;
  byRootCause: RootCauseBreakdownEntry[];
  bySeverity: SeverityBreakdownEntry[];
}

export type CaseDetailCore = Omit<CaseDetailDTO, "money">;
export type PaymentTimelineCore = Omit<PaymentTimelineDTO, "money">;

export interface CaseListPage {
  items: CaseListItemDTO[];
  total: number;
}

export interface IntelligenceReadRepository {
  summaryAggregates(ctx: TenantContext): Promise<SummaryAggregates>;
  listCases(ctx: TenantContext, query: CaseListQuery): Promise<CaseListPage>;
  getCaseDetail(ctx: TenantContext, caseId: string): Promise<CaseDetailCore | null>;
  getPaymentTimeline(ctx: TenantContext, paymentId: string): Promise<PaymentTimelineCore | null>;
}

/** Statuses considered "open" (currently at risk). */
export const OPEN_STATUSES = [
  "DETECTED",
  "ANALYZING",
  "PROPOSED",
  "PENDING_APPROVAL",
  "AUTHORIZED",
  "EXECUTING",
] as const;

/** priorityScore at/above which a case is "high priority". */
export const HIGH_PRIORITY_THRESHOLD = 60;
