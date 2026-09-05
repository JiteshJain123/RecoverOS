/**
 * Read-only payment-intelligence API routes (Phase 2).
 *
 * These endpoints INSPECT deterministic intelligence output. They never execute
 * recovery, never call Razorpay/Gemini, and never send customer messages.
 *
 * TENANT ISOLATION: every route is mounted under `/tenants/:tenantId/...` and
 * derives its {@link TenantContext} from the path via `requireTenant`. There is
 * no endpoint that reads tenant-owned data without a tenant in scope. (Auth is
 * not implemented in this phase; the path param IS the tenant context for now,
 * which a later auth phase will bind to the authenticated principal.)
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import {
  createBatchProcessor,
  createPaymentIntelligenceEngine,
  type BatchProcessor,
  type PaymentIntelligenceEngine,
  type TenantContext,
} from "@recoveros/intelligence";
import type { Logger } from "@recoveros/observability";

/** Attaches a validated TenantContext to the request. */
interface TenantRequest extends Request {
  tenant?: TenantContext;
}

function requireTenant(req: TenantRequest, res: Response, next: NextFunction): void {
  const tenantId = req.params.tenantId?.trim();
  if (!tenantId) {
    res.status(400).json({ error: "tenant_context_required" });
    return;
  }
  req.tenant = { tenantId };
  next();
}

/** Wrap an async handler so rejections flow to Express' error path. */
function asyncHandler(
  fn: (req: TenantRequest, res: Response) => Promise<void>,
): (req: TenantRequest, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export interface IntelligenceRouterOptions {
  engine?: PaymentIntelligenceEngine;
  batchProcessor?: BatchProcessor;
  logger?: Logger;
  /**
   * Enables the WRITE, development-only batch-trigger endpoint. MUST be false in
   * production. The API server derives this from `NODE_ENV !== "production"`.
   */
  enableDevEndpoints?: boolean;
}

/**
 * Build the intelligence router. Mount at the app root; read-only routes are
 * self-namespaced under `/tenants/:tenantId/intelligence` and `/recovery-candidates`.
 * The single WRITE route lives under `/dev/...` and is only registered when
 * `enableDevEndpoints` is true.
 */
export function createIntelligenceRouter(options: IntelligenceRouterOptions = {}): Router {
  const engine = options.engine ?? createPaymentIntelligenceEngine({ logger: options.logger });
  const devEnabled = options.enableDevEndpoints === true;
  const router = Router();

  // GET risk signals (recomputed deterministically from current data).
  router.get(
    "/tenants/:tenantId/intelligence/signals",
    requireTenant,
    asyncHandler(async (req, res) => {
      const report = await engine.detectForTenant(req.tenant as TenantContext);
      res.json(report);
    }),
  );

  // GET revenue-at-risk summary (aggregates).
  router.get(
    "/tenants/:tenantId/intelligence/summary",
    requireTenant,
    asyncHandler(async (req, res) => {
      const summary = await engine.summarizeTenant(req.tenant as TenantContext);
      res.json(summary);
    }),
  );

  // GET recovery candidates (persisted cases with explainable priority).
  router.get(
    "/tenants/:tenantId/recovery-candidates",
    requireTenant,
    asyncHandler(async (req, res) => {
      const cases = await engine.listCandidates(req.tenant as TenantContext);
      res.json({ tenantId: (req.tenant as TenantContext).tenantId, count: cases.length, cases });
    }),
  );

  // -------------------------------------------------------------------------
  // DEVELOPMENT-ONLY: trigger a batch analysis for one tenant (WRITE).
  //
  // This is NOT a production endpoint. It is registered ONLY when
  // `enableDevEndpoints` is true (NODE_ENV !== "production") and also
  // re-checks at request time. It creates/updates RecoveryCases idempotently;
  // it never executes recovery, moves money, or messages customers.
  // -------------------------------------------------------------------------
  if (devEnabled) {
    const batch = options.batchProcessor ?? createBatchProcessor({ logger: options.logger });
    router.post(
      "/dev/tenants/:tenantId/intelligence/batch",
      (req: Request, res: Response, next: NextFunction) => {
        // Defense in depth: refuse even if somehow mounted in production.
        if (process.env.NODE_ENV === "production") {
          res.status(404).json({ error: "not_found" });
          return;
        }
        next();
      },
      requireTenant,
      asyncHandler(async (req, res) => {
        const result = await batch.processTenant(req.tenant as TenantContext);
        res.json({ mode: "development", ...result });
      }),
    );
  }

  return router;
}
