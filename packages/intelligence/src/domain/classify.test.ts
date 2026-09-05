import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRazorpayNormalizer } from "../adapters/razorpay";
import { classifyRootCause } from "./classify";
import { CLASSIFIER_VERSION } from "../config";
import { event, failedPayment, hoursBeforeNow, rawPayment } from "../test-support/fixtures";

const normalizer = createRazorpayNormalizer();
const classify = (raw: Parameters<typeof normalizer.normalize>[0]) =>
  classifyRootCause(normalizer.normalize(raw));

describe("classifyRootCause", () => {
  it("classifies bank timeout as TIMEOUT (exact code)", () => {
    const r = classify(failedPayment("bank_timeout"));
    assert.equal(r.rootCause, "TIMEOUT");
    assert.equal(r.matchedBy, "code:bank_timeout");
    assert.equal(r.classifierVersion, CLASSIFIER_VERSION);
  });

  it("classifies insufficient_funds, bank_declined, gateway_error", () => {
    assert.equal(classify(failedPayment("insufficient_funds")).rootCause, "INSUFFICIENT_FUNDS");
    assert.equal(classify(failedPayment("bank_declined")).rootCause, "BANK_DECLINE");
    assert.equal(classify(failedPayment("gateway_error")).rootCause, "GATEWAY_ERROR");
  });

  it("classifies abandoned checkout and expired link", () => {
    const abandoned = rawPayment({ status: "CREATED", failureCode: "checkout_abandoned" });
    assert.equal(classify(abandoned).rootCause, "CUSTOMER_ABANDONMENT");

    const expired = rawPayment({ status: "CREATED", failureCode: "expired_payment_link" });
    assert.equal(classify(expired).rootCause, "EXPIRED_CHECKOUT");
  });

  it("falls back to keyword match when the code is non-canonical", () => {
    const r = classify(
      rawPayment({
        status: "FAILED",
        failureCode: "err_998",
        failureReason: "Issuer timeout while authorizing the charge",
      }),
    );
    assert.equal(r.rootCause, "TIMEOUT");
    assert.equal(r.matchedBy, "keyword:timeout");
  });

  it("detects expired link structurally from events", () => {
    const p = rawPayment({
      status: "CREATED",
      failureCode: null,
      events: [
        event("PAYMENT_CREATED", "payment.created", hoursBeforeNow(5)),
        event("PAYMENT_LINK_CREATED", "payment_link.created", hoursBeforeNow(4)),
        event("PAYMENT_LINK_EXPIRED", "payment_link.expired", hoursBeforeNow(1)),
      ],
    });
    const r = classify(p);
    assert.equal(r.rootCause, "EXPIRED_CHECKOUT");
    assert.equal(r.matchedBy, "event:PAYMENT_LINK_EXPIRED");
  });

  it("returns UNKNOWN for an unrecognized failure (fallback)", () => {
    const p = rawPayment({ status: "FAILED", failureCode: "err_42", failureReason: "mystery" });
    const r = classify(p);
    assert.equal(r.rootCause, "UNKNOWN");
    assert.equal(r.matchedBy, "fallback");
  });
});
