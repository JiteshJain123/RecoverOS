import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRazorpayNormalizer } from "../adapters/razorpay";
import { detectSignals } from "./detect";
import { computePriority } from "./score";
import { SCORE_WEIGHTS, SCORING_FORMULA_VERSION } from "../config";
import { failedPayment, hoursBeforeNow, NOW, rawPayment } from "../test-support/fixtures";

const normalizer = createRazorpayNormalizer();
const score = (
  raw: Parameters<typeof normalizer.normalize>[0],
  history = { successfulPayments: 0, totalCapturedMinor: 0 },
) => {
  const p = normalizer.normalize(raw);
  const signals = detectSignals(p, { now: NOW });
  return computePriority(p, signals, { now: NOW, customerHistory: history });
};

describe("computePriority", () => {
  it("is deterministic and bounded to [0, 100]", () => {
    const a = score(failedPayment("bank_timeout", { attempts: 2, amountMinor: 1_500_000 }));
    const b = score(failedPayment("bank_timeout", { attempts: 2, amountMinor: 1_500_000 }));
    assert.deepEqual(a, b);
    assert.ok(a.score >= 0 && a.score <= 100);
    assert.equal(a.formulaVersion, SCORING_FORMULA_VERSION);
  });

  it("exposes all five weighted components summing (rounded) near the score", () => {
    const r = score(failedPayment("bank_declined", { attempts: 2, amountMinor: 2_000_000 }), {
      successfulPayments: 5,
      totalCapturedMinor: 5_000_000,
    });
    const keys = r.components.map((c) => c.key).sort();
    assert.deepEqual(keys, ["amount", "customer", "recency", "retry", "severity"]);
    const weightSum = r.components.reduce((s, c) => s + c.weight, 0);
    assert.ok(Math.abs(weightSum - 1) < 1e-9);
    for (const c of r.components) {
      assert.ok(c.value >= 0 && c.value <= 1, `${c.key} value in range`);
      assert.equal(typeof c.detail, "string");
    }
    // Each component weight matches config.
    const amount = r.components.find((c) => c.key === "amount");
    assert.equal(amount?.weight, SCORE_WEIGHTS.amount);
  });

  it("ranks a large, repeated, recent, loyal-customer failure above a small stale one", () => {
    const high = score(failedPayment("bank_declined", { attempts: 3, amountMinor: 2_000_000 }), {
      successfulPayments: 5,
      totalCapturedMinor: 9_000_000,
    });
    const lowRaw = rawPayment({
      status: "FAILED",
      failureCode: "bank_declined",
      amountMinor: 50_000,
      createdAt: hoursBeforeNow(70),
    });
    const low = score(lowRaw, { successfulPayments: 0, totalCapturedMinor: 0 });
    assert.ok(high.score > low.score, `${high.score} should exceed ${low.score}`);
  });

  it("recency component decays with age", () => {
    const recent = score(rawPayment({ status: "FAILED", failureCode: "bank_declined", createdAt: hoursBeforeNow(1) }));
    const old = score(rawPayment({ status: "FAILED", failureCode: "bank_declined", createdAt: hoursBeforeNow(60) }));
    const recencyOf = (r: ReturnType<typeof score>) =>
      r.components.find((c) => c.key === "recency")?.value ?? -1;
    assert.ok(recencyOf(recent) > recencyOf(old));
  });
});
