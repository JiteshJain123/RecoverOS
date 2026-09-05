import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectExecutionProvider } from "./provider-mode";
import { SimulatedRecoveryProvider } from "@recoveros/execution";
import type { PaymentRecoveryProvider } from "@recoveros/execution";

const simulated = new SimulatedRecoveryProvider();
const razorpay: PaymentRecoveryProvider = {
  name: "razorpay-test",
  async execute() {
    return { outcome: "FAILED", externalReference: "", recoveredAmountMinor: 0, detail: "x" };
  },
};

describe("selectExecutionProvider (server-side only)", () => {
  it("defaults to SIMULATED", () => {
    const s = selectExecutionProvider(
      { mode: "SIMULATED", razorpayTestEnabled: true, hasRazorpayCredentials: true },
      { simulated, razorpay },
    );
    assert.equal(s.mode, "SIMULATED");
    assert.equal(s.provider, simulated);
  });

  it("uses RAZORPAY_TEST only when enabled + credentials + adapter present", () => {
    const s = selectExecutionProvider(
      { mode: "RAZORPAY_TEST", razorpayTestEnabled: true, hasRazorpayCredentials: true },
      { simulated, razorpay },
    );
    assert.equal(s.mode, "RAZORPAY_TEST");
    assert.equal(s.provider, razorpay);
  });

  it("falls back to SIMULATED when not enabled / no credentials / no adapter", () => {
    assert.equal(
      selectExecutionProvider({ mode: "RAZORPAY_TEST", razorpayTestEnabled: false, hasRazorpayCredentials: true }, { simulated, razorpay }).mode,
      "SIMULATED",
    );
    assert.equal(
      selectExecutionProvider({ mode: "RAZORPAY_TEST", razorpayTestEnabled: true, hasRazorpayCredentials: false }, { simulated, razorpay }).mode,
      "SIMULATED",
    );
    assert.equal(
      selectExecutionProvider({ mode: "RAZORPAY_TEST", razorpayTestEnabled: true, hasRazorpayCredentials: true }, { simulated }).mode,
      "SIMULATED",
    );
  });
});
