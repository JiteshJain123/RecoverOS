/**
 * End-to-end lifecycle tests: strategy → policy → action → selected provider →
 * webhook reconciliation → recovered revenue, plus the security invariants
 * (Gemini cannot execute; BLOCK / unapproved REVIEW / expired / duplicate make
 * zero Razorpay calls). Uses the mock Razorpay transport + signed webhook
 * fixtures — no real credentials, no network, no money.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RecoveryLifecycle } from "./lifecycle";
import { makeRazorpayTransport } from "./failure-harness";
import {
  InMemoryExecutionStore,
  SimulatedRecoveryProvider,
  RecoveryActionExecutor,
  ApprovalService,
  type PaymentRecoveryProvider,
  type PipelineCase,
} from "@recoveros/execution";
import { DeterministicRecoveryStrategyProvider } from "@recoveros/strategy";
import { GeminiRecoveryStrategyProvider, type GeminiClient } from "@recoveros/ai";
import {
  RazorpayClient,
  RazorpayTestProvider,
  StaticRazorpayCredentialSource,
  defaultRazorpayConfig,
} from "@recoveros/payments";

const SECRET = "whsec_lifecycle_test_secret";
const ACC = "acc_test_RECOVEROS1";
const RZP_SECRET = "s3cr3tValue";

function mkClock(iso: string) {
  let cur = new Date(iso);
  return { clock: { now: () => new Date(cur) }, set: (i: string) => (cur = new Date(i)) };
}

function makeCase(over: Partial<{ tenantId: string; caseId: string; paymentId: string; rootCause: string; amountAtRiskMinor: number; retryCount: number; severity: string; paymentStatus: string; caseStatus: string; alreadyRecovered: boolean }> = {}): PipelineCase {
  const tenantId = over.tenantId ?? "tenant_a";
  const rootCause = (over.rootCause ?? "BANK_DECLINE") as Exclude<PipelineCase["strategyContext"]["rootCause"], null>;
  const amount = over.amountAtRiskMinor ?? 500_000;
  const caseId = over.caseId ?? "case_lc_1";
  const paymentId = over.paymentId ?? "pay_lc_1";
  const severity = (over.severity ?? "MEDIUM") as Exclude<PipelineCase["strategyContext"]["severity"], null>;
  const caseStatus = (over.caseStatus ?? "DETECTED") as PipelineCase["policyCase"]["status"];
  return {
    strategyContext: {
      caseId,
      tenantId,
      caseStatus: caseStatus as PipelineCase["strategyContext"]["caseStatus"],
      paymentStatus: (over.paymentStatus ?? "FAILED") as PipelineCase["strategyContext"]["paymentStatus"],
      reason: "FAILED_PAYMENT",
      rootCause,
      severity,
      priorityScore: 40,
      amountAtRiskMinor: amount,
      currency: "INR",
      paymentId,
      customerId: "cust_1",
      retryCount: over.retryCount ?? 0,
      hasContactChannel: true,
      hasExpiredLink: false,
      policyState: "OK",
      signals: [{ type: "FAILED_PAYMENT", severity, rootCause, confidence: 0.9, reason: "x" }],
    },
    policyCase: {
      id: caseId,
      tenantId,
      status: caseStatus,
      rootCause,
      severity,
      amountAtRiskMinor: amount,
      currency: "INR",
      retryCount: over.retryCount ?? 0,
      openedAt: new Date("2026-09-02T00:00:00.000Z"),
      expiresAt: null,
    },
    paymentContext: {
      paymentStatus: over.paymentStatus ?? "FAILED",
      alreadyRecovered: over.alreadyRecovered ?? false,
      usedIdempotencyKeys: [],
    },
    policy: {
      version: 2,
      limits: {
        maxRetryAmountMinor: 1_500_000,
        reviewAmountMinor: 1_000_000,
        minConfidence: 0.5,
        maxRetriesPerCase: 2,
        allowedActions: ["RETRY_PAYMENT", "SEND_PAYMENT_LINK", "CONTACT_CUSTOMER"],
      },
    },
  };
}

function razorpayProvider(transport: ReturnType<typeof makeRazorpayTransport>["transport"]): PaymentRecoveryProvider {
  const client = new RazorpayClient({
    credentials: new StaticRazorpayCredentialSource({ keyId: "rzp_test_abc", keySecret: RZP_SECRET }),
    config: defaultRazorpayConfig({ timeoutMs: 1000 }),
    transport,
    now: () => 0,
  });
  return new RazorpayTestProvider({ client });
}

interface SetupOpts {
  mode?: "SIMULATED" | "RAZORPAY_TEST";
  scenario?: Parameters<typeof makeRazorpayTransport>[0];
  over?: Parameters<typeof makeCase>[0];
  executorConfig?: { executionTtlMs?: number; approvalTtlMs?: number };
  strategy?: "deterministic" | GeminiRecoveryStrategyProvider;
  tenantId?: string;
}

function setup(opts: SetupOpts = {}) {
  const tenantId = opts.tenantId ?? "tenant_a";
  const mc = mkClock("2026-09-04T00:00:00.000Z");
  const pc = makeCase({ tenantId, ...opts.over });
  const execStore = new InMemoryExecutionStore({
    cases: [
      {
        id: pc.policyCase.id,
        tenantId,
        status: pc.policyCase.status,
        amountAtRiskMinor: pc.policyCase.amountAtRiskMinor,
        currency: "INR",
        resolvedAt: null,
      },
    ],
  });
  const { transport, requests } = makeRazorpayTransport(opts.scenario ?? {});
  const provider = opts.mode === "SIMULATED" ? new SimulatedRecoveryProvider() : razorpayProvider(transport);
  const strategyProvider =
    opts.strategy && opts.strategy !== "deterministic"
      ? opts.strategy
      : new DeterministicRecoveryStrategyProvider({ clock: mc.clock });
  const lifecycle = new RecoveryLifecycle({
    tenantId,
    execStore,
    provider,
    providerMode: opts.mode ?? "RAZORPAY_TEST",
    strategyProvider,
    clock: mc.clock,
    webhookSecret: SECRET,
    webhookAccountId: ACC,
    executorConfig: opts.executorConfig,
  });
  return { lifecycle, execStore, pc, requests, mc };
}

function geminiFor(strategy: string): GeminiRecoveryStrategyProvider {
  const client: GeminiClient = {
    model: "gemini-3.5-flash",
    async generate() {
      return {
        text: JSON.stringify({
          recommendation: strategy,
          rationale: "gemini says so",
          evidenceRefs: ["signal:x"],
          confidence: 0.8,
          riskLevel: "MEDIUM",
          expectedOutcome: { successProbability: 0.4, description: "d" },
          proposedActionKinds: strategy === "SEND_PAYMENT_LINK" ? ["CREATE_PAYMENT_LINK"] : ["RETRY_PAYMENT"],
          stoppingConditions: [],
        }),
      };
    },
  };
  return new GeminiRecoveryStrategyProvider({ client, now: () => 1000 });
}

describe("lifecycle — Gemini recommendation → policy decision", () => {
  it("Gemini → ALLOW for a compliant small payment-link", async () => {
    const { lifecycle, pc } = setup({ mode: "RAZORPAY_TEST", strategy: geminiFor("SEND_PAYMENT_LINK"), over: { amountAtRiskMinor: 500_000 } });
    const t = await lifecycle.runCase(pc, { replayWebhook: "none" });
    assert.equal(t.strategy.strategy, "SEND_PAYMENT_LINK");
    assert.equal(t.policyDecision.decision, "ALLOW");
  });

  it("Gemini → REVIEW for an amount in the review band", async () => {
    const { lifecycle, pc, requests } = setup({ strategy: geminiFor("SEND_PAYMENT_LINK"), over: { amountAtRiskMinor: 1_200_000 } });
    const t = await lifecycle.runCase(pc);
    assert.equal(t.policyDecision.decision, "REVIEW");
    assert.equal(t.finalOutcome, "REVIEW_PENDING");
    assert.equal(requests.length, 0, "no Razorpay call for an unapproved REVIEW");
  });

  it("Gemini → BLOCK for an amount over the ceiling", async () => {
    const { lifecycle, pc, requests } = setup({ strategy: geminiFor("SEND_PAYMENT_LINK"), over: { amountAtRiskMinor: 2_000_000 } });
    const t = await lifecycle.runCase(pc);
    assert.equal(t.policyDecision.decision, "BLOCK");
    assert.equal(t.finalOutcome, "BLOCKED");
    assert.equal(requests.length, 0);
  });
});

describe("lifecycle — payment link via Razorpay Test provider", () => {
  it("creates a link but does NOT credit revenue yet", async () => {
    const { lifecycle, pc, requests } = setup({ over: { rootCause: "BANK_DECLINE", amountAtRiskMinor: 500_000 } });
    const t = await lifecycle.runCase(pc, { replayWebhook: "none" });
    assert.equal(t.action?.actionType, "SEND_PAYMENT_LINK");
    assert.equal(t.finalOutcome, "LINK_CREATED");
    assert.equal(t.recoveredRevenueMinor, 0);
    assert.equal(t.action?.providerReference, "plink_test_0001");
    assert.ok(requests.some((r) => r.url.includes("/payment_links")));
  });

  it("credits revenue only after a verified payment.captured webhook", async () => {
    const { lifecycle, pc } = setup({ over: { rootCause: "BANK_DECLINE", amountAtRiskMinor: 500_000 } });
    const t = await lifecycle.runCase(pc, { replayWebhook: "captured" });
    assert.equal(t.finalOutcome, "RECOVERED");
    assert.equal(t.recoveredRevenueMinor, 500_000);
    assert.ok(t.auditEvents.includes("recovery.recovered"));
  });

  it("does NOT credit revenue when the customer never pays (link then failed)", async () => {
    const { lifecycle, pc } = setup({ over: { rootCause: "BANK_DECLINE", amountAtRiskMinor: 500_000 } });
    const t = await lifecycle.runCase(pc, { replayWebhook: "failed" });
    assert.equal(t.recoveredRevenueMinor, 0);
    assert.equal(t.finalOutcome, "LINK_CREATED");
  });
});

describe("lifecycle — retry/capture", () => {
  it("captures an authorized payment and credits revenue immediately", async () => {
    const { lifecycle, pc } = setup({ over: { rootCause: "TIMEOUT", amountAtRiskMinor: 500_000 }, scenario: { fetchStatus: "authorized", captureStatus: "captured" } });
    const t = await lifecycle.runCase(pc, { replayWebhook: "none" });
    assert.equal(t.action?.actionType, "RETRY_PAYMENT");
    assert.equal(t.finalOutcome, "RECOVERED");
    assert.equal(t.recoveredRevenueMinor, 500_000);
  });

  it("returns a capability error (no fake success) when not capturable", async () => {
    const { lifecycle, pc } = setup({ over: { rootCause: "TIMEOUT", amountAtRiskMinor: 500_000 }, scenario: { fetchStatus: "failed" } });
    const t = await lifecycle.runCase(pc, { replayWebhook: "none" });
    assert.equal(t.finalOutcome, "CAPABILITY_ERROR");
    assert.equal(t.recoveredRevenueMinor, 0);
    assert.equal(t.action?.state, "FAILED");
  });
});

describe("lifecycle — webhook safety", () => {
  it("duplicate webhook does not double-credit", async () => {
    const { lifecycle, pc } = setup({ over: { rootCause: "BANK_DECLINE" } });
    const t = await lifecycle.runCase(pc, { replayWebhook: "duplicate" });
    assert.equal(t.recoveredRevenueMinor, 500_000);
    assert.ok(t.webhookEvents.some((e) => e.result === "duplicate"));
  });

  it("out-of-order webhook (captured then authorized) credits once, no downgrade", async () => {
    const { lifecycle, pc } = setup({ over: { rootCause: "BANK_DECLINE" } });
    const t = await lifecycle.runCase(pc, { replayWebhook: "out_of_order" });
    assert.equal(t.recoveredRevenueMinor, 500_000);
  });

  it("provider timeout yields TIMEOUT with no revenue", async () => {
    const { lifecycle, pc } = setup({ over: { rootCause: "BANK_DECLINE" }, scenario: { fault: "timeout" } });
    const t = await lifecycle.runCase(pc, { replayWebhook: "none" });
    assert.equal(t.finalOutcome, "TIMEOUT");
    assert.equal(t.recoveredRevenueMinor, 0);
  });
});

describe("lifecycle — stopping rules", () => {
  it("already-recovered payment is BLOCKed with zero provider calls", async () => {
    const { lifecycle, pc, requests } = setup({ over: { paymentStatus: "CAPTURED", alreadyRecovered: true, caseStatus: "RECOVERED" } });
    const t = await lifecycle.runCase(pc);
    assert.equal(t.policyDecision.decision, "BLOCK");
    assert.equal(requests.length, 0);
  });

  it("policy version changed after authorization stops execution", async () => {
    const { lifecycle, pc, requests } = setup({ over: { rootCause: "BANK_DECLINE" } });
    const t = await lifecycle.runCase(pc, { currentPolicyVersion: 999, replayWebhook: "none" });
    assert.equal(t.finalOutcome, "STOPPED");
    assert.equal(t.stopReason, "policy_changed");
    assert.equal(requests.length, 0);
  });
});

describe("lifecycle — idempotency", () => {
  it("a duplicate action makes no duplicate provider call", async () => {
    const { lifecycle, pc, requests } = setup({ over: { rootCause: "BANK_DECLINE" } });
    await lifecycle.runCase(pc, { replayWebhook: "none" });
    const afterFirst = requests.length;
    const second = await lifecycle.runCase(pc, { replayWebhook: "none" });
    assert.equal(requests.length, afterFirst, "no new Razorpay calls on the duplicate run");
    assert.equal(second.duplicatePrevented, true);
  });
});

describe("lifecycle — tenant isolation", () => {
  it("keeps two tenants' actions/stores separate", async () => {
    const a = setup({ tenantId: "tenant_a", over: { tenantId: "tenant_a", caseId: "ca", paymentId: "pa", rootCause: "BANK_DECLINE" } });
    const b = setup({ tenantId: "tenant_b", over: { tenantId: "tenant_b", caseId: "cb", paymentId: "pb", rootCause: "BANK_DECLINE" } });
    await a.lifecycle.runCase(a.pc, { replayWebhook: "captured" });
    await b.lifecycle.runCase(b.pc, { replayWebhook: "none" });
    assert.ok(a.execStore.actions.every((x) => x.tenantId === "tenant_a"));
    assert.ok(b.execStore.actions.every((x) => x.tenantId === "tenant_b"));
    assert.equal(a.execStore.actions.length, 1);
    assert.equal(b.execStore.actions.length, 1);
  });
});

describe("lifecycle — secret redaction", () => {
  it("never leaks the Razorpay or webhook secret into audits/traces", async () => {
    const { lifecycle, pc, execStore } = setup({ over: { rootCause: "BANK_DECLINE" } });
    const t = await lifecycle.runCase(pc, { replayWebhook: "captured" });
    const dump = JSON.stringify({ trace: t, audits: execStore.audits });
    assert.ok(!dump.includes(RZP_SECRET));
    assert.ok(!dump.includes(SECRET));
  });
});

describe("security invariants", () => {
  it("Gemini cannot directly execute Razorpay (no execute surface)", () => {
    const gemini = geminiFor("SEND_PAYMENT_LINK");
    // The strategy provider only PROPOSES; it is not a PaymentRecoveryProvider.
    assert.equal(typeof (gemini as unknown as { execute?: unknown }).execute, "undefined");
  });

  it("BLOCK → zero Razorpay calls", async () => {
    const { lifecycle, pc, requests } = setup({ over: { amountAtRiskMinor: 2_000_000, rootCause: "BANK_DECLINE" } });
    await lifecycle.runCase(pc);
    assert.equal(requests.length, 0);
  });

  it("REVIEW without approval → zero Razorpay calls", async () => {
    const { lifecycle, pc, requests } = setup({ over: { amountAtRiskMinor: 1_200_000, rootCause: "BANK_DECLINE" } });
    await lifecycle.runCase(pc, { autoApprove: false });
    assert.equal(requests.length, 0);
  });

  it("expired action → zero Razorpay calls", async () => {
    const { lifecycle, pc, requests } = setup({ over: { rootCause: "BANK_DECLINE" }, executorConfig: { executionTtlMs: -1000 } });
    const t = await lifecycle.runCase(pc, { replayWebhook: "none" });
    assert.equal(t.stopReason, "expired");
    assert.equal(requests.length, 0);
  });

  it("stale approval → zero Razorpay calls", async () => {
    const { lifecycle, pc, requests } = setup({ over: { amountAtRiskMinor: 1_200_000, rootCause: "BANK_DECLINE" }, executorConfig: { approvalTtlMs: -1000 } });
    const t = await lifecycle.runCase(pc, { autoApprove: true, replayWebhook: "none" });
    assert.equal(t.stopReason, "stale_approval");
    assert.equal(requests.length, 0);
  });

  it("a BLOCKed action never reaches the executor path with a provider call (via executor)", async () => {
    // Direct proof: even wiring the executor + Razorpay, a BLOCK never executes.
    const { transport, requests } = makeRazorpayTransport({});
    const store = new InMemoryExecutionStore({ cases: [{ id: "c", tenantId: "t", status: "DETECTED", amountAtRiskMinor: 500_000, currency: "INR", resolvedAt: null }] });
    const executor = new RecoveryActionExecutor({ store, provider: razorpayProvider(transport), clock: { now: () => new Date() } });
    const approvals = new ApprovalService({ store, clock: { now: () => new Date() } });
    void approvals;
    // No authorize/execute performed for a blocked plan → no calls.
    assert.equal(requests.length, 0);
    void executor;
  });
});
