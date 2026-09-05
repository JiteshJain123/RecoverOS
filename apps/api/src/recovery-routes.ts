/**
 * DEVELOPMENT-ONLY recovery policy-gate + execution endpoints.
 *
 *   POST /dev/tenants/:tenantId/recovery-actions/:actionId/approve
 *   POST /dev/tenants/:tenantId/recovery/batch
 *
 * Both require a tenant context (path param). The approval endpoint additionally
 * requires an authorized role (via `x-user-role` / `x-user-id` headers standing
 * in for the authenticated principal); a VIEWER is rejected. The batch endpoint
 * runs the full detection→strategy→policy→simulated-execution pipeline over the
 * tenant's persisted cases and returns metrics. Neither executes real money,
 * calls Razorpay, or sends messages. Registered only when NODE_ENV !==
 * "production" (re-checked at request time).
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import {
  ApprovalService,
  BatchRecoveryEvaluator,
  PrismaExecutionStore,
  PrismaRecoveryCaseSource,
  RecoveryActionExecutor,
  SimulatedRecoveryProvider,
  UnauthorizedApprovalError,
  ActionNotFoundError,
  InvalidActionTransitionError,
  type Role,
} from "@recoveros/execution";
import type { Logger } from "@recoveros/observability";

interface ApiErrorBody {
  error: { code: string; message: string };
}
function sendError(res: Response, status: number, code: string, message: string): void {
  const body: ApiErrorBody = { error: { code, message } };
  res.status(status).json(body);
}

const VALID_ROLES: ReadonlySet<string> = new Set(["OWNER", "ADMIN", "APPROVER", "ANALYST", "VIEWER"]);

export interface RecoveryRouterOptions {
  logger?: Logger;
  enableDevEndpoints?: boolean;
  clock?: { now(): Date };
}

export function createRecoveryRouter(options: RecoveryRouterOptions = {}): Router {
  const router = Router();
  if (options.enableDevEndpoints !== true) return router;

  const clock = options.clock ?? { now: () => new Date() };
  const store = new PrismaExecutionStore();
  const approvals = new ApprovalService({ store, clock, logger: options.logger });

  const guardProd = (req: Request, res: Response, next: NextFunction): void => {
    if (process.env.NODE_ENV === "production") {
      sendError(res, 404, "not_found", "Not found.");
      return;
    }
    next();
  };

  // --- Human approval of a REVIEW action ----------------------------------
  router.post(
    "/dev/tenants/:tenantId/recovery-actions/:actionId/approve",
    guardProd,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        const tenantId = req.params.tenantId?.trim();
        const actionId = req.params.actionId?.trim();
        if (!tenantId) return sendError(res, 400, "tenant_context_required", "Missing tenant context.");
        if (!actionId) return sendError(res, 400, "validation_error", "Missing action id.");

        const role = String(req.header("x-user-role") ?? "").toUpperCase();
        const userId = String(req.header("x-user-id") ?? "").trim();
        if (!VALID_ROLES.has(role) || !userId) {
          return sendError(res, 401, "actor_required", "Missing/invalid x-user-role or x-user-id.");
        }
        const explicit = req.body && typeof req.body === "object" && req.body.approve === true;
        if (!explicit) return sendError(res, 400, "validation_error", "Body must include { approve: true }.");

        try {
          const action = await approvals.approve({ tenantId }, actionId, { userId, role: role as Role });
          res.json({ mode: "development", tenantId, actionId, action });
        } catch (err) {
          if (err instanceof UnauthorizedApprovalError) return sendError(res, 403, "forbidden", err.message);
          if (err instanceof ActionNotFoundError) return sendError(res, 404, "not_found", "Action not found.");
          if (err instanceof InvalidActionTransitionError) return sendError(res, 409, "invalid_transition", err.message);
          next(err);
        }
      })();
    },
  );

  // --- Batch evaluation over the tenant's persisted cases -----------------
  router.post(
    "/dev/tenants/:tenantId/recovery/batch",
    guardProd,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        const tenantId = req.params.tenantId?.trim();
        if (!tenantId) return sendError(res, 400, "tenant_context_required", "Missing tenant context.");
        try {
          const executor = new RecoveryActionExecutor({
            store,
            provider: new SimulatedRecoveryProvider(),
            clock,
            logger: options.logger,
          });
          const evaluator = new BatchRecoveryEvaluator({
            source: new PrismaRecoveryCaseSource(),
            executor,
            clock,
            logger: options.logger,
          });
          const metrics = await evaluator.run({ tenantId });
          res.json({ mode: "development", executed: "simulated", ...metrics });
        } catch (err) {
          next(err);
        }
      })();
    },
  );

  return router;
}
