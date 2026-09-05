/**
 * Razorpay webhook endpoint.
 *
 *   POST /webhooks/razorpay
 *
 * CRITICAL: this route reads the RAW request body (a Buffer) so the HMAC-SHA256
 * signature can be verified over the exact bytes Razorpay signed. It MUST be
 * mounted BEFORE any JSON body parser, and uses its own `express.raw` parser.
 *
 * It delegates all logic to the tenant-scoped WebhookProcessor. The response is
 * a minimal, safe envelope — never credentials, never raw provider payloads.
 * This handler never executes recovery; it only records facts.
 */
import express, { Router, type Request, type Response } from "express";
import { createRazorpayWebhookProcessor, type WebhookProcessor } from "@recoveros/webhooks";
import type { Logger } from "@recoveros/observability";

export interface WebhookRouterOptions {
  /** Injectable for tests; otherwise built from env (Prisma + env mapping). */
  processor?: WebhookProcessor;
  logger?: Logger;
}

export function createWebhookRouter(options: WebhookRouterOptions = {}): Router {
  const router = Router();

  // Lazily build so a missing secret/mapping only fails a request, not startup.
  let processor = options.processor;
  const getProcessor = (): WebhookProcessor => {
    if (!processor) processor = createRazorpayWebhookProcessor({ logger: options.logger });
    return processor;
  };

  router.post(
    "/webhooks/razorpay",
    // Raw body parser for THIS route only — required for signature verification.
    express.raw({ type: () => true, limit: "1mb" }),
    (req: Request, res: Response, next) => {
      void (async () => {
        try {
          const rawBody = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.from("");
          const result = await getProcessor().process({
            rawBody,
            signature: req.header("x-razorpay-signature"),
            eventId: req.header("x-razorpay-event-id"),
          });
          // Safe envelope only.
          res.status(result.httpStatus).json({
            status: result.status,
            ...(result.code ? { code: result.code } : {}),
            ...(result.webhookId ? { webhookId: result.webhookId } : {}),
          });
        } catch (err) {
          options.logger?.error("webhook.handler_error", {
            message: err instanceof Error ? err.message : "unknown",
          });
          next(err);
        }
      })();
    },
  );

  return router;
}
