/**
 * IntelligenceReadService — thin, provider-agnostic orchestration over the
 * read repository. It enforces tenant context, attaches the explicit money
 * descriptor to every money-bearing response, and computes derived fields
 * (e.g. recovery success rate). All heavy lifting (filter/sort/paginate/
 * aggregate) happens in the repository against the data source.
 */
import type { Clock, TenantContext } from "../engine/ports";
import type { IntelligenceReadRepository } from "./read-repository";
import type {
  CaseDetailDTO,
  CaseListDTO,
  CaseListQuery,
  IntelligenceSummaryDTO,
  MoneyMeta,
  PaymentTimelineDTO,
} from "./types";

/** Thrown when a tenant-scoped resource is not found (maps to HTTP 404). */
export class NotFoundError extends Error {
  constructor(public readonly resource: string, public readonly id: string) {
    super(`${resource} not found`);
    this.name = "NotFoundError";
  }
}

/** ISO-4217 exponent. INR/USD = 2 (100 minor units per major). */
const DEFAULT_EXPONENT = 2;
const money = (currency: string): MoneyMeta => ({
  unit: "minor",
  exponent: DEFAULT_EXPONENT,
  currency,
});

export interface ReadServiceDeps {
  repo: IntelligenceReadRepository;
  clock: Clock;
}

export class IntelligenceReadService {
  private readonly repo: IntelligenceReadRepository;
  private readonly clock: Clock;

  constructor(deps: ReadServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock;
  }

  private assertTenant(ctx: TenantContext): void {
    if (!ctx || typeof ctx.tenantId !== "string" || ctx.tenantId.trim() === "") {
      throw new Error("Tenant context is required.");
    }
  }

  async getSummary(ctx: TenantContext): Promise<IntelligenceSummaryDTO> {
    this.assertTenant(ctx);
    const a = await this.repo.summaryAggregates(ctx);
    const resolved = a.resolvedRecoveredCount + a.resolvedFailedCount;
    const recoverySuccessRate = resolved === 0 ? null : round4(a.resolvedRecoveredCount / resolved);

    return {
      tenantId: ctx.tenantId,
      generatedAt: this.clock.now().toISOString(),
      money: money(a.currency),
      revenueAtRiskMinor: a.revenueAtRiskMinor,
      affectedPayments: a.affectedPayments,
      affectedCustomers: a.affectedCustomers,
      highPriorityCases: a.highPriorityCases,
      reviewRequiredCases: a.reviewRequiredCases,
      recoveredRevenueMinor: a.recoveredRevenueMinor,
      recoverySuccessRate,
      byRootCause: a.byRootCause,
      bySeverity: a.bySeverity,
    };
  }

  async listCases(ctx: TenantContext, query: CaseListQuery): Promise<CaseListDTO> {
    this.assertTenant(ctx);
    const { items, total } = await this.repo.listCases(ctx, query);
    const currency = items[0]?.currency ?? "INR";
    const { page, pageSize, sort, ...filters } = query;
    return {
      tenantId: ctx.tenantId,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      sort,
      filters,
      money: money(currency),
      items,
    };
  }

  async getCaseDetail(ctx: TenantContext, caseId: string): Promise<CaseDetailDTO> {
    this.assertTenant(ctx);
    const core = await this.repo.getCaseDetail(ctx, caseId);
    if (!core) throw new NotFoundError("case", caseId);
    return { ...core, money: money(core.currency) };
  }

  async getPaymentTimeline(ctx: TenantContext, paymentId: string): Promise<PaymentTimelineDTO> {
    this.assertTenant(ctx);
    const core = await this.repo.getPaymentTimeline(ctx, paymentId);
    if (!core) throw new NotFoundError("payment", paymentId);
    return { ...core, money: money(core.currency) };
  }
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
