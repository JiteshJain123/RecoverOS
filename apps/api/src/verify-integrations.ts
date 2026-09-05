/**
 * Production-minded integration verification (Gemini + Razorpay Test Mode +
 * webhook secret). This module contains ONLY pure/dependency-injected logic so
 * it is fully testable without real credentials or the network; the CLI wiring
 * lives in `scripts/verify-integrations.ts`.
 *
 * SECURITY: nothing here ever returns, logs, or embeds a secret value. It
 * reports classified STATUSES plus non-secret facts (the model id, the mode
 * "TEST"). The connectivity probes are injected functions, so this module never
 * itself constructs auth headers or touches a key. `redact()` is applied
 * defensively to any free-text detail before it can leave the process.
 */
import { type Env } from "@recoveros/config";
import { GeminiConfigError, GeminiError, GeminiRequestError, loadGeminiConfig } from "@recoveros/ai";
import { RazorpayConfigError, RazorpayError, assertTestMode, redact } from "@recoveros/payments";

/** Configuration presence/shape status (never reveals the value). */
export type ConfigStatus = "OK" | "MISSING" | "MISCONFIGURED" | "REJECTED_LIVE";
/**
 * Live connectivity status.
 *  - UNREACHABLE  = external/network/provider (timeout, transport, 5xx) — not a bug.
 *  - RATE_LIMITED = provider quota / rate limit (HTTP 429) — transient, not a bug.
 *  - FAILED       = a code/credential/output problem (auth 401/403, malformed output).
 */
export type ProbeStatus = "OK" | "SKIPPED" | "UNREACHABLE" | "RATE_LIMITED" | "FAILED";

export interface GeminiSection {
  config: ConfigStatus;
  /** Non-secret model id (from GEMINI_MODEL); defaults to gemini-3.5-flash. */
  model: string | null;
  connectivity: ProbeStatus;
  detail?: string;
}
export interface RazorpaySection {
  config: ConfigStatus;
  mode: "TEST" | null;
  connectivity: ProbeStatus;
  detail?: string;
}
export interface WebhookSection {
  config: "OK" | "MISSING";
}

export interface IntegrationReport {
  gemini: GeminiSection;
  razorpay: RazorpaySection;
  webhook: WebhookSection;
}

/** Overall classification derived from a report. */
export interface ReportVerdict {
  /** No configuration problems and no code-level probe failures. */
  configOk: boolean;
  /** A probe could not reach the provider (external connectivity), not a bug. */
  connectivityUnreachable: boolean;
  /** A code/output-level failure (e.g. malformed response) — a real defect. */
  codeFailure: boolean;
}

// --- Configuration checks (pure) -------------------------------------------

/**
 * Gemini config: the key is read server-side only via {@link loadGeminiConfig}
 * (which throws {@link GeminiConfigError} when GEMINI_API_KEY is blank). The
 * model is reported from GEMINI_MODEL, which the schema defaults to
 * `gemini-3.5-flash`.
 */
export function checkGeminiConfig(env: Env): { config: ConfigStatus; model: string | null } {
  const model = (env.GEMINI_MODEL ?? "").trim() || null;
  try {
    const cfg = loadGeminiConfig({ env });
    return { config: "OK", model: cfg.model };
  } catch (err) {
    if (err instanceof GeminiConfigError) return { config: "MISSING", model };
    throw err;
  }
}

/**
 * Razorpay config: key id + secret are read server-side only. Validity is
 * decided by {@link assertTestMode} (the single source of truth); we classify
 * the reason from the NON-SECRET key-id prefix only. A `rzp_live_*` key is
 * rejected outright — Test Mode is the only allowed mode.
 */
export function checkRazorpayConfig(env: Env): { config: ConfigStatus; mode: "TEST" | null } {
  const keyId = (env.RAZORPAY_KEY_ID ?? "").trim();
  const keySecret = (env.RAZORPAY_KEY_SECRET ?? "").trim();
  if (!keyId || !keySecret) return { config: "MISSING", mode: null };
  try {
    assertTestMode({ keyId, keySecret });
    return { config: "OK", mode: "TEST" };
  } catch (err) {
    if (err instanceof RazorpayConfigError) {
      return { config: keyId.startsWith("rzp_live_") ? "REJECTED_LIVE" : "MISCONFIGURED", mode: null };
    }
    throw err;
  }
}

/**
 * Webhook secret: presence only. The value is NEVER read for content, logged,
 * or returned — signature verification consumes it separately in @recoveros/webhooks.
 */
export function checkWebhookSecret(env: Env): WebhookSection {
  return { config: (env.RAZORPAY_WEBHOOK_SECRET ?? "").trim() ? "OK" : "MISSING" };
}

// --- Connectivity probes (injected; classify external vs code failures) ----

