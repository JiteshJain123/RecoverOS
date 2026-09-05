/**
 * @recoveros/webhooks
 *
 * Razorpay webhook ingestion — a financial-integrity pipeline that turns signed
 * provider events into canonical facts (Payment + PaymentEvent) and lets the
 * recovery engine decide what happens next. It NEVER executes recovery, sends
 * messages, or calls the Razorpay API, and it never trusts a client-supplied
 * tenant: the tenant is resolved from the VERIFIED provider account.
 *
 * SECURITY: HMAC-SHA256 is verified over the RAW request body (never a
 * re-stringified JSON). Secrets are used only for verification and are never
 * stored, logged, or returned.
 */
import { WebhookProcessor } from "./processor";
import { PrismaWebhookStore, PrismaCaseReconciler } from "./adapters/prisma-webhook-store";
import { EnvProviderAccountResolver, EnvWebhookSecretSource } from "./tenant-map";
import type { Logger } from "@recoveros/observability";

// Signature
export { verifyRazorpaySignature, computeSignature } from "./signature";

// Errors
export { WebhookError, WebhookSignatureError, WebhookPayloadError, UnmappedAccountError } from "./errors";

// Payload adapter
export {
  parseWebhookEvent,
  isSupportedEvent,
  SUPPORTED_EVENTS,
} from "./razorpay-schemas";
export type { ParsedWebhookEvent, NeutralPayment, NeutralOrder, SupportedEvent } from "./razorpay-schemas";

// Reconciliation helpers
export { mapEvent, advances, statusRank } from "./reconcile";
export type { CanonicalStatus, InternalEventType, EventMapping } from "./reconcile";

// Tenant mapping + secret source
export {
  StaticProviderAccountResolver,
  EnvProviderAccountResolver,
  StaticWebhookSecretSource,
  EnvWebhookSecretSource,
} from "./tenant-map";
export type { ProviderAccountResolver, WebhookSecretSource } from "./tenant-map";

// Store (port) + in-memory + adapters
export { InMemoryWebhookStore, SpyCaseReconciler } from "./in-memory-store";
export { PrismaWebhookStore, PrismaCaseReconciler } from "./adapters/prisma-webhook-store";
export type {
  WebhookStore,
  CaseReconciler,
  WebhookRecord,
  WebhookStatus,
  PaymentRecord,
  CreateWebhookInput,
  UpsertPaymentInput,
  CreatePaymentEventInput,
  WebhookAuditEntry,
} from "./store";

// Processor
export { WebhookProcessor } from "./processor";
export type { WebhookProcessorDeps, WebhookInput, WebhookResult, WebhookResultStatus, Clock } from "./processor";

// Fixtures / replay harness
export { buildWebhookFixture } from "./fixtures";
export type { FixtureOptions, WebhookFixture } from "./fixtures";

/** Production composition root: env secret + env account mapping + Prisma. */
export function createRazorpayWebhookProcessor(options?: { logger?: Logger }): WebhookProcessor {
  return new WebhookProcessor({
    store: new PrismaWebhookStore(),
    resolver: new EnvProviderAccountResolver(),
    secret: new EnvWebhookSecretSource(),
    caseReconciler: new PrismaCaseReconciler(),
    clock: { now: () => new Date() },
    logger: options?.logger,
  });
}
