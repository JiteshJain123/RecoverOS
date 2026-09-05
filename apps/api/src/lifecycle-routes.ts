/**
 * DEVELOPMENT-ONLY end-to-end recovery workflow + batch endpoints.
 *
 *   POST /dev/tenants/:tenantId/recovery/lifecycle/:caseId   → one full trace
 *   POST /dev/tenants/:tenantId/recovery/lifecycle-batch      → dataset metrics
 *
 * Both run the connected lifecycle (strategy → policy → execute → webhook →
 * reconcile → verify) over the deterministic synthetic dataset, using the
 * SERVER-CONFIGURED execution provider. If RAZORPAY_TEST is not enabled or test
 * credentials are missing, it falls back to the simulator — never a live call.
 * Registered only when NODE_ENV !== "production".
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { SimulatedRecoveryProvider } from "@recoveros/execution";
import { createRazorpayTestProvider } from "@recoveros/payments";
import {
  LifecycleBatchEvaluator,
  buildLifecycle,
  resolveProviderSelectionFromEnv,
  selectExecutionProvider,
} from "@recoveros/lifecycle";
import type { Logger } from "@recoveros/observability";

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export interface LifecycleRouterOptions {
  logger?: Logger;
  enableDevEndpoints?: boolean;
}

export function createLifecycleRouter(options: LifecycleRouterOptions = {}): Router {
  const router = Router();
  if (options.enableDevEndpoints !== true) return router;

  const clock = { now: () => new Date("2026-09-04T12:00:00.000Z") };

  const selectProvider = () => {
    const cfg = resolveProviderSelectionFromEnv();
    // The Razorpay adapter is only built when the config wants it; selection then
    // gates it by enable-flag + credentials (falling back to SIMULATED).
    const razorpay = cfg.mode === "RAZORPAY_TEST" ? createRazorpayTestProvider({ logger: options.logger }) : undefined;
    return selectExecutionProvider(cfg, { simulated: new SimulatedRecoveryProvider(), razorpay });
  };

  const guardProd = (req: Request, res: Response, next: NextFunction): void => {
    if (process.env.NODE_ENV === "production") {
      sendError(res, 404, "not_found", "Not found.");
      return;
    }
    next();
  };

  router.post(
    "/dev/tenants/:tenantId/recovery/lifecycle/:caseId",
    guardProd,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        const tenantId = req.params.tenantId?.trim();
        const caseId = req.params.caseId?.trim();
        if (!tenantId) return sendError(res, 400, "tenant_context_required", "Missing tenant context.");
        if (!caseId) return sendError(res, 400, "validation_error", "Missing case id.");
        try {
          const sel = selectProvider();
          const bundle = buildLifecycle({ tenantId, count: 60, clock, provider: sel.provider, providerMode: sel.mode });
          const pc = bundle.cases.find((c) => c.policyCase.id === caseId);
          if (!pc) return sendError(res, 404, "not_found", "Recovery case not found in the seeded dataset.");
          const trace = await bundle.lifecycle.runCase(pc, { replayWebhook: "captured", autoApprove: true });
          res.json({ mode: "development", providerMode: sel.mode, providerReason: sel.reason, trace });
        } catch (err) {
          next(err);
        }
      })();
    },
  );

  router.post(
    "/dev/tenants/:tenantId/recovery/lifecycle-batch",
    guardProd,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        const tenantId = req.params.tenantId?.trim();
        if (!tenantId) return sendError(res, 400, "tenant_context_required", "Missing tenant context.");
        try {
          const sel = selectProvider();
          const bundle = buildLifecycle({ tenantId, count: 60, clock, provider: sel.provider, providerMode: sel.mode });
          const evaluator = new LifecycleBatchEvaluator(bundle.lifecycle, bundle.cases, bundle.execStore, bundle.providerMode);
          const first = await evaluator.run();
          const actionsAfterFirst = bundle.execStore.actions.length;
          const second = await evaluator.run();
          res.json({
            mode: "development",
            providerMode: sel.mode,
            metrics: first,
            idempotency: {
              identicalRecoveredRevenue: first.recoveredRevenueMinor === second.recoveredRevenueMinor,
              noNewActions: bundle.execStore.actions.length === actionsAfterFirst,
              run2ProviderCalls: second.providerCalls,
              run2DuplicatesPrevented: second.duplicateExecutionsPrevented,
            },
          });
        } catch (err) {
          next(err);
        }
      })();
    },
  );

  return router;
}