/**
 * Run an injected Gemini call and classify the outcome, preserving a useful
 * distinction between failure kinds:
 *   - config error                → SKIPPED (key/model not configured)
 *   - HTTP 429                     → RATE_LIMITED (provider quota/rate limit; transient)
 *   - HTTP 401/403                → FAILED (authentication — a real credential problem)
 *   - transport/timeout/other http → UNREACHABLE (external, not a code bug)
 *   - malformed output            → FAILED (code/output defect)
 * The injected function is the ONLY thing that touches the network/key, so this
 * stays test-safe.
 */
export async function probeGemini(run: () => Promise<unknown>): Promise<{ status: ProbeStatus; detail?: string }> {
  try {
    await run();
    return { status: "OK" };
  } catch (err) {
    if (err instanceof GeminiConfigError) return { status: "SKIPPED", detail: "config" };
    if (err instanceof GeminiRequestError && err.status === 429) {
      return { status: "RATE_LIMITED", detail: "rate_limit" };
    }
    if (err instanceof GeminiRequestError && (err.status === 401 || err.status === 403)) {
      return { status: "FAILED", detail: "auth" };
    }
    if (err instanceof GeminiError) {
      const external = err.category === "network" || err.category === "timeout" || err.category === "http";
      return { status: external ? "UNREACHABLE" : "FAILED", detail: err.category };
    }
    return { status: "FAILED", detail: "unknown" };
  }
}

/**
 * Run an injected Razorpay health call (e.g. `verifyConnection`) and classify.
 * Config errors → SKIPPED; timeout/network/5xx/rate-limit → UNREACHABLE;
 * auth/malformed/4xx → FAILED (a real credential/code problem).
 */
export async function probeRazorpay(run: () => Promise<unknown>): Promise<{ status: ProbeStatus; detail?: string }> {
  try {
    await run();
    return { status: "OK" };
  } catch (err) {
    if (err instanceof RazorpayConfigError) return { status: "SKIPPED", detail: "config" };
    if (err instanceof RazorpayError) {
      const external =
        err.category === "timeout" ||
        err.category === "network" ||
        err.category === "server_error" ||
        err.category === "rate_limit";
      return { status: external ? "UNREACHABLE" : "FAILED", detail: err.category };
    }
    return { status: "FAILED", detail: "unknown" };
  }
}

// --- Orchestration + reporting ---------------------------------------------

export interface RunIntegrationChecksDeps {
  env: Env;
  /** Real Gemini call (built from the AI abstraction). Omit to skip the probe. */
  geminiProbe?: () => Promise<unknown>;
  /** Real Razorpay health call. Omit to skip the probe. */
  razorpayProbe?: () => Promise<unknown>;
}

/** Assemble the full, secret-free integration report. */
export async function runIntegrationChecks(deps: RunIntegrationChecksDeps): Promise<IntegrationReport> {
  const g = checkGeminiConfig(deps.env);
  const r = checkRazorpayConfig(deps.env);
  const webhook = checkWebhookSecret(deps.env);

  const gemini: GeminiSection = { config: g.config, model: g.model, connectivity: "SKIPPED" };
  if (g.config === "OK" && deps.geminiProbe) {
    const p = await probeGemini(deps.geminiProbe);
    gemini.connectivity = p.status;
    if (p.detail) gemini.detail = redact(p.detail);
  }

  const razorpay: RazorpaySection = { config: r.config, mode: r.mode, connectivity: "SKIPPED" };
  if (r.config === "OK" && deps.razorpayProbe) {
    const p = await probeRazorpay(deps.razorpayProbe);
    razorpay.connectivity = p.status;
    if (p.detail) razorpay.detail = redact(p.detail);
  }

  return { gemini, razorpay, webhook };
}

/** Classify a report into an actionable verdict (drives the CLI exit code). */
export function verdictFor(report: IntegrationReport): ReportVerdict {
  const configOk =
    report.gemini.config === "OK" &&
    report.razorpay.config === "OK" &&
    report.webhook.config === "OK";
  const connectivityUnreachable =
    report.gemini.connectivity === "UNREACHABLE" || report.razorpay.connectivity === "UNREACHABLE";
  const codeFailure =
    report.gemini.connectivity === "FAILED" || report.razorpay.connectivity === "FAILED";
  return { configOk, connectivityUnreachable, codeFailure };
}

/**
 * Render the human-readable report. Contains ONLY statuses + the non-secret
 * model id and mode; `redact()` is applied as a final guard so no secret-shaped
 * substring can ever escape.
 */
export function formatReport(report: IntegrationReport): string[] {
  const lines = [
    `Gemini configuration: ${report.gemini.config}`,
    `Gemini model: ${report.gemini.model ?? "(unset)"}`,
    `Gemini connectivity: ${report.gemini.connectivity}${report.gemini.detail ? ` (${report.gemini.detail})` : ""}`,
    `Razorpay configuration: ${report.razorpay.config}`,
    `Razorpay mode: ${report.razorpay.mode ?? "(none)"}`,
    `Razorpay connectivity: ${report.razorpay.connectivity}${report.razorpay.detail ? ` (${report.razorpay.detail})` : ""}`,
    `Webhook secret: ${report.webhook.config}`,
  ];
  return lines.map(redact);
}
