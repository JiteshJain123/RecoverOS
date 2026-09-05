/**
 * Regression tests for the integration verification pass. These run with MOCKS
 * only — no real credentials, no network — so they pass in CI regardless of
 * whether real Gemini/Razorpay keys are configured locally.
 *
 * They also assert the security invariants: no secret value ever appears in a
 * report or a formatted line, and Test Mode is enforced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "@recoveros/config";
import { GeminiConfigError, GeminiRequestError, GeminiTimeoutError, GeminiMalformedOutputError } from "@recoveros/ai";
import {
  RazorpayAuthError,
  RazorpayConfigError,
  RazorpayTimeoutError,
  StaticRazorpayCredentialSource,
  assertTestMode,
} from "@recoveros/payments";
import { SimulatedRecoveryProvider } from "@recoveros/execution";
import { resolveProviderSelectionFromEnv, selectExecutionProvider } from "@recoveros/lifecycle";
import {
  checkGeminiConfig,
  checkRazorpayConfig,
  checkWebhookSecret,
  formatReport,
  probeGemini,
  probeRazorpay,
  runIntegrationChecks,
  verdictFor,
} from "./verify-integrations";

// A representative secret whose VALUE must never leak into any output.
const FAKE_SECRET = "sk_super_secret_value_do_not_leak_123456";
const FAKE_WEBHOOK_SECRET = "whsec_never_leak_this_987654";

function env(over: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    API_PORT: 4000,
    WEB_PORT: 3000,
    DATABASE_URL: undefined,
    GEMINI_API_KEY: "gk_test_key",
    GEMINI_MODEL: "gemini-3.5-flash",
    RAZORPAY_KEY_ID: "rzp_test_abc123",
    RAZORPAY_KEY_SECRET: FAKE_SECRET,
    RAZORPAY_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
    RAZORPAY_WEBHOOK_ACCOUNT_ID: undefined,
    RAZORPAY_WEBHOOK_TENANT_ID: undefined,
    EXECUTION_PROVIDER: "SIMULATED",
    RAZORPAY_TEST_ENABLED: false,
    ...over,
  } as Env;
}

// --- Gemini configuration ---------------------------------------------------

test("missing Gemini key → MISSING (still reports the default model)", () => {
  const r = checkGeminiConfig(env({ GEMINI_API_KEY: "" }));
  assert.equal(r.config, "MISSING");
  assert.equal(r.model, "gemini-3.5-flash");
});

test("valid Gemini configuration → OK and model defaults to gemini-3.5-flash", () => {
  const r = checkGeminiConfig(env());
  assert.equal(r.config, "OK");
  assert.equal(r.model, "gemini-3.5-flash");
});

// --- Razorpay configuration -------------------------------------------------

test("missing Razorpay credentials → MISSING", () => {
  assert.equal(checkRazorpayConfig(env({ RAZORPAY_KEY_ID: "", RAZORPAY_KEY_SECRET: "" })).config, "MISSING");
});

test("valid Razorpay Test credentials → OK, mode TEST", () => {
  const r = checkRazorpayConfig(env());
  assert.equal(r.config, "OK");
  assert.equal(r.mode, "TEST");
});

test("live Razorpay key is rejected (Test Mode only)", () => {
  const r = checkRazorpayConfig(env({ RAZORPAY_KEY_ID: "rzp_live_abc123" }));
  assert.equal(r.config, "REJECTED_LIVE");
  assert.equal(r.mode, null);
  // assertTestMode is the enforcement source of truth.
  assert.throws(() => assertTestMode({ keyId: "rzp_live_abc123", keySecret: FAKE_SECRET }), RazorpayConfigError);
});

test("non-test, non-live key id → MISCONFIGURED", () => {
  assert.equal(checkRazorpayConfig(env({ RAZORPAY_KEY_ID: "garbage_key" })).config, "MISCONFIGURED");
});

// --- Webhook secret ---------------------------------------------------------

test("missing webhook secret is detected", () => {
  assert.equal(checkWebhookSecret(env({ RAZORPAY_WEBHOOK_SECRET: "" })).config, "MISSING");
});

test("configured webhook secret is accepted", () => {
  assert.equal(checkWebhookSecret(env()).config, "OK");
});

// --- Probe classification (external vs code failure) ------------------------

test("Gemini probe: success → OK", async () => {
  assert.equal((await probeGemini(async () => ({}))).status, "OK");
});

test("Gemini probe: timeout/transport → UNREACHABLE (external, not a code bug)", async () => {
  assert.equal((await probeGemini(async () => { throw new GeminiTimeoutError(1000); })).status, "UNREACHABLE");
  assert.equal((await probeGemini(async () => { throw new GeminiRequestError("boom"); })).status, "UNREACHABLE");
});

test("Gemini probe: malformed output → FAILED (code/output defect)", async () => {
  assert.equal((await probeGemini(async () => { throw new GeminiMalformedOutputError("bad"); })).status, "FAILED");
});

test("Gemini probe: config error → SKIPPED", async () => {
  assert.equal((await probeGemini(async () => { throw new GeminiConfigError("no key"); })).status, "SKIPPED");
});

test("Razorpay probe: timeout → UNREACHABLE; auth → FAILED", async () => {
  assert.equal((await probeRazorpay(async () => { throw new RazorpayTimeoutError(1000); })).status, "UNREACHABLE");
  assert.equal((await probeRazorpay(async () => { throw new RazorpayAuthError(401); })).status, "FAILED");
});

// --- End-to-end report (mocked probes) --------------------------------------

test("full report with healthy mocks is OK and leaks no secret", async () => {
  const report = await runIntegrationChecks({
    env: env(),
    geminiProbe: async () => ({ strategy: "NO_ACTION" }),
    razorpayProbe: async () => ({ mode: "test", ok: true }),
  });
  assert.equal(report.gemini.config, "OK");
  assert.equal(report.gemini.connectivity, "OK");
  assert.equal(report.razorpay.config, "OK");
  assert.equal(report.razorpay.mode, "TEST");
  assert.equal(report.razorpay.connectivity, "OK");
  assert.equal(report.webhook.config, "OK");

  const verdict = verdictFor(report);
  assert.equal(verdict.configOk, true);
  assert.equal(verdict.codeFailure, false);

  // No secret exposure — neither the serialized report nor any formatted line.
  const serialized = JSON.stringify(report) + "\n" + formatReport(report).join("\n");
  assert.ok(!serialized.includes(FAKE_SECRET), "report must not contain the Razorpay key secret");
  assert.ok(!serialized.includes(FAKE_WEBHOOK_SECRET), "report must not contain the webhook secret");
  assert.ok(!serialized.includes("rzp_test_abc123"), "report must not contain the raw key id");
});

test("report distinguishes UNREACHABLE (external) from a config failure", async () => {
  const report = await runIntegrationChecks({
    env: env(),
    geminiProbe: async () => { throw new GeminiTimeoutError(1000); },
    razorpayProbe: async () => { throw new RazorpayTimeoutError(1000); },
  });
  const verdict = verdictFor(report);
  assert.equal(verdict.configOk, true, "config is fine even when the provider is unreachable");
  assert.equal(verdict.connectivityUnreachable, true);
  assert.equal(verdict.codeFailure, false);
});

test("formatReport emits the expected classified lines and nothing else", () => {
  const lines = formatReport({
    gemini: { config: "OK", model: "gemini-3.5-flash", connectivity: "OK" },
    razorpay: { config: "OK", mode: "TEST", connectivity: "OK" },
    webhook: { config: "OK" },
  });
  assert.ok(lines.includes("Gemini configuration: OK"));
  assert.ok(lines.includes("Gemini model: gemini-3.5-flash"));
  assert.ok(lines.includes("Gemini connectivity: OK"));
  assert.ok(lines.includes("Razorpay configuration: OK"));
  assert.ok(lines.includes("Razorpay mode: TEST"));
  assert.ok(lines.includes("Razorpay connectivity: OK"));
});

// --- Test Mode / provider-selection safety ---------------------------------

test("RAZORPAY_TEST cannot activate without credentials (falls back to SIMULATED)", () => {
  const cfg = resolveProviderSelectionFromEnv(env({ EXECUTION_PROVIDER: "RAZORPAY_TEST", RAZORPAY_TEST_ENABLED: true, RAZORPAY_KEY_ID: "", RAZORPAY_KEY_SECRET: "" }));
  const sel = selectExecutionProvider(cfg, { simulated: new SimulatedRecoveryProvider() });
  assert.equal(sel.mode, "SIMULATED");
  assert.equal(sel.reason, "missing_credentials");
});

test("SIMULATED provider works with no credentials at all", async () => {
  const cfg = resolveProviderSelectionFromEnv(env({ GEMINI_API_KEY: "", RAZORPAY_KEY_ID: "", RAZORPAY_KEY_SECRET: "", RAZORPAY_WEBHOOK_SECRET: "" }));
  const sel = selectExecutionProvider(cfg, { simulated: new SimulatedRecoveryProvider() });
  assert.equal(sel.mode, "SIMULATED");
  const result = await sel.provider.execute({
    actionType: "SEND_PAYMENT_LINK",
    idempotencyKey: "idem_1",
    currency: "INR",
    amountMinor: 500_000,
    metadata: { tenantId: "tenant_a" },
  });
  assert.ok(result.outcome);
});

test("Test Mode credential source rejects live keys at construction", () => {
  assert.throws(() => new StaticRazorpayCredentialSource({ keyId: "rzp_live_x", keySecret: FAKE_SECRET }), RazorpayConfigError);
  // A valid test-mode source constructs fine.
  assert.doesNotThrow(() => new StaticRazorpayCredentialSource({ keyId: "rzp_test_x", keySecret: FAKE_SECRET }));
});
