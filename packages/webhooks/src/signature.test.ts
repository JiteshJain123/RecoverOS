import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeSignature, verifyRazorpaySignature } from "./signature";

const SECRET = "whsec_test_deterministic";
const BODY = '{"entity":"event","event":"payment.captured"}';

describe("razorpay signature", () => {
  it("computes a stable HMAC-SHA256 hex digest", () => {
    const a = computeSignature(BODY, SECRET);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, computeSignature(BODY, SECRET));
  });

  it("verifies a correct signature", () => {
    assert.ok(verifyRazorpaySignature(BODY, computeSignature(BODY, SECRET), SECRET));
  });

  it("rejects a wrong signature, a wrong secret, and a tampered body", () => {
    const sig = computeSignature(BODY, SECRET);
    assert.ok(!verifyRazorpaySignature(BODY, "deadbeef", SECRET));
    assert.ok(!verifyRazorpaySignature(BODY, sig, "other_secret"));
    assert.ok(!verifyRazorpaySignature(BODY + " ", sig, SECRET));
  });

  it("rejects a missing signature or secret without throwing", () => {
    assert.ok(!verifyRazorpaySignature(BODY, undefined, SECRET));
    assert.ok(!verifyRazorpaySignature(BODY, "x", ""));
  });
});
