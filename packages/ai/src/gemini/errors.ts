/**
 * Typed error taxonomy for the Gemini integration. Each error carries a stable
 * `category` string that is recorded on the AgentRun/AgentToolCall so failures
 * are auditable without ever storing secrets or raw provider payloads.
 *
 * The categories also drive control flow:
 *   - `config`      → do NOT retry (operator must fix env); surfaces as 4xx/5xx.
 *   - `network`     → SAFE to retry (transient transport failure).
 *   - `timeout`     → SAFE to retry (bounded); recorded as AgentRun TIMEOUT.
 *   - `http`        → retryable only for 5xx/429; recorded as AgentRun FAILED.
 *   - `malformed`   → do NOT retry (model produced invalid/unsafe output);
 *                     recorded as AgentRun INVALID_OUTPUT.
 */

export type GeminiErrorCategory = "config" | "network" | "timeout" | "http" | "malformed";

export class GeminiError extends Error {
  constructor(
    message: string,
    public readonly category: GeminiErrorCategory,
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = new.target.name;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** Missing API key or invalid model configuration. Never retried. */
export class GeminiConfigError extends GeminiError {
  constructor(message: string) {
    super(message, "config", false);
  }
}

/** Transport-level failure (DNS, connection reset, fetch threw). Retryable. */
export class GeminiRequestError extends GeminiError {
  constructor(
    message: string,
    public readonly status?: number,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    // 5xx and 429 are retryable; other HTTP statuses are not. A thrown fetch
    // (no status) is a network error and is retryable.
    const retryable =
      options?.retryable ??
      (status === undefined ? true : status >= 500 || status === 429);
    super(message, status === undefined ? "network" : "http", retryable, options);
  }
}

/** The request exceeded the configured timeout. Retryable (bounded). */
export class GeminiTimeoutError extends GeminiError {
  constructor(public readonly timeoutMs: number) {
    super(`Gemini request timed out after ${timeoutMs}ms`, "timeout", true);
  }
}

/**
 * Gemini returned output that is not valid JSON, does not match the required
 * schema, or violates a safety invariant (e.g. an unknown strategy). NEVER
 * retried and NEVER allowed to proceed to the policy/execution layer.
 */
export class GeminiMalformedOutputError extends GeminiError {
  constructor(
    message: string,
    public readonly issues: Array<{ path: string; message: string }> = [],
  ) {
    super(message, "malformed", false);
  }
}
