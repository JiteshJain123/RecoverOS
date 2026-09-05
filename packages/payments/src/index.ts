/**
 * @recoveros/payments
 *
 * The ONLY package permitted to call the Razorpay financial API. It is invoked
 * exclusively by the execution layer AFTER the deterministic policy engine
 * authorizes an action (and, for REVIEW, a human approves). It implements the
 * existing `PaymentRecoveryProvider` interface, so it drops into the executor in
 * place of the simulator without any parallel architecture.
 *
 * SECURITY INVARIANTS:
 *  - TEST MODE ONLY: `rzp_test_*` credentials; `rzp_live_*` is rejected. No real
 *    money can move.
 *  - This package must NEVER be imported by @recoveros/ai — Gemini cannot call
 *    Razorpay directly. Nothing here bypasses policy/authorization/safeguards.
 *  - The API secret is read via a credential source, never stored in Postgres,
 *    logged, serialized, or returned by any endpoint.
 */
import { RazorpayClient } from "./client";
import { RazorpayTestProvider } from "./razorpay-provider";
import {
  EnvRazorpayCredentialSource,
  defaultRazorpayConfig,
  type RazorpayConfig,
  type RazorpayCredentialSource,
} from "./config";
import { fetchTransport, type HttpTransport } from "./transport";
import type { Logger } from "@recoveros/observability";

// Config + credential boundary
export {
  RAZORPAY_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  defaultRazorpayConfig,
  assertTestMode,
  EnvRazorpayCredentialSource,
  StaticRazorpayCredentialSource,
} from "./config";
export type {
  RazorpayConfig,
  RazorpayCredentials,
  RazorpayCredentialSource,
  PaymentsTenantContext,
} from "./config";

// Errors
export {
  RazorpayError,
  RazorpayConfigError,
  RazorpayAuthError,
  RazorpayTimeoutError,
  RazorpayRateLimitError,
  RazorpayApiError,
  RazorpayMalformedResponseError,
  RazorpayNetworkError,
} from "./errors";
export type { RazorpayErrorCategory } from "./errors";

// Transport + client boundary
export { fetchTransport } from "./transport";
export type { HttpTransport, HttpResponseLike, HttpRequestInit } from "./transport";
export { RazorpayClient } from "./client";
export type { RazorpayRequest, RazorpayResponse, RazorpayCallMeta, RazorpayClientDeps } from "./client";

// Schemas (consumed subset)
export {
  razorpayPaymentSchema,
  razorpayOrderSchema,
  razorpayPaymentLinkSchema,
} from "./schemas";
export type { RazorpayPaymentRaw, RazorpayOrderRaw, RazorpayPaymentLinkRaw } from "./schemas";

// Provider + operations
export { RazorpayTestProvider } from "./razorpay-provider";
export type { RazorpayTestProviderDeps } from "./razorpay-provider";
export type {
  PaymentGatewayOperations,
  PaymentView,
  OrderView,
  PaymentLinkView,
  CaptureResult,
  CancelLinkResult,
  CreatePaymentLinkInput,
  ConnectionInfo,
} from "./operations";

// Redaction (exported for defensive use at the edges)
export { redact, maskKeyId } from "./redact";

export interface CreateRazorpayProviderOptions {
  credentials?: RazorpayCredentialSource;
  config?: Partial<RazorpayConfig>;
  transport?: HttpTransport;
  logger?: Logger;
}

/**
 * Production composition root: env credentials (test mode) + fetch transport.
 * The returned provider implements `PaymentRecoveryProvider` for the executor.
 */
export function createRazorpayTestProvider(options: CreateRazorpayProviderOptions = {}): RazorpayTestProvider {
  const client = new RazorpayClient({
    credentials: options.credentials ?? new EnvRazorpayCredentialSource(),
    config: defaultRazorpayConfig(options.config),
    transport: options.transport ?? fetchTransport,
    logger: options.logger,
  });
  return new RazorpayTestProvider({ client, logger: options.logger });
}
