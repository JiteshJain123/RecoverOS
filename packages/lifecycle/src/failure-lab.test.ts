/**
 * Failure Lab proofs. These run the REAL connected lifecycle through the
 * controlled failure harness and assert the safety guarantees the product is
 * built on: RecoverOS never credits revenue it cannot prove, and every unsafe
 * path makes zero provider calls. No real credentials, network, or money.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listFailureScenarios, runFailureScenario, runSafetyReport, type FailureLabRun } from "./failure-lab";

const TENANT = "seed_tenant_1";
const run = (id: string): Promise<FailureLabRun> => runFailureScenario(id, { tenantId: TENANT });

describe("failure lab — catalogue", () => {
  it("exposes all 17 scenarios", () => {
    assert.equal(listFailureScenarios().length, 17);
  });

  it("every applicable invariant holds for every scenario", async () => {
    for (const s of listFailureScenarios()) {
      const r = await run(s.id);
      for (const inv of r.invariants) {
        if (inv.applicable) {
          assert.ok(inv.holds, `${s.id}: invariant ${inv.id} did not hold (${inv.detail})`);
        }
      }
    }
  });

  it("credited flag always matches the accounting ledger (no fake success)", async () => {
    for (const s of listFailureScenarios()) {
      const r = await run(s.id);
      assert.equal(r.safety.credited, r.stats.revenueCreditedMinor > 0, `${s.id}: credited flag disagrees with ledger`);
      assert.equal(r.safety.credited, s.expectsRecovery, `${s.id}: unexpected recovery outcome`);
    }
  });
});

describe("failure lab — provider failures do not credit revenue", () => {
  it("timeout does not credit revenue", async () => {
    const r = await run("provider_timeout");
    assert.equal(r.stats.revenueCreditedMinor, 0);
    assert.equal(r.safety.credited, false);
  });

  it("provider 500 does not credit revenue", async () => {
    const r = await run("provider_500");
    assert.equal(r.stats.revenueCreditedMinor, 0);
    assert.equal(r.safety.credited, false);
  });

  it("capability error does not credit revenue", async () => {
    const r = await run("capability_error");
    assert.equal(r.stats.revenueCreditedMinor, 0);
  });
});

describe("failure lab — idempotency & webhook safety", () => {
  it("duplicate execution causes no duplicate provider call", async () => {
    const r = await run("duplicate_execution");
    const dupPass = r.passes[1];
    assert.ok(dupPass, "expected a second (duplicate) pass");
    assert.equal(dupPass.duplicatePrevented, true);
    assert.equal(dupPass.providerCallsDelta, 0, "the duplicate pass must make no new provider call");
    // Revenue is still credited exactly once, from the first execution.
    assert.equal(r.stats.revenueCreditedMinor, 500_000);
  });

  it("duplicate webhook is idempotent (credited once, extra event ignored)", async () => {
    const r = await run("duplicate_webhook");
    assert.equal(r.stats.revenueCreditedMinor, 500_000);
    assert.ok(r.stats.duplicateEventsIgnored >= 1, "a duplicate webhook event must be recorded as ignored");
  });

  it("out-of-order webhook does not regress state (credited once)", async () => {
    const r = await run("out_of_order_webhook");
    assert.equal(r.stats.revenueCreditedMinor, 500_000);
    assert.equal(r.trace.finalOutcome, "RECOVERED");
  });

  it("delayed webhook does not falsely credit revenue before it arrives", async () => {
    const r = await run("delayed_webhook");
    // Pass 1: the link exists but no webhook yet → nothing credited.
    assert.equal(r.passes[0]?.recoveredRevenueMinor, 0, "link creation alone must not credit revenue");
    // Pass 2: the delayed verified capture arrives → credited.
    assert.equal(r.passes[1]?.recoveredRevenueMinor, 500_000);
    assert.equal(r.stats.revenueCreditedMinor, 500_000);
  });
});

describe("failure lab — zero provider calls on unsafe paths", () => {
  it("BLOCK causes zero provider calls", async () => {
    const r = await run("blocked_policy");
    assert.equal(r.trace.policyDecision.decision, "BLOCK");
    assert.equal(r.stats.providerCalls, 0);
    assert.equal(r.stats.revenueCreditedMinor, 0);
  });

  it("REVIEW without approval causes zero provider calls", async () => {
    const r = await run("review_without_approval");
    assert.equal(r.trace.finalOutcome, "REVIEW_PENDING");
    assert.equal(r.stats.providerCalls, 0);
  });

  it("expired action causes zero provider calls", async () => {
    const r = await run("expired_action");
    assert.equal(r.trace.stopReason, "expired");
    assert.equal(r.stats.providerCalls, 0);
  });

  it("stale approval causes zero provider calls", async () => {
    const r = await run("stale_approval");
    assert.equal(r.trace.stopReason, "stale_approval");
    assert.equal(r.stats.providerCalls, 0);
  });

  it("policy change forces re-evaluation and blocks execution", async () => {
    const r = await run("policy_version_changed");
    assert.equal(r.trace.stopReason, "policy_changed");
    assert.equal(r.stats.providerCalls, 0);
    assert.equal(r.stats.revenueCreditedMinor, 0);
  });

  it("malformed AI output cannot execute", async () => {
    const r = await run("malformed_ai_output");
    assert.equal(r.trace.stopReason, "invalid_plan");
    assert.equal(r.stats.providerCalls, 0);
    assert.equal(r.stats.revenueCreditedMinor, 0);
  });

  it("already-recovered payment is blocked with zero provider calls", async () => {
    const r = await run("payment_already_recovered");
    assert.equal(r.trace.policyDecision.decision, "BLOCK");
    assert.equal(r.stats.providerCalls, 0);
  });
});

describe("failure lab — recovery accounting truth", () => {
  it("payment-link creation does not count as recovery", async () => {
    const r = await run("failed_payment");
    assert.equal(r.trace.finalOutcome, "LINK_CREATED");
    assert.equal(r.stats.revenueCreditedMinor, 0);
    assert.ok(r.stats.invalidSuccessClaimsPrevented >= 1, "a created link with no capture is an invalid success claim prevented");
  });

  it("only a verified payment outcome credits revenue", async () => {
    const ok = await run("successful_recovery");
    assert.equal(ok.trace.finalOutcome, "RECOVERED");
    assert.equal(ok.stats.revenueCreditedMinor, 500_000);

    // Every non-recovery scenario credits exactly zero.
    for (const s of listFailureScenarios().filter((x) => !x.expectsRecovery)) {
      const r = await run(s.id);
      assert.equal(r.stats.revenueCreditedMinor, 0, `${s.id} must not credit revenue`);
    }
  });
});

describe("failure lab — safety report (Evaluations page)", () => {
  it("every safety guarantee holds, each backed by a real scenario run", async () => {
    const rep = await runSafetyReport({ tenantId: TENANT });
    assert.equal(rep.allHold, true);
    assert.ok(rep.evidence.length >= 9, "expected at least 9 guarantees");
    for (const e of rep.evidence) {
      assert.equal(e.holds, true, `${e.id} did not hold (${e.evidence})`);
      assert.ok(e.scenarioId.length > 0, `${e.id} is not backed by a scenario`);
      assert.ok(e.evidence.length > 0, `${e.id} has no measured evidence`);
    }
  });

  it("covers the required judge-facing guarantees", async () => {
    const rep = await runSafetyReport({ tenantId: TENANT });
    const ids = new Set(rep.evidence.map((e) => e.id));
    for (const req of [
      "block_zero_calls",
      "review_zero_calls",
      "expired_zero_calls",
      "duplicate_execution_no_extra_call",
      "duplicate_webhook_ignored",
      "out_of_order_no_regress",
      "unverified_zero_revenue",
      "link_not_recovery",
      "gemini_cannot_execute",
    ]) {
      assert.ok(ids.has(req), `missing guarantee: ${req}`);
    }
  });

  it("never leaks a secret in the safety report payload", async () => {
    const rep = await runSafetyReport({ tenantId: TENANT });
    const dump = JSON.stringify(rep);
    assert.ok(!dump.includes("whsec_"));
    assert.ok(!dump.toLowerCase().includes("keysecret"));
  });
});

describe("failure lab — secret safety", () => {
  it("never leaks the webhook or Razorpay test secret into the run payload", async () => {
    for (const s of listFailureScenarios()) {
      const r = await run(s.id);
      const dump = JSON.stringify(r);
      assert.ok(!dump.includes("whsec_failure_lab_secret"), `${s.id} leaked the webhook secret`);
      assert.ok(!dump.includes("failure_lab_test_secret"), `${s.id} leaked the Razorpay test secret`);
    }
  });

  it("provider requests expose only method + path (no bodies, no secrets)", async () => {
    const r = await run("successful_recovery");
    for (const req of r.providerRequests) {
      assert.ok(["GET", "POST"].includes(req.method), req.method);
      assert.ok(req.path.startsWith("/v1/") || req.path.startsWith("/"), req.path);
      assert.equal(Object.keys(req).length, 2, "only method + path are exposed");
    }
  });
});
