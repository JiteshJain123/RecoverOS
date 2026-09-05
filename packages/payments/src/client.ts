/**
 * RazorpayClient — the single HTTP boundary for Razorpay. Business logic never
 * constructs URLs, headers, or auth: it calls typed operations on the provider,
 * which call this client. Responsibilities:
 *   - resolve tenant credentials via the secure credential source;
 *   - build HTTP Basic auth from key_id:key_secret (never logged);
 *   - apply a bounded timeout (AbortController);
 *   - classify HTTP/transport failures into the typed error taxonomy;
 *   - parse the JSON body (malformed → typed error);
 *   - emit structured, secret-free observability metadata.
 */
import type { Logger } from "@recoveros/observability";
import {
  RazorpayApiError,
  RazorpayAuthError,
  RazorpayMalformedResponseError,
  RazorpayNetworkError,
  RazorpayRateLimitError,
  RazorpayTimeoutError,
} from "./errors";
import { redact } from "./redact";
import {
  type PaymentsTenantContext,
  type RazorpayConfig,
  type RazorpayCredentialSource,
} from "./config";
import { fetchTransport, type HttpTransport } from "./transport";

export interface RazorpayRequest {
  /** Logical operation name for observability (e.g. "fetch_payment"). */
  operation: string;
  method: "GET" | "POST";
  /** Path relative to the base URL, e.g. "/payments/pay_123". */
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
  /** Idempotency key sent as a header where the operation supports it. */
  idempotencyKey?: string;
}

/** Secret-free metadata describing one call. Safe to log/return upstream. */
export interface RazorpayCallMeta {
  operation: string;
  tenantId: string;
  status: number;
  latencyMs: number;
  requestId?: string;
  rateLimited: boolean;
}

export interface RazorpayResponse {
  data: unknown;
  meta: RazorpayCallMeta;
}

export interface RazorpayClientDeps {
  credentials: RazorpayCredentialSource;
  config: RazorpayConfig;
  transport?: HttpTransport;
  logger?: Logger;
  now?: () => number;
}

export class RazorpayClient {
  private readonly credentials: RazorpayCredentialSource;
  private readonly config: RazorpayConfig;
  private readonly transport: HttpTransport;
  private readonly logger?: Logger;
  private readonly now: () => number;

  constructor(deps: RazorpayClientDeps) {
    this.credentials = deps.credentials;
    this.config = deps.config;
    this.transport = deps.transport ?? fetchTransport;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
  }

  async request(ctx: PaymentsTenantContext, req: RazorpayRequest): Promise<RazorpayResponse> {
    // Resolve credentials (validates TEST MODE); the secret never leaves here.
    const creds = await this.credentials.getCredentials(ctx);
    const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");

    const url = this.buildUrl(req.path, req.query);
    const headers: Record<string, string> = {
      authorization: `Basic ${auth}`,
      accept: "application/json",
    };
    if (req.body) headers["content-type"] = "application/json";
    if (req.idempotencyKey) headers["x-razorpay-idempotency-key"] = req.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const startedAt = this.now();

    let status = 0;
    let requestId: string | undefined;
    let rawBody = "";
    try {
      let res;
      try {
        res = await this.transport(url, {
          method: req.method,
          headers,
          body: req.body ? JSON.stringify(req.body) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new RazorpayTimeoutError(this.config.timeoutMs);
        }
        throw new RazorpayNetworkError();
      }

      status = res.status;
      requestId = res.headers.get("x-razorpay-request-id") ?? undefined;
      rawBody = await res.text();

      if (status === 429) throw new RazorpayRateLimitError();
      if (status === 401 || status === 403) throw new RazorpayAuthError(status);
      if (status >= 500) throw new RazorpayApiError(status, "server_error");
      if (status >= 400) throw new RazorpayApiError(status, "client_error");

      let data: unknown;
      try {
        data = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        throw new RazorpayMalformedResponseError();
      }

      const meta = this.meta(req.operation, ctx.tenantId, status, startedAt, requestId, false);
      this.logger?.debug("razorpay.call", meta as unknown as Record<string, unknown>);
      return { data, meta };
    } catch (err) {
      const rateLimited = status === 429;
      const meta = this.meta(req.operation, ctx.tenantId, status, startedAt, requestId, rateLimited);
      // Log only safe metadata + redacted category — never the body/headers.
      this.logger?.warn("razorpay.call.failed", {
        ...(meta as unknown as Record<string, unknown>),
        category: err instanceof Error ? redact(err.name) : "unknown",
      });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private meta(
    operation: string,
    tenantId: string,
    status: number,
    startedAt: number,
    requestId: string | undefined,
    rateLimited: boolean,
  ): RazorpayCallMeta {
    return {
      operation,
      tenantId,
      status,
      latencyMs: Math.max(0, this.now() - startedAt),
      requestId,
      rateLimited,
    };
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const base = `${this.config.baseUrl}${path}`;
    if (!query) return base;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }
}
