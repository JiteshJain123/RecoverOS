/**
 * Typed error taxonomy for the Razorpay adapter. Each error carries a stable
 * `category` that drives control flow and is safe to record in audits/logs.
 * NONE of these ever include credentials, Authorization headers, or raw
 * response bodies (see redact.ts) — only a status and a generic message.
 */
export type RazorpayErrorCategory =
  | "config" // missing/invalid/live credentials — never retried
  | "auth" // 401/403 — authentication/authorization failure
  | "timeout" // request exceeded the bounded timeout
  | "rate_limit" // 429 — provider throttled us
  | "client_error" // other 4xx
  | "server_error" // 5xx
  | "malformed" // response was not valid/expected JSON
  | "network"; // transport failure (DNS/connection)

export class RazorpayError extends Error {
  constructor(
    message: string,
    public readonly category: RazorpayErrorCategory,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Missing/invalid config, or LIVE credentials supplied (test-mode only). */
export class RazorpayConfigError extends RazorpayError {
  constructor(message: string) {
    super(message, "config", false);
  }
}

/** Authentication/authorization failure (401/403). */
export class RazorpayAuthError extends RazorpayError {
  constructor(status: number) {
    super(`Razorpay authentication failed (HTTP ${status}).`, "auth", false, status);
  }
}

/** The request exceeded the configured timeout. Safe to retry (bounded). */
export class RazorpayTimeoutError extends RazorpayError {
  constructor(public readonly timeoutMs: number) {
    super(`Razorpay request timed out after ${timeoutMs}ms.`, "timeout", true);
  }
}

/** Provider throttled the request (HTTP 429). Safe to retry with backoff. */
export class RazorpayRateLimitError extends RazorpayError {
  constructor() {
    super("Razorpay rate limit exceeded (HTTP 429).", "rate_limit", true, 429);
  }
}

/** A non-auth 4xx (client error). Not retryable. */
export class RazorpayApiError extends RazorpayError {
  constructor(status: number, category: "client_error" | "server_error") {
    super(`Razorpay returned HTTP ${status}.`, category, category === "server_error", status);
  }
}

/** Response body was not valid JSON or did not match the expected schema. */
export class RazorpayMalformedResponseError extends RazorpayError {
  constructor(message = "Razorpay returned a malformed response.") {
    super(message, "malformed", false);
  }
}

/** Transport-level failure (fetch threw). Safe to retry. */
export class RazorpayNetworkError extends RazorpayError {
  constructor() {
    super("Razorpay request failed at the transport layer.", "network", true);
  }
}
