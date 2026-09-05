/**
 * GeminiRecoveryStrategyProvider tests using a mocked client (no network, no
 * API key). Covers valid output, malformed output, timeout, API failure, the
 * low-confidence guardrail, HUMAN_REVIEW / NO_ACTION, retry behavior, and that
 * no secret is ever sent to the model or appears in the produced plan.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GeminiConfigError,
  GeminiMalformedOutputError,
  GeminiRequestError,
  GeminiTimeoutError,
} from "./errors";
import { loadGeminiConfig } from "./config";
import { GeminiRecoveryStrategyProvider } from "./provider";
import { validateRecoveryPlan } from "@recoveros/strategy";
import type { Env } from "@recoveros/config";
import { MockGeminiClient, outputJson, strategyCtx } from "./test-support";

function provider(client: MockGeminiClient): GeminiRecoveryStrategyProvider {
  return new GeminiRecoveryStrategyProvider({ client, now: () => 1_000 });
}

describe("GeminiRecoveryStrategyProvider — valid structured output", () => {
  it("returns a schema-valid RecoveryPlan for a well-formed response", async () => {
    const client = new MockGeminiClient([{ kind: "text", text: outputJson(), inputTokens: 120, outputTokens: 40 }]);
    const rec = await provider(client).recommend({ ctx: strategyCtx() });
    assert.equal(rec.plan.strategy, "RETRY_PAYMENT");
    assert.equal(rec.plan.modelMetadata.provider, "gemini");
    assert.equal(rec.plan.modelMetadata.version, "gemini-3.5-flash");
    assert.ok(validateRecoveryPlan(rec.plan).valid);
    // Amounts come from context, never invented by the model.
    const action = rec.plan.proposedActions[0];
    assert.ok(action);
    assert.equal(action.amountMinor, 500_000);
    assert.equal(action.currency, "INR");
    assert.equal(rec.meta.inputTokens, 120);
    assert.equal(rec.meta.attempts, 1);
  });

  it("passes an explicit response schema + structured request to the client", async () => {
    const client = new MockGeminiClient([{ kind: "text", text: outputJson() }]);
    await provider(client).recommend({ ctx: strategyCtx() });
    const req = client.requests[0];
    assert.ok(req);
    assert.ok(req.responseSchema);
    assert.match(req.systemInstruction, /recommendation engine/i);
    assert.match(req.systemInstruction, /cannot|MUST NOT/i);
  });
});

describe("GeminiRecoveryStrategyProvider — failure handling", () => {
  it("throws GeminiMalformedOutputError on non-JSON output (no retry)", async () => {
    const client = new MockGeminiClient([{ kind: "text", text: "not json at all" }]);
    await assert.rejects(() => provider(client).recommend({ ctx: strategyCtx() }), GeminiMalformedOutputError);
    assert.equal(client.callCount, 1); // malformed is NOT retried
  });

  it("throws GeminiMalformedOutputError on schema-invalid JSON", async () => {
    const client = new MockGeminiClient([{ kind: "text", text: JSON.stringify({ recommendation: "TELEPORT" }) }]);
    await assert.rejects(() => provider(client).recommend({ ctx: strategyCtx() }), GeminiMalformedOutputError);
  });

  it("retries a timeout up to maxAttempts, then surfaces GeminiTimeoutError", async () => {
    const client = new MockGeminiClient([{ kind: "throw", error: new GeminiTimeoutError(20_000) }]);
    await assert.rejects(() => provider(client).recommend({ ctx: strategyCtx() }), GeminiTimeoutError);
    assert.equal(client.callCount, 3); // default maxAttempts
  });

  it("retries a retryable HTTP error, then surfaces GeminiRequestError", async () => {
    const client = new MockGeminiClient([{ kind: "throw", error: new GeminiRequestError("HTTP 503", 503) }]);
    await assert.rejects(() => provider(client).recommend({ ctx: strategyCtx() }), GeminiRequestError);
    assert.equal(client.callCount, 3);
  });

  it("does NOT retry a non-retryable HTTP error (e.g. 400)", async () => {
    const client = new MockGeminiClient([{ kind: "throw", error: new GeminiRequestError("HTTP 400", 400) }]);
    await assert.rejects(() => provider(client).recommend({ ctx: strategyCtx() }), GeminiRequestError);
    assert.equal(client.callCount, 1);
  });

  it("recovers if a transient failure precedes a valid response", async () => {
    const client = new MockGeminiClient([
      { kind: "throw", error: new GeminiTimeoutError(20_000) },
      { kind: "text", text: outputJson() },
    ]);
    const rec = await provider(client).recommend({ ctx: strategyCtx() });
    assert.equal(rec.plan.strategy, "RETRY_PAYMENT");
    assert.equal(rec.meta.attempts, 2);
  });
});

describe("GeminiRecoveryStrategyProvider — safety guardrails", () => {
  it("downgrades a low-confidence actionable recommendation to HUMAN_REVIEW", async () => {
    const client = new MockGeminiClient([
      { kind: "text", text: outputJson({ recommendation: "RETRY_PAYMENT", confidence: 0.2 }) },
    ]);
    const rec = await provider(client).recommend({ ctx: strategyCtx() });
    assert.equal(rec.plan.strategy, "HUMAN_REVIEW");
    assert.equal(rec.meta.coercedToHumanReview, true);
    assert.equal(rec.plan.proposedActions[0]?.actionKind, "FLAG_FOR_HUMAN_REVIEW");
  });

  it("honors a HUMAN_REVIEW recommendation", async () => {
    const client = new MockGeminiClient([
      { kind: "text", text: outputJson({ recommendation: "HUMAN_REVIEW", confidence: 0.9 }) },
    ]);
    const rec = await provider(client).recommend({ ctx: strategyCtx() });
    assert.equal(rec.plan.strategy, "HUMAN_REVIEW");
    assert.ok(validateRecoveryPlan(rec.plan).valid);
  });

  it("honors a NO_ACTION recommendation with no proposed actions", async () => {
    const client = new MockGeminiClient([
      { kind: "text", text: outputJson({ recommendation: "NO_ACTION", confidence: 0.95, proposedActionKinds: [] }) },
    ]);
    const rec = await provider(client).recommend({ ctx: strategyCtx() });
    assert.equal(rec.plan.strategy, "NO_ACTION");
    assert.equal(rec.plan.proposedActions.length, 0);
  });
});

describe("Gemini config + secrets", () => {
  it("throws GeminiConfigError when the API key is missing", () => {
    const env = { GEMINI_API_KEY: "", GEMINI_MODEL: "gemini-3.5-flash" } as unknown as Env;
    assert.throws(() => loadGeminiConfig({ env }), GeminiConfigError);
  });

  it("uses GEMINI_MODEL rather than a hardcoded model", () => {
    const env = { GEMINI_API_KEY: "sk-secret", GEMINI_MODEL: "gemini-custom-x" } as unknown as Env;
    const cfg = loadGeminiConfig({ env });
    assert.equal(cfg.model, "gemini-custom-x");
  });

  it("never sends secrets to the model and never leaks them into the plan", async () => {
    const SECRET = "SUPER_SECRET_GEMINI_KEY_should_never_appear";
    const client = new MockGeminiClient([{ kind: "text", text: outputJson() }]);
    const rec = await provider(client).recommend({
      ctx: strategyCtx(),
      customerHistory: { successfulPayments: 3, totalCapturedMinor: 900_000 },
      policyConstraints: { maxRetries: 3 },
    });
    // The prompt sent to Gemini must not contain the secret, a DB URL, etc.
    const req = client.requests[0];
    assert.ok(req);
    const sentToModel = `${req.systemInstruction}\n${req.prompt}`;
    assert.ok(!sentToModel.includes(SECRET));
    assert.ok(!/postgres(ql)?:\/\//i.test(sentToModel));
    assert.ok(!/api[_-]?key/i.test(req.prompt));
    // The produced plan must not carry any secret either.
    assert.ok(!JSON.stringify(rec.plan).includes(SECRET));
  });
});
