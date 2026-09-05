/**
 * WebhookProcessor tests using the in-memory store + fixture harness (no network,
 * no DB). Uses a KNOWN deterministic test secret. Covers signature validity,
 * tampering, idempotency/replay, out-of-order delivery, each supported event,
 * unknown/malformed payloads, unmapped tenant, tenant isolation, retry after a
 * partial failure, and that the secret never appears in any output.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebhookProcessor } from "./processor";
import { InMemoryWebhookStore, SpyCaseReconciler } from "./in-memory-store";
import { StaticProviderAccountResolver, StaticWebhookSecretSource } from "./tenant-map";
import { buildWebhookFixture } from "./fixtures";
import type { CaseReconciler } from "./store";

const SECRET = "whsec_test_deterministic";
const ACC = "acc_test_RECOVEROS1";
const clock = { now: () => new Date("2026-09-04T00:00:00.000Z") };

function build(opts: { reconciler?: CaseReconciler; accounts?: Record<string, string> } = {}) {
  const store = new InMemoryWebhookStore();
  const reconciler = opts.reconciler ?? new SpyCaseReconciler();
  const processor = new WebhookProcessor({
    store,
    resolver: new StaticProviderAccountResolver(opts.accounts ?? { [ACC]: "tenant_a" }),
    secret: new StaticWebhookSecretSource(SECRET),
    caseReconciler: reconciler,
    clock,
  });
  return { store, reconciler, processor };
}

function fx(event: string, o: Parameters<typeof buildWebhookFixture>[2] = {}) {
  const f = buildWebhookFixture(event, SECRET, { accountId: ACC, ...o });
  return { rawBody: f.rawBody, signature: f.signature, eventId: f.eventId };
}

describe("webhook — signature", () => {
  it("accepts a valid signature and processes the event", async () => {
    const { store, processor } = build();
    const r = await processor.process(fx("payment.captured"));
    assert.equal(r.status, "processed");
    assert.equal(r.httpStatus, 200);
    assert.equal(store.payments[0]?.status, "CAPTURED");
    assert.ok(store.audits.some((a) => a.action === "webhook.signature_verified"));
    assert.ok(store.audits.some((a) => a.action === "payment.state_changed"));
  });

  it("rejects an invalid signature and persists no trusted event", async () => {
    const { store, processor } = build();
    const f = fx("payment.captured");
    const r = await processor.process({ ...f, signature: "deadbeef" });
    assert.equal(r.status, "rejected");
    assert.equal(r.code, "invalid_signature");
    assert.equal(store.webhooks.length, 0);
    assert.equal(store.payments.length, 0);
    assert.ok(store.audits.some((a) => a.action === "webhook.rejected"));
  });

  it("rejects a tampered body (signature no longer matches)", async () => {
    const { store, processor } = build();
    const f = fx("payment.captured");
    const r = await processor.process({ ...f, rawBody: f.rawBody + " " });
    assert.equal(r.code, "invalid_signature");
    assert.equal(store.webhooks.length, 0);
  });
});

describe("webhook — idempotency & replay", () => {
  it("treats a duplicate delivery as a safe success (no duplication)", async () => {
    const { store, processor } = build();
    const f = fx("payment.captured");
    const first = await processor.process(f);
    const second = await processor.process(f);
    assert.equal(first.status, "processed");
    assert.equal(second.status, "duplicate");
    assert.equal(second.httpStatus, 200);
    assert.equal(store.webhooks.length, 1);
    assert.equal(store.paymentEvents.length, 1);
    assert.equal(store.payments.length, 1);
  });

  it("replaying the same event many times is idempotent", async () => {
    const { store, processor } = build();
    const f = fx("payment.captured");
    for (let i = 0; i < 4; i++) await processor.process(f);
    assert.equal(store.webhooks.length, 1);
    assert.equal(store.paymentEvents.length, 1);
  });

  it("safely retries after a partial failure (same event id)", async () => {
    let calls = 0;
    const flaky: CaseReconciler = {
      async onPaymentReconciled() {
        calls += 1;
        if (calls === 1) throw new Error("transient downstream failure");
      },
    };
    const { store, processor } = build({ reconciler: flaky });
    const f = fx("payment.captured");

    const first = await processor.process(f);
    assert.equal(first.status, "failed");
    assert.equal(first.httpStatus, 500);
    assert.equal(store.webhooks[0]?.status, "FAILED");

    const retry = await processor.process(f);
    assert.equal(retry.status, "processed");
    assert.equal(store.webhooks.length, 1, "no duplicate webhook row");
    assert.equal(store.paymentEvents.length, 1, "no duplicate payment event");
    assert.equal(store.webhooks[0]?.status, "PROCESSED");
  });
});

describe("webhook — out-of-order delivery", () => {
  it("captured then authorized never downgrades the payment", async () => {
    const { store, processor } = build();
    await processor.process(fx("payment.captured", { eventId: "evt_cap" }));
    await processor.process(fx("payment.authorized", { eventId: "evt_auth" }));
    assert.equal(store.payments.length, 1);
    assert.equal(store.payments[0]?.status, "CAPTURED"); // not downgraded to AUTHORIZED
  });

  it("authorized then captured advances to captured", async () => {
    const { store, processor } = build();
    await processor.process(fx("payment.authorized", { eventId: "evt_auth" }));
    await processor.process(fx("payment.captured", { eventId: "evt_cap" }));
    assert.equal(store.payments[0]?.status, "CAPTURED");
  });
});

describe("webhook — supported events", () => {
  it("payment.failed reconciles to FAILED with failure details", async () => {
    const { store, reconciler, processor } = build();
    await processor.process(fx("payment.failed", { failureCode: "GATEWAY_ERROR", failureReason: "bank down" }));
    assert.equal(store.payments[0]?.status, "FAILED");
    assert.equal(store.payments[0]?.failureCode, "GATEWAY_ERROR");
    assert.equal((reconciler as SpyCaseReconciler).calls.length, 1);
  });

  it("payment.refunded reconciles to REFUNDED", async () => {
    const { store, processor } = build();
    await processor.process(fx("payment.refunded"));
    assert.equal(store.payments[0]?.status, "REFUNDED");
  });

  it("order.paid captures the payment", async () => {
    const { store, processor } = build();
    const r = await processor.process(fx("order.paid"));
    assert.equal(r.status, "processed");
    assert.equal(store.payments[0]?.status, "CAPTURED");
  });
});

describe("webhook — rejection paths", () => {
  it("acknowledges an unknown event without changing canonical state", async () => {
    const { store, processor } = build();
    const r = await processor.process(fx("payment.dispute.created"));
    assert.equal(r.status, "processed");
    assert.equal(r.code, "unsupported_event");
    assert.equal(store.payments.length, 0);
  });

  it("rejects a malformed payload (valid signature, bad shape)", async () => {
    const { store, processor } = build();
    const rawBody = JSON.stringify({ hello: "world" });
    const signature = buildWebhookFixture("payment.captured", SECRET).signature; // wrong sig for this body
    // Re-sign the malformed body so signature passes and payload validation fails.
    const { computeSignature } = await import("./signature");
    const r = await processor.process({ rawBody, signature: computeSignature(rawBody, SECRET), eventId: "evt_bad" });
    void signature;
    assert.equal(r.status, "rejected");
    assert.equal(r.code, "invalid_payload");
    assert.equal(store.payments.length, 0);
  });

  it("rejects an unmapped provider account (never guesses a tenant)", async () => {
    const { store, processor } = build();
    const f = buildWebhookFixture("payment.captured", SECRET, { accountId: "acc_test_STRANGER" });
    const r = await processor.process({ rawBody: f.rawBody, signature: f.signature, eventId: f.eventId });
    assert.equal(r.status, "rejected");
    assert.equal(r.code, "unmapped_account");
    assert.equal(store.webhooks.length, 0);
  });
});

describe("webhook — tenant isolation", () => {
  it("routes each account to its own tenant with no bleed", async () => {
    const { store, processor } = build({ accounts: { acc_A: "tenant_a", acc_B: "tenant_b" } });
    await processor.process(buildWebhookFixture("payment.captured", SECRET, { accountId: "acc_A", paymentId: "pay_A" }));
    await processor.process(buildWebhookFixture("payment.failed", SECRET, { accountId: "acc_B", paymentId: "pay_B" }));

    const a = store.payments.filter((p) => p.tenantId === "tenant_a");
    const b = store.payments.filter((p) => p.tenantId === "tenant_b");
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0]?.razorpayPaymentId, "pay_A");
    assert.equal(b[0]?.razorpayPaymentId, "pay_B");
    assert.ok(store.webhooks.every((w) => w.tenantId === "tenant_a" || w.tenantId === "tenant_b"));
  });
});

describe("webhook — secret safety", () => {
  it("never lets the webhook secret appear in audits, results, or stored payload", async () => {
    const { store, processor } = build();
    await processor.process(fx("payment.captured"));
    await processor.process({ ...fx("payment.captured"), signature: "bad" });
    const dump = JSON.stringify({ audits: store.audits, webhooks: store.webhooks, payments: store.payments });
    assert.ok(!dump.includes(SECRET));
  });
});
