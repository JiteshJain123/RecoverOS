import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SimulatedRecoveryProvider } from "./simulated-provider";
import type { RecoveryProviderRequest } from "./provider";

const provider = new SimulatedRecoveryProvider();

function req(over: Partial<RecoveryProviderRequest> = {}): RecoveryProviderRequest {
  return {
    actionType: over.actionType ?? "RETRY_PAYMENT",
    idempotencyKey: over.idempotencyKey ?? "rk_1",
    amountMinor: over.amountMinor ?? 500_000,
    currency: over.currency ?? "INR",
    metadata: over.metadata ?? {},
  };
}

describe("SimulatedRecoveryProvider", () => {
  it("is deterministic for identical requests", async () => {
    const a = await provider.execute(req({ metadata: { rootCause: "TIMEOUT" } }));
    const b = await provider.execute(req({ metadata: { rootCause: "TIMEOUT" } }));
    assert.deepEqual(a, b);
  });

  it("honors an explicit simScenario override", async () => {
    assert.equal((await provider.execute(req({ metadata: { simScenario: "retry_success" } }))).outcome, "SUCCEEDED");
    assert.equal((await provider.execute(req({ metadata: { simScenario: "retry_fail" } }))).outcome, "FAILED");
    assert.equal((await provider.execute(req({ metadata: { simScenario: "timeout" } }))).outcome, "TIMEOUT");
  });

  it("only reports recovered revenue on a SUCCEEDED outcome", async () => {
    const ok = await provider.execute(req({ metadata: { rootCause: "TIMEOUT" } })); // SUCCEEDED
    assert.equal(ok.outcome, "SUCCEEDED");
    assert.equal(ok.recoveredAmountMinor, 500_000);

    const bad = await provider.execute(req({ metadata: { rootCause: "BANK_DECLINE" } })); // FAILED
    assert.equal(bad.outcome, "FAILED");
    assert.equal(bad.recoveredAmountMinor, 0);
  });

  it("uses only simulated (sim_…) external references", async () => {
    const r = await provider.execute(req());
    assert.match(r.externalReference, /^sim_/);
  });
});
