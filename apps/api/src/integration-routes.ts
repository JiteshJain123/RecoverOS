/**
 * DEVELOPMENT-ONLY integration status endpoint for the merchant Control Room.
 *
 *   GET /dev/integration/status         → config-only statuses (fast, no network)
 *   GET /dev/integration/status?probe=1 → additionally runs the safe live probes
 *
 * It reuses the Phase-4 verification module ({@link runIntegrationChecks}) and
 * returns ONLY classified statuses plus the non-secret model id / mode. It NEVER
 * returns API keys, the webhook secret, or Authorization headers. Registered only
 * when NODE_ENV !== "production" (re-checked at request time).
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { loadEnv } from "@recoveros/config";
import {
  GeminiRecoveryStrategyProvider,
  HttpGeminiClient,
  loadGeminiConfig,
} from "@recoveros/ai";
import { createRazorpayTestProvider } from "@recoveros/payments";
import type { RecoveryStrategyContext } from "@recoveros/strategy";
import type { Logger } from "@recoveros/observability";
import { checkGeminiConfig, runIntegrationChecks } from "./verify-integrations";

export interface IntegrationRouterOptions {
  logger?: Logger;
  enableDevEndpoints?: boolean;
}

/** A synthetic, non-financial context used only to prove the AI path works. */
const PROBE_CONTEXT: RecoveryStrategyContext = {
  caseId: "integration_probe",
  tenantId: "integration_probe",
  caseStatus: "DETECTED",
  paymentStatus: "FAILED",
  reason: "FAILED_PAYMENT",
  rootCause: "TIMEOUT",
  severity: "MEDIUM",
  priorityScore: 40,
  amountAtRiskMinor: 500_000,
  currency: "INR",
  paymentId: "pay_probe",
  customerId: "cust_probe",
  retryCount: 0,
  hasContactChannel: true,
  hasExpiredLink: false,
  policyState: "OK",
  signals: [{ type: "FAILED_PAYMENT", severity: "MEDIUM", rootCause: "TIMEOUT", confidence: 0.9, reason: "failed" }],
};

export function createIntegrationRouter(options: IntegrationRouterOptions = {}): Router {
  const router = Router();
  if (options.enableDevEndpoints !== true) return router;

  router.get(
    "/dev/integration/status",
    (req: Request, res: Response, next: NextFunction) => {
      if (process.env.NODE_ENV === "production") {
        res.status(404).json({ error: { code: "not_found", message: "Not found." } });
        return;
      }
      next();
    },
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        try {
          const env = loadEnv();
          const wantProbe = req.query.probe === "1" || req.query.probe === "true";

          let geminiProbe: (() => Promise<unknown>) | undefined;
          let razorpayProbe: (() => Promise<unknown>) | undefined;
          if (wantProbe) {
            if (checkGeminiConfig(env).config === "OK") {
              const cfg = loadGeminiConfig({ env });
              const client = new HttpGeminiClient(cfg);
              const provider = new GeminiRecoveryStrategyProvider({ client, config: { deterministic: cfg.temperature === 0 } });
              geminiProbe = () => provider.generatePlan(PROBE_CONTEXT);
            }
            const razorpay = createRazorpayTestProvider({ logger: options.logger });
            razorpayProbe = () => razorpay.verifyConnection({ tenantId: "integration_probe" });
          }

          const report = await runIntegrationChecks({ env, geminiProbe, razorpayProbe });
          res.json({ mode: "development", probed: wantProbe, ...report });
        } catch (err) {
          next(err);
        }
      })();
    },
  );

  return router;
}
