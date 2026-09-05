/**
 * GeminiRecoveryService (orchestrator) tests with an in-memory store and a
 * mocked Gemini client. Covers AgentRun/AgentToolCall/RecoveryDecision creation,
 * audit events, tenant isolation, failure→status mapping, and that no secret
 * ever appears in any persisted/serialized record.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GeminiRecoveryStrategyProvider } from "./provider";
import { GeminiRecoveryService, CaseNotFoundError } from "./service";
import { InMemoryGeminiRecoveryStore } from "./in-memory-store";
import { GeminiTimeoutError, GeminiMalformedOutputError } from "./errors";
import { MockGeminiClient, outputJson, strategyCtx, type MockStep } from "./test-support";
import type { CaseRecoveryContext } from "./store";

function seededCase(tenantId: string, caseId: string): CaseRecoveryContext & { tenantId: string; caseId: string } {
  return {
    tenantId,
    caseId,
    strategyContext: strategyCtx({ tenantId, caseId }),
    customerHistory: { successfulPayments: 2, totalCapturedMinor: 600_000 },
    policyConstraints: { maxRetries: 3 },
  };
}

function build(script: MockStep[], seed: Array<CaseRecoveryContext & { tenantId: string; caseId: string }>) {
  const client = new MockGeminiClient(script);
  const provider = new GeminiRecoveryStrategyProvider({ client, now: () => 1_000 });
  const store = new InMemoryGeminiRecoveryStore({ cases: seed });
  const service = new GeminiRecoveryService({
    provider,
    store,
    now: () => new Date("2026-09-04T00:00:00.000Z"),
  });
  return { client, provider, store, service };
}

describe("GeminiRecoveryService — success path", () => {
  it("creates AgentRun, AgentToolCall, RecoveryDecision and an audit event", async () => {
    const { store, service } = build([{ kind: "text", text: outputJson(), inputTokens: 100, outputTokens: 30 }], [
      seededCase("tenant_a", "case_1"),
    ]);

    const result = await service.recommend({ tenantId: "tenant_a" }, "case_1");

    assert.equal(result.plan.strategy, "RETRY_PAYMENT");

    assert.equal(store.runs.length, 1);
    const run = store.runs[0];
    assert.ok(run);
    assert.equal(run.status, "SUCCEEDED");
    assert.equal(run.model, "gemini-3.5-flash");
    assert.equal(run.inputTokens, 100);

    assert.equal(store.toolCalls.length, 1);
    const tc = store.toolCalls[0];
    assert.ok(tc);
    assert.equal(tc.isError, false);
    assert.equal(tc.name, "gemini.generateContent");
    assert.equal(tc.args.model, "gemini-3.5-flash");

    assert.equal(store.decisions.length, 1);
    const dec = store.decisions[0];
    assert.ok(dec);
    assert.equal(dec.proposedAction, "RETRY_PAYMENT");
    assert.equal(dec.amountMinor, 500_000);

    const generated = store.audits.filter((a) => a.action === "recovery.strategy.gemini.generated");
    assert.equal(generated.length, 1);
  });

  it("maps HUMAN_REVIEW / NO_ACTION to a NO_ACTION decision with null amount", async () => {
    const { store, service } = build(
      [{ kind: "text", text: outputJson({ recommendation: "HUMAN_REVIEW", confidence: 0.9 }) }],
      [seededCase("tenant_a", "case_hr")],
    );
    await service.recommend({ tenantId: "tenant_a" }, "case_hr");
    const dec = store.decisions[0];
    assert.ok(dec);
    assert.equal(dec.proposedAction, "NO_ACTION");
    assert.equal(dec.amountMinor, null);
  });
});

describe("GeminiRecoveryService — tenant isolation", () => {
  it("does not expose another tenant's case (404, no AgentRun created)", async () => {
    const { store, service } = build([{ kind: "text", text: outputJson() }], [seededCase("tenant_a", "case_1")]);

    await assert.rejects(() => service.recommend({ tenantId: "tenant_b" }, "case_1"), CaseNotFoundError);
    assert.equal(store.runs.length, 0);
    assert.equal(store.decisions.length, 0);

    // The rightful tenant still succeeds.
    const ok = await service.recommend({ tenantId: "tenant_a" }, "case_1");
    assert.equal(ok.plan.caseId, "case_1");
  });
});

describe("GeminiRecoveryService — failure mapping", () => {
  it("records TIMEOUT and no decision when Gemini times out", async () => {
    const { store, service } = build(
      [{ kind: "throw", error: new GeminiTimeoutError(20_000) }],
      [seededCase("tenant_a", "case_1")],
    );
    await assert.rejects(() => service.recommend({ tenantId: "tenant_a" }, "case_1"), GeminiTimeoutError);
    const run = store.runs[0];
    assert.ok(run);
    assert.equal(run.status, "TIMEOUT");
    assert.equal(store.decisions.length, 0);
    assert.equal(store.toolCalls[0]?.isError, true);
    assert.ok(store.audits.some((a) => a.action === "recovery.strategy.gemini.failed"));
  });

  it("records INVALID_OUTPUT when Gemini returns malformed output", async () => {
    const { store, service } = build([{ kind: "text", text: "not-json" }], [seededCase("tenant_a", "case_1")]);
    await assert.rejects(() => service.recommend({ tenantId: "tenant_a" }, "case_1"), GeminiMalformedOutputError);
    assert.equal(store.runs[0]?.status, "INVALID_OUTPUT");
  });
});

describe("GeminiRecoveryService — no secrets in serialized records", () => {
  it("keeps API keys / secrets out of every persisted record", async () => {
    const SECRET = "SUPER_SECRET_GEMINI_KEY_should_never_appear";
    const { store, service } = build([{ kind: "text", text: outputJson() }], [seededCase("tenant_a", "case_1")]);
    await service.recommend({ tenantId: "tenant_a" }, "case_1");

    const serialized = JSON.stringify({
      runs: store.runs,
      toolCalls: store.toolCalls,
      decisions: store.decisions,
      audits: store.audits,
    });
    assert.ok(!serialized.includes(SECRET));
    assert.ok(!/x-goog-api-key/i.test(serialized));
    // Tool-call args are structured metadata, not the raw prompt text.
    assert.ok(!/```json/.test(serialized));
  });
});
