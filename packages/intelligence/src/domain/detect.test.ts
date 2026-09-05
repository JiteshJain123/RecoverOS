import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRazorpayNormalizer } from "../adapters/razorpay";
import { detectSignals, primarySignal } from "./detect";
import type { SignalType } from "./types";
import { DETECTION_RULES_VERSION } from "../config";
import { event, failedPayment, hoursBeforeNow, NOW, rawPayment } from "../test-support/fixtures";

const normalizer = createRazorpayNormalizer();
const detect = (raw: Parameters<typeof normalizer.normalize>[0]) =>
  detectSignals(normalizer.normalize(raw), { now: NOW });
const types = (raw: Parameters<typeof normalizer.normalize>[0]): SignalType[] =>
  detect(raw).map((s) => s.type);

describe("detectSignals", () => {
  it("raises FAILED_PAYMENT for a single failed payment", () => {
    const signals = detect(failedPayment("bank_declined", { attempts: 1 }));
    const failed = signals.find((s) => s.type === "FAILED_PAYMENT");
    assert.ok(failed, "expected a FAILED_PAYMENT signal");
    assert.equal(failed.estimatedRevenueAtRiskMinor, 500_000);
    assert.equal(failed.currency, "INR");
    assert.equal(failed.tenantId, "tenant_a");
    assert.equal(failed.ruleVersion, DETECTION_RULES_VERSION);
    assert.equal(failed.detectedAt, NOW.toISOString());
    assert.equal(typeof failed.confidence, "number");
    assert.equal(failed.rootCause, "BANK_DECLINE");
  });

  it("raises REPEATED_FAILURE only at/above the attempts threshold", () => {
    assert.ok(!types(failedPayment("bank_timeout", { attempts: 1 })).includes("REPEATED_FAILURE"));
    const repeated = types(failedPayment("bank_timeout", { attempts: 2 }));
    assert.ok(repeated.includes("REPEATED_FAILURE"));
    assert.ok(repeated.includes("BANK_TIMEOUT"));
    assert.ok(repeated.includes("FAILED_PAYMENT"));
  });

  it("raises BANK_TIMEOUT with transient/high-confidence evidence", () => {
    const s = detect(failedPayment("bank_timeout")).find((x) => x.type === "BANK_TIMEOUT");
    assert.ok(s);
    assert.equal(s.rootCause, "TIMEOUT");
    assert.equal(s.evidence.transient, true);
    assert.ok(s.confidence >= 0.9);
  });

  it("raises CHECKOUT_ABANDONMENT for a pending abandoned checkout", () => {
    const p = rawPayment({
      status: "CREATED",
      failureCode: "checkout_abandoned",
      events: [
        event("PAYMENT_CREATED", "payment.created", hoursBeforeNow(2)),
        event("PAYMENT_LINK_CREATED", "payment_link.created", hoursBeforeNow(2)),
      ],
    });
    assert.ok(types(p).includes("CHECKOUT_ABANDONMENT"));
  });

  it("raises EXPIRED_PAYMENT_LINK when a link expired", () => {
    const p = rawPayment({
      status: "CREATED",
      failureCode: "expired_payment_link",
      events: [
        event("PAYMENT_CREATED", "payment.created", hoursBeforeNow(5)),
        event("PAYMENT_LINK_EXPIRED", "payment_link.expired", hoursBeforeNow(1)),
      ],
    });
    const t = types(p);
    assert.ok(t.includes("EXPIRED_PAYMENT_LINK"));
    assert.ok(!t.includes("CHECKOUT_ABANDONMENT"), "expired should not also be abandonment");
  });

  it("raises PENDING_TIMEOUT only after the age threshold", () => {
    const fresh = rawPayment({ status: "CREATED", failureCode: null, createdAt: hoursBeforeNow(2) });
    assert.ok(!types(fresh).includes("PENDING_TIMEOUT"));
    const stale = rawPayment({ status: "CREATED", failureCode: null, createdAt: hoursBeforeNow(48) });
    assert.ok(types(stale).includes("PENDING_TIMEOUT"));
  });

  it("produces NO signals for a captured (successful) payment", () => {
    const captured = rawPayment({
      status: "CAPTURED",
      failureCode: null,
      capturedAt: hoursBeforeNow(1),
      events: [
        event("PAYMENT_CREATED", "payment.created", hoursBeforeNow(2)),
        event("PAYMENT_CAPTURED", "payment.captured", hoursBeforeNow(1)),
      ],
    });
    assert.equal(detect(captured).length, 0);
  });

  it("escalates severity with amount at risk", () => {
    const small = detect(failedPayment("bank_declined", { amountMinor: 100_000 }))[0];
    const large = detect(failedPayment("bank_declined", { amountMinor: 2_500_000 }))[0];
    assert.ok(small && large);
    const rank = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 } as const;
    assert.ok(rank[large.severity] > rank[small.severity]);
  });

  it("primarySignal deterministically picks the highest-severity signal", () => {
    // Sub-threshold amount so severities differ: REPEATED_FAILURE (HIGH) is the
    // unique top vs FAILED_PAYMENT/BANK_TIMEOUT (MEDIUM).
    const signals = detect(failedPayment("bank_timeout", { attempts: 2, amountMinor: 200_000 }));
    const primary = primarySignal(signals);
    assert.ok(primary);
    assert.equal(primary.type, "REPEATED_FAILURE");
    // Deterministic across shuffles.
    const reshuffled = primarySignal([...signals].reverse());
    assert.equal(reshuffled?.type, primary.type);
  });
});
