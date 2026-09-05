/**
 * Versioned, read-only dashboard API: `/api/v1/intelligence/*`.
 *
 * Security model (production auth NOT implemented in this phase):
 *  - Tenant context comes ONLY from the `x-tenant-id` request header, which
 *    stands in for the authenticated principal until real auth lands. The
 *    handlers never read a tenantId from the path/query/body.
 *  - A client attempt to pass `tenantId` via query/body is REJECTED
 *    (`tenant_override_forbidden`) so a caller can never override the context.
 *  - Resource lookups are tenant-scoped; a foreign/missing id returns 404.
 *
 * Every response is read-only. Nothing here executes recovery, calls
 * Razorpay/Gemini, or exposes secrets/DB credentials.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  NotFoundError,
  createIntelligenceReadService,
  type CaseListItemDTO,
  type CaseListQuery,
  type CaseStatus,
  type IntelligenceReadService,
  type TenantContext,
} from "@recoveros/intelligence";

interface TenantRequest extends Request {
  tenant?: TenantContext;
}

// --- Consistent error envelope --------------------------------------------

interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  const body: ApiErrorBody = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  res.status(status).json(body);
}

// --- Tenant context resolution (header-only, no client override) ----------

function resolveTenant(req: TenantRequest, res: Response, next: NextFunction): void {
  const clientSupplied =
    (req.query && "tenantId" in req.query) ||
    (req.body && typeof req.body === "object" && "tenantId" in req.body);
  if (clientSupplied) {
    sendError(
      res,
      400,
      "tenant_override_forbidden",
      "tenantId must not be supplied by the client; tenant is derived from the authenticated context.",
    );
    return;
  }
  const header = req.header("x-tenant-id");
  const tenantId = typeof header === "string" ? header.trim() : "";
  if (!tenantId) {
    sendError(res, 401, "tenant_context_required", "Missing x-tenant-id (authenticated tenant context).");
    return;
  }
  req.tenant = { tenantId };
  next();
}

function asyncHandler(
  fn: (req: TenantRequest, res: Response) => Promise<void>,
): (req: TenantRequest, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

// --- Validation schemas ----------------------------------------------------

const CASE_STATUS = [
  "DETECTED", "ANALYZING", "PROPOSED", "PENDING_APPROVAL", "AUTHORIZED",
  "EXECUTING", "RECOVERED", "FAILED", "BLOCKED", "REJECTED", "EXPIRED",
] as const;
const SEVERITY = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
const ROOT_CAUSE = [
  "BANK_DECLINE", "INSUFFICIENT_FUNDS", "TIMEOUT", "GATEWAY_ERROR",
  "CUSTOMER_ABANDONMENT", "EXPIRED_CHECKOUT", "UNKNOWN",
] as const;

const dateString = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "must be an ISO date/time" });

const listQuerySchema = z
  .object({
    status: z.enum(CASE_STATUS).optional(),
    severity: z.enum(SEVERITY).optional(),
    rootCause: z.enum(ROOT_CAUSE).optional(),
    minAmountMinor: z.coerce.number().int().nonnegative().optional(),
    minPriority: z.coerce.number().int().min(0).max(100).optional(),
    from: dateString.optional(),
    to: dateString.optional(),
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().max(100).default(20),
    sort: z.enum(["priority", "amount", "recent"]).default("priority"),
  })
  .refine((q) => !(q.from && q.to) || Date.parse(q.from) <= Date.parse(q.to), {
    message: "`from` must be on or before `to`",
    path: ["from"],
  });

function validationDetails(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message }));
}

// --- Funnel aggregation (derived from real cases; no fabricated numbers) ---

/** Open (non-terminal) statuses — money still at risk. */
const OPEN_STATUSES: ReadonlySet<CaseStatus> = new Set<CaseStatus>([
  "DETECTED", "ANALYZING", "PROPOSED", "PENDING_APPROVAL", "AUTHORIZED", "EXECUTING",
]);
/** A strategy/decision exists (case advanced past raw detection). */
const ELIGIBLE_STATUSES: ReadonlySet<CaseStatus> = new Set<CaseStatus>([
  "PROPOSED", "PENDING_APPROVAL", "AUTHORIZED", "EXECUTING", "RECOVERED", "FAILED",
]);
/** Authorized/approved by policy (or human) — past the approval gate. */
const APPROVED_STATUSES: ReadonlySet<CaseStatus> = new Set<CaseStatus>([
  "AUTHORIZED", "EXECUTING", "RECOVERED", "FAILED",
]);
/** An execution attempt happened (or is happening). */
const ATTEMPTED_STATUSES: ReadonlySet<CaseStatus> = new Set<CaseStatus>([
  "EXECUTING", "RECOVERED", "FAILED",
]);

