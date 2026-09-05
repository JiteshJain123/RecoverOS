/**
 * DEVELOPMENT-ONLY Failure Lab endpoints.
 *
 *   GET  /dev/failure-lab/scenarios                          → scenario catalogue
 *   POST /dev/tenants/:tenantId/failure-lab/:scenarioId      → run one scenario
 *
 * These drive the controlled failure harness (deterministic mock Razorpay
 * transport + signed webhook fixtures) through the REAL connected lifecycle to
 * prove RecoverOS fails safely. They NEVER use real credentials, the network,
 * Live Mode, or real customer messages.
 *
 * PRODUCTION PROTECTION (defence in depth):
 *  1. The whole router is only mounted when `enableDevEndpoints === true`
 *     (index.ts passes `NODE_ENV !== "production"`), so in production it is an
 *     empty router — the routes do not exist at all.
 *  2. Every handler additionally re-checks `NODE_ENV === "production"` at request
 *     time and returns 404, so even a mis-wired mount can never expose them.
 * Hiding a button in the frontend is NOT relied upon.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { listFailureScenarios, runFailureScenario, isFailureScenario, runSafetyReport } from "@recoveros/lifecycle";
import type { Logger } from "@recoveros/observability";

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export interface FailureLabRouterOptions {
  logger?: Logger;
  enableDevEndpoints?: boolean;
}

export function createFailureLabRouter(options: FailureLabRouterOptions = {}): Router {
  const router = Router();
  if (options.enableDevEndpoints !== true) return router;

  // Fixed deterministic instant so every run is reproducible for a judge.
  const clock = { now: () => new Date("2026-09-05T12:00:00.000Z") };

  const guardProd = (_req: Request, res: Response, next: NextFunction): void => {
    if (process.env.NODE_ENV === "production") {
      sendError(res, 404, "not_found", "Not found.");
      return;
    }
    next();
  };

  router.get("/dev/failure-lab/scenarios", guardProd, (_req: Request, res: Response) => {
    res.json({ mode: "development", simulation: true, scenarios: listFailureScenarios() });
  });

  // Curated safety report for the Evaluations page: each guarantee is backed by
  // an actual failure-lab run (deterministic; never a hardcoded claim).
  router.get(
    "/dev/tenants/:tenantId/evaluation/safety-report",
    guardProd,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        const tenantId = req.params.tenantId?.trim();
        if (!tenantId) return sendError(res, 400, "tenant_context_required", "Missing tenant context.");
        try {
          const report = await runSafetyReport({ tenantId, clock });
          res.json(report);
        } catch (err) {
          next(err);
        }
      })();
    },
  );

  router.post(
    "/dev/tenants/:tenantId/failure-lab/:scenarioId",
    guardProd,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        const tenantId = req.params.tenantId?.trim();
        const scenarioId = req.params.scenarioId?.trim();
        if (!tenantId) return sendError(res, 400, "tenant_context_required", "Missing tenant context.");
        if (!scenarioId || !isFailureScenario(scenarioId)) {
          return sendError(res, 404, "not_found", "Unknown failure-lab scenario.");
        }
        try {
          const run = await runFailureScenario(scenarioId, { tenantId, clock });
          options.logger?.info("failure_lab.run", {
            tenantId,
            scenarioId,
            finalOutcome: run.trace.finalOutcome,
            providerCalls: run.stats.providerCalls,
            recoveredRevenueMinor: run.stats.revenueCreditedMinor,
          });
          res.json(run);
        } catch (err) {
          next(err);
        }
      })();
    },
  );

  return router;
}
