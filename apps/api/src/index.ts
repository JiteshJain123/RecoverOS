/**
 * RecoverOS API.
 *
 * Express server. Phase 2 adds read-only payment-intelligence inspection
 * endpoints (signals, revenue-at-risk summary, recovery candidates). Auth,
 * ingestion, webhooks and the approval workflow arrive in later phases.
 */
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { loadEnv } from "@recoveros/config";
import { createLogger } from "@recoveros/observability";
import type { HealthStatus } from "@recoveros/shared";
import { createIntelligenceRouter } from "./intelligence-routes";
import { createApiV1Router } from "./api-v1-routes";
import { createGeminiRouter } from "./gemini-routes";
import { createRecoveryRouter } from "./recovery-routes";
import { createRazorpayRouter } from "./razorpay-routes";
import { createWebhookRouter } from "./webhook-routes";
import { createLifecycleRouter } from "./lifecycle-routes";
import { createIntegrationRouter } from "./integration-routes";
import { createFailureLabRouter } from "./failure-lab-routes";

const env = loadEnv();
const logger = createLogger({ name: "api", level: env.LOG_LEVEL });

const app = express();

// Phase 5: Razorpay webhook ingestion. MUST be registered BEFORE express.json()
// so the handler receives the RAW body (Buffer) for HMAC signature verification.
app.use(createWebhookRouter({ logger }));

app.use(express.json());

app.get("/health", (_req: Request, res: Response<HealthStatus>) => {
  res.json({
    status: "ok",
    service: "api",
    timestamp: new Date().toISOString(),
  });
});

// Phase 2: read-only payment-intelligence inspection endpoints.
// The development-only batch-trigger endpoint is enabled outside production.
app.use(
  createIntelligenceRouter({
    logger,
    enableDevEndpoints: env.NODE_ENV !== "production",
  }),
);

// Phase 4: versioned, read-only dashboard API (/api/v1/intelligence/*).
app.use(createApiV1Router());

// Phase 6: development-only Gemini recommendation endpoint (advisory; never
// executes). Registered only outside production.
app.use(
  createGeminiRouter({
    logger,
    enableDevEndpoints: env.NODE_ENV !== "production",
  }),
);

// Phase 7: development-only policy-gate approval + batch execution endpoints
// (deterministic policy + simulated execution; never moves real money).
app.use(
  createRecoveryRouter({
    logger,
    enableDevEndpoints: env.NODE_ENV !== "production",
  }),
);

// Phase 4: development-only Razorpay TEST MODE connection check (harmless
// authenticated read; returns only safe metadata, never credentials).
app.use(
  createRazorpayRouter({
    logger,
    enableDevEndpoints: env.NODE_ENV !== "production",
  }),
);

// Phase 8: development-only end-to-end recovery lifecycle + batch (connected
// provider selection; deterministic; simulator unless RAZORPAY_TEST is enabled).
app.use(
  createLifecycleRouter({
    logger,
    enableDevEndpoints: env.NODE_ENV !== "production",
  }),
);

// Phase 5 (Control Room): development-only integration status for the merchant
// dashboard (config-only by default; ?probe=1 runs the safe live checks). Never
// returns secrets.
app.use(
  createIntegrationRouter({
    logger,
    enableDevEndpoints: env.NODE_ENV !== "production",
  }),
);

// Phase 5 (Control Room): development-only Failure Lab — runs the controlled
// failure harness through the real lifecycle to demonstrate safe failure.
// Registered only outside production (and each handler re-guards NODE_ENV).
app.use(
  createFailureLabRouter({
    logger,
    enableDevEndpoints: env.NODE_ENV !== "production",
  }),
);

// Central error handler — keeps DB/engine errors from leaking internals.
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "internal_error";
  logger.error("request_failed", { message });
  res.status(500).json({ error: "internal_error" });
});

app.listen(env.API_PORT, () => {
  logger.info("API listening", { port: env.API_PORT, env: env.NODE_ENV });
});
