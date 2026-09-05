/**
 * DEVELOPMENT-ONLY Razorpay Test Mode connection check.
 *
 *   GET /dev/tenants/:tenantId/razorpay/verify
 *
 * It requires a tenant context, makes ONE harmless authenticated read
 * (`GET /v1/payments?count=1`) via the test-mode adapter, and returns only safe
 * metadata (mode, ok, latency, requestId). It NEVER returns credentials, and
 * the API secret is never logged or included in any error. Registered only when
 * NODE_ENV !== "production" (re-checked at request time).
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import {
  RazorpayConfigError,
  RazorpayError,
  RazorpayTimeoutError,
  createRazorpayTestProvider,
  type RazorpayTestProvider,
} from "@recoveros/payments";
import type { Logger } from "@recoveros/observability";

interface ApiErrorBody {
  error: { code: string; message: string };
}
function sendError(res: Response, status: number, code: string, message: string): void {
  const body: ApiErrorBody = { error: { code, message } };
  res.status(status).json(body);
}

export interface RazorpayRouterOptions {
  provider?: RazorpayTestProvider;
  logger?: Logger;
  enableDevEndpoints?: boolean;
}

export function createRazorpayRouter(options: RazorpayRouterOptions = {}): Router {
  const router = Router();
  if (options.enableDevEndpoints !== true) return router;

  let provider = options.provider;
  const getProvider = (): RazorpayTestProvider => {
    if (!provider) provider = createRazorpayTestProvider({ logger: options.logger });
    return provider;
  };

  router.get(
    "/dev/tenants/:tenantId/razorpay/verify",
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
        if (!tenantId) return sendError(res, 400, "tenant_context_required", "Missing tenant context.");

        let p: RazorpayTestProvider;
        try {
          p = getProvider();
        } catch (err) {
          if (err instanceof RazorpayConfigError) return sendError(res, 503, "razorpay_not_configured", err.message);
          throw err;
        }

        try {
          const info = await p.verifyConnection({ tenantId });
          res.json({ mode: "development", tenantId, razorpay: info });
        } catch (err) {
          // Map to safe envelopes; never echo secrets or raw provider bodies.
          if (err instanceof RazorpayConfigError) return sendError(res, 503, "razorpay_not_configured", err.message);
          if (err instanceof RazorpayTimeoutError) return sendError(res, 504, "razorpay_timeout", "Razorpay request timed out.");
          if (err instanceof RazorpayError) {
            return sendError(res, 502, "razorpay_unreachable", `Razorpay check failed (${err.category}).`);
          }
          next(err);
        }
      })();
    },
  );

  return router;
}
