/**
 * RazorpayTestProvider + client tests using a MOCKED HTTP transport (no real
 * credentials, no network). Covers success, auth failure, timeout, rate limit,
 * malformed response, 4xx, 5xx, secret redaction, and tenant isolation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RazorpayClient } from "./client";
import { RazorpayTestProvider } from "./razorpay-provider";
import {
  StaticRazorpayCredentialSource,
  defaultRazorpayConfig,
  type PaymentsTenantContext,
  type RazorpayCredentialSource,
  type RazorpayCredentials,
} from "./config";
import {
  RazorpayApiError,
  RazorpayAuthError,
  RazorpayMalformedResponseError,
  RazorpayRateLimitError,
  RazorpayTimeoutError,
} from "./errors";
import { redact, maskKeyId } from "./redact";
import type { HttpResponseLike, HttpRequestInit, HttpTransport } from "./transport";

const A: PaymentsTenantContext = { tenantId: "tenant_a" };
const SECRET = "supersecret_KEY_value";

function res(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponseLike {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => text,
  };
}

type Step = HttpResponseLike | "timeout" | Error;

function mockTransport(steps: Step[]): { transport: HttpTransport; requests: Array<{ url: string; init: HttpRequestInit }> } {
  const requests: Array<{ url: string; init: HttpRequestInit }> = [];
  let i = 0;
  const transport: HttpTransport = async (url, init) => {
    requests.push({ url, init });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step === "timeout") {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    if (step instanceof Error) throw step;
    return step as HttpResponseLike;
  };
  return { transport, requests };
}

function makeProvider(steps: Step[], credentials?: RazorpayCredentialSource) {
  const { transport, requests } = mockTransport(steps);
  const client = new RazorpayClient({
    credentials: credentials ?? new StaticRazorpayCredentialSource({ keyId: "rzp_test_abc123", keySecret: SECRET }),
    config: defaultRazorpayConfig({ timeoutMs: 1000 }),
    transport,
    now: () => 0,
  });
  return { provider: new RazorpayTestProvider({ client }), requests };
}

const PAYMENT = { id: "pay_1", entity: "payment", amount: 500_000, currency: "INR", status: "captured", captured: true };
const LINK = { id: "plink_1", status: "created", amount: 500_000, currency: "INR", short_url: "https://rzp.io/i/x" };

describe("Razorpay client/provider — success", () => {
  it("fetches a payment and maps it to a neutral view", async () => {
    const { provider, requests } = makeProvider([res(200, PAYMENT)]);
    const p = await provider.fetchPayment(A, "pay_1");
    assert.equal(p.id, "pay_1");
    assert.equal(p.amountMinor, 500_000);
    assert.equal(p.captured, true);
    // HTTP Basic auth is sent (never the raw secret in our assertions).
    const auth = requests[0]?.init.headers["authorization"];
    assert.ok(auth?.startsWith("Basic "));
  });

  it("creates a payment link with a reference id + idempotency header", async () => {
    const { provider, requests } = makeProvider([res(200, LINK)]);
    const link = await provider.createPaymentLink(A, { amountMinor: 500_000, currency: "INR", referenceId: "rk_1" });
    assert.equal(link.id, "plink_1");
    assert.equal(link.shortUrl, "https://rzp.io/i/x");
    const init = requests[0]?.init;
    assert.equal(init?.headers["x-razorpay-idempotency-key"], "rk_1");
    assert.ok(init?.body?.includes("\"reference_id\":\"rk_1\""));
  });

  it("captures an authorized payment", async () => {
    const { provider } = makeProvider([res(200, { ...PAYMENT, status: "captured", captured: true })]);
    const cap = await provider.capturePayment(A, "pay_1", { amountMinor: 500_000, currency: "INR" });
    assert.equal(cap.captured, true);
    assert.equal(cap.status, "captured");
  });

  it("verifyConnection returns only safe metadata (no credentials)", async () => {
    const { provider } = makeProvider([res(200, { entity: "collection", count: 1, items: [] })]);
    const info = await provider.verifyConnection(A);
    assert.equal(info.mode, "test");
    assert.equal(info.ok, true);
    assert.ok(!JSON.stringify(info).includes(SECRET));
  });
});

describe("Razorpay client/provider — failures", () => {
  it("classifies auth failure (401)", async () => {
    const { provider } = makeProvider([res(401, { error: { code: "BAD_AUTH" } })]);
    await assert.rejects(() => provider.fetchPayment(A, "pay_1"), RazorpayAuthError);
  });

  it("classifies a timeout", async () => {
    const { provider } = makeProvider(["timeout"]);
    await assert.rejects(() => provider.fetchPayment(A, "pay_1"), RazorpayTimeoutError);
  });

  it("classifies a rate-limit (429)", async () => {
    const { provider } = makeProvider([res(429, { error: {} })]);
    await assert.rejects(() => provider.fetchPayment(A, "pay_1"), RazorpayRateLimitError);
  });

  it("classifies a 4xx and a 5xx", async () => {
    await assert.rejects(
      () => makeProvider([res(400, {})]).provider.fetchPayment(A, "pay_1"),
      (e: unknown) => e instanceof RazorpayApiError && e.category === "client_error" && e.retryable === false,
    );
    await assert.rejects(
      () => makeProvider([res(503, {})]).provider.fetchPayment(A, "pay_1"),
      (e: unknown) => e instanceof RazorpayApiError && e.category === "server_error" && e.retryable === true,
    );
  });

  it("rejects a malformed (non-JSON) body", async () => {
    const { provider } = makeProvider([res(200, "<<not json>>")]);
    await assert.rejects(() => provider.fetchPayment(A, "pay_1"), RazorpayMalformedResponseError);
  });

  it("rejects a schema-mismatched body", async () => {
    const { provider } = makeProvider([res(200, { unexpected: true })]);
    await assert.rejects(() => provider.fetchPayment(A, "pay_1"), RazorpayMalformedResponseError);
  });
});

describe("Razorpay — secret redaction", () => {
  it("never surfaces the API secret in thrown errors", async () => {
    const { provider } = makeProvider([res(401, { error: { description: "auth failed" } })]);
    try {
      await provider.fetchPayment(A, "pay_1");
      assert.fail("should have thrown");
    } catch (err) {
      const s = String(err instanceof Error ? err.stack ?? err.message : err);
      assert.ok(!s.includes(SECRET), "secret must not appear in error");
    }
  });

  it("redact() scrubs key ids, Basic auth, and key_secret", () => {
    const dirty = `key id rzp_test_abc123 header Basic YWJjOnNlY3JldA== key_secret=${SECRET}`;
    const clean = redact(dirty);
    assert.ok(!clean.includes("rzp_test_abc123"));
    assert.ok(!clean.includes("Basic YWJjOnNlY3JldA=="));
    assert.ok(!clean.includes(SECRET));
  });

  it("maskKeyId only reveals the mode prefix", () => {
    assert.equal(maskKeyId("rzp_test_abc123"), "rzp_test_****");
  });
});

describe("Razorpay — tenant isolation", () => {
  it("uses each tenant's own credentials (no cross-tenant bleed)", async () => {
    const perTenant: Record<string, RazorpayCredentials> = {
      tenant_a: { keyId: "rzp_test_AAA", keySecret: "secret_a" },
      tenant_b: { keyId: "rzp_test_BBB", keySecret: "secret_b" },
    };
    const source: RazorpayCredentialSource = {
      async getCredentials(ctx) {
        const c = perTenant[ctx.tenantId];
        if (!c) throw new Error("no creds");
        return c;
      },
    };
    const { provider, requests } = makeProvider([res(200, PAYMENT), res(200, PAYMENT)], source);
    await provider.fetchPayment({ tenantId: "tenant_a" }, "pay_1");
    await provider.fetchPayment({ tenantId: "tenant_b" }, "pay_1");

    const decode = (h?: string) => Buffer.from((h ?? "").replace("Basic ", ""), "base64").toString();
    assert.ok(decode(requests[0]?.init.headers["authorization"]).startsWith("rzp_test_AAA:"));
    assert.ok(decode(requests[1]?.init.headers["authorization"]).startsWith("rzp_test_BBB:"));
  });

  it("rejects live credentials outright (test mode only)", () => {
    assert.throws(() => new StaticRazorpayCredentialSource({ keyId: "rzp_live_XXX", keySecret: "s" }));
  });
});