/** Read every case for the tenant (bounded), so the funnel is exact, not sampled. */
async function collectAllCases(service: IntelligenceReadService, tenant: TenantContext): Promise<CaseListItemDTO[]> {
  const pageSize = 100;
  const first = await service.listCases(tenant, { page: 1, pageSize, sort: "recent" } as CaseListQuery);
  const items = [...first.items];
  const totalPages = Math.min(first.totalPages, 20); // hard cap — never unbounded
  for (let page = 2; page <= totalPages; page += 1) {
    const next = await service.listCases(tenant, { page, pageSize, sort: "recent" } as CaseListQuery);
    items.push(...next.items);
  }
  return items;
}

interface FunnelStage {
  key: "at_risk" | "eligible" | "approved" | "attempted" | "recovered";
  label: string;
  cases: number;
  amountMinor: number;
}

function buildFunnel(
  tenantId: string,
  generatedAt: string,
  money: { unit: "minor"; exponent: number; currency: string },
  items: CaseListItemDTO[],
): unknown {
  const sum = (pred: (c: CaseListItemDTO) => boolean) => {
    let cases = 0;
    let amountMinor = 0;
    for (const c of items) {
      if (!pred(c)) continue;
      cases += 1;
      amountMinor += c.amountAtRiskMinor;
    }
    return { cases, amountMinor };
  };

  const stages: FunnelStage[] = [
    { key: "at_risk", label: "At Risk", ...sum((c) => OPEN_STATUSES.has(c.status)) },
    { key: "eligible", label: "Eligible", ...sum((c) => ELIGIBLE_STATUSES.has(c.status)) },
    { key: "approved", label: "Approved", ...sum((c) => APPROVED_STATUSES.has(c.status)) },
    { key: "attempted", label: "Attempted", ...sum((c) => ATTEMPTED_STATUSES.has(c.status)) },
    { key: "recovered", label: "Recovered", ...sum((c) => c.status === "RECOVERED") },
  ];

  // Daily trend bucketed by openedAt (UTC day). Real amounts only.
  const byDay = new Map<string, { atRiskMinor: number; recoveredMinor: number; cases: number }>();
  for (const c of items) {
    const day = c.openedAt.slice(0, 10);
    const bucket = byDay.get(day) ?? { atRiskMinor: 0, recoveredMinor: 0, cases: 0 };
    bucket.cases += 1;
    if (c.status === "RECOVERED") bucket.recoveredMinor += c.amountAtRiskMinor;
    else if (OPEN_STATUSES.has(c.status)) bucket.atRiskMinor += c.amountAtRiskMinor;
    byDay.set(day, bucket);
  }
  const trend = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, ...v }));

  return { tenantId, generatedAt, money, stages, trend };
}

// --- Router ----------------------------------------------------------------

export interface ApiV1Options {
  service?: IntelligenceReadService;
}

const BASE = "/api/v1/intelligence";

export function createApiV1Router(options: ApiV1Options = {}): Router {
  const service = options.service ?? createIntelligenceReadService();
  const router = Router();

  // 1) Summary
  router.get(
    `${BASE}/summary`,
    resolveTenant,
    asyncHandler(async (req, res) => {
      res.json(await service.getSummary(req.tenant as TenantContext));
    }),
  );

  // 2) Cases list (filters + pagination + stable sort)
  router.get(
    `${BASE}/cases`,
    resolveTenant,
    asyncHandler(async (req, res) => {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(res, 400, "validation_error", "Invalid query parameters.", validationDetails(parsed.error));
        return;
      }
      res.json(await service.listCases(req.tenant as TenantContext, parsed.data as CaseListQuery));
    }),
  );

  // 3) Case detail
  router.get(
    `${BASE}/cases/:id`,
    resolveTenant,
    asyncHandler(async (req, res) => {
      const id = z.string().min(1).safeParse(req.params.id);
      if (!id.success) {
        sendError(res, 400, "validation_error", "Invalid case id.");
        return;
      }
      res.json(await service.getCaseDetail(req.tenant as TenantContext, id.data));
    }),
  );

  // 3b) Recovery funnel + trend (derived from the tenant's real cases).
  // Pure aggregation over the read service — no fabricated numbers, no writes.
  router.get(
    `${BASE}/funnel`,
    resolveTenant,
    asyncHandler(async (req, res) => {
      const tenant = req.tenant as TenantContext;
      const summary = await service.getSummary(tenant);
      const items = await collectAllCases(service, tenant);
      res.json(buildFunnel(tenant.tenantId, summary.generatedAt, summary.money, items));
    }),
  );

  // 4) Payment timeline
  router.get(
    `${BASE}/payments/:id/timeline`,
    resolveTenant,
    asyncHandler(async (req, res) => {
      const id = z.string().min(1).safeParse(req.params.id);
      if (!id.success) {
        sendError(res, 400, "validation_error", "Invalid payment id.");
        return;
      }
      res.json(await service.getPaymentTimeline(req.tenant as TenantContext, id.data));
    }),
  );

  // Router-scoped error mapping (NotFound → 404; others bubble to app 500).
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof NotFoundError) {
      sendError(res, 404, "not_found", `${err.resource} not found`, { id: err.id });
      return;
    }
    next(err);
  });

  return router;
}
