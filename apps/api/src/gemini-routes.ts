/**
 * DEVELOPMENT-ONLY Gemini recommendation endpoint (Phase 6).
 *
 *   POST /dev/tenants/:tenantId/recovery-cases/:caseId/recommend
 *
 * It requires a tenant context (path param stands in for the authenticated
 * principal until auth lands), verifies the case belongs to the tenant, creates
 * an AgentRun, calls Gemini, validates the structured output, upserts a
 * RecoveryDecision, writes an audit event, and returns the structured decision.
 *
 * It NEVER executes the proposed action, calls Razorpay, or sends any message.
 * It is registered ONLY when `enableDevEndpoints` is true (NODE_ENV !==
 * "production") and re-checks NODE_ENV at request time (defense in depth).
 *
 * Failures are mapped to a consistent error envelope with safe categories; no
 * secrets, API keys, or raw provider payloads are ever returned.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import {
  CaseNotFoundError,
  GeminiConfigError,
  GeminiError,
  GeminiMalformedOutputError,
  GeminiRequestError,
  GeminiTimeoutError,
  createGeminiRecoveryService,
  type GeminiRecoveryService,
} from "@recoveros/ai";
import type { Logger } from "@recoveros/observability";

interface ApiErrorBody {
  error: { code: string; message: string };
}

function sendError(res: Response, status: number, code: string, message: string): void {
  const body: ApiErrorBody = { error: { code, message } };
  res.status(status).json(body);
}

export interface GeminiRouterOptions {
  /** Injectable for tests (mocked Gemini). Falls back to the env-config service. */
  service?: GeminiRecoveryService;
  logger?: Logger;
  /** MUST be false in production. Derived from NODE_ENV !== "production". */
  enableDevEndpoints?: boolean;
}

export function createGeminiRouter(options: GeminiRouterOptions = {}): Router {
  const router = Router();
  if (options.enableDevEndpoints !== true) return router;

  // Lazily build the service so a missing GEMINI_API_KEY only fails a request,
  // not process startup. A provided service (tests) is used as-is.
  let service = options.service;
  const getService = (): GeminiRecoveryService => {
    if (!service) service = createGeminiRecoveryService({ logger: options.logger });
    return service;
  };

  router.post(
    "/dev/tenants/:tenantId/recovery-cases/:caseId/recommend",
    (req: Request, res: Response, next: NextFunction) => {
      if (process.env.NODE_ENV === "production") {
        sendError(res, 404, "not_found", "Not found.");
        return;
      }
      next();
    },
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        const tenantId = req.params.tenantId?.trim();
        const caseId = req.params.caseId?.trim();
        if (!tenantId) {
          sendError(res, 400, "tenant_context_required", "Missing tenant context.");
          return;
        }
        if (!caseId) {
          sendError(res, 400, "validation_error", "Missing case id.");
          return;
        }

        let svc: GeminiRecoveryService;
        try {
          svc = getService();
        } catch (err) {
          if (err instanceof GeminiConfigError) {
            sendError(res, 503, "gemini_not_configured", err.message);
            return;
          }
          throw err;
        }

        try {
          const result = await svc.recommend({ tenantId }, caseId);
          res.json({
            mode: "development",
            tenantId,
            caseId,
            agentRunId: result.agentRunId,
            decisionId: result.decisionId,
            executed: false,
            plan: result.plan,
            meta: result.meta,
          });
        } catch (err) {
          if (err instanceof CaseNotFoundError) {
            sendError(res, 404, "not_found", "Recovery case not found.");
            return;
          }
          if (err instanceof GeminiConfigError) {
            sendError(res, 503, "gemini_not_configured", err.message);
            return;
          }
          if (err instanceof GeminiTimeoutError) {
            sendError(res, 504, "gemini_timeout", "Gemini request timed out.");
            return;
          }
          if (err instanceof GeminiMalformedOutputError) {
            sendError(res, 502, "gemini_invalid_output", "Gemini returned invalid output.");
            return;
          }
          if (err instanceof GeminiRequestError && err.status === 429) {
            sendError(res, 429, "gemini_rate_limited", "Gemini rate limit or quota exceeded. Please wait a moment and try again.");
            return;
          }
          if (err instanceof GeminiError) {
            sendError(res, 502, "gemini_request_failed", "Gemini request failed.");
            return;
          }
          next(err);
        }
      })();
    },
  );

  return router;
}
