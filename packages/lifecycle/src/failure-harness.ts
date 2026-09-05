/**
 * Controlled DEVELOPMENT failure harness for the Razorpay integration + webhook
 * replay. It NEVER uses production failure mechanisms, real credentials, or the
 * network: it is a deterministic mock HTTP transport plus signed-webhook helpers
 * so we can reproduce provider timeouts, 5xx, capability states, and webhook
 * delivery quirks (delayed / duplicate / out-of-order) locally and in tests.
 */
import type { HttpRequestInit, HttpResponseLike, HttpTransport } from "@recoveros/payments";
import { buildWebhookFixture, type WebhookFixture } from "@recoveros/webhooks";

export type RazorpayFault = "none" | "timeout" | "http500";

export interface RazorpayScenario {
  fault?: RazorpayFault;
  /** Status returned by GET /payments/:id (drives the capture capability check). */
  fetchStatus?: string;
  /** Status of a created payment link. */
  linkStatus?: string;
  /** Status returned by POST /payments/:id/capture. */
  captureStatus?: string;
}

interface RazorpayTransportHandle {
  transport: HttpTransport;
  requests: Array<{ url: string; init: HttpRequestInit }>;
}

function jsonRes(status: number, body: unknown): HttpResponseLike {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => text,
  };
}

function bodyAmount(init: HttpRequestInit): { amount: number; currency: string } {
  try {
    const b = init.body ? (JSON.parse(init.body) as { amount?: number; currency?: string }) : {};
    return { amount: typeof b.amount === "number" ? b.amount : 500_000, currency: b.currency ?? "INR" };
  } catch {
    return { amount: 500_000, currency: "INR" };
  }
}

/** Build a deterministic mock Razorpay transport for a given failure scenario. */
export function makeRazorpayTransport(scenario: RazorpayScenario = {}): RazorpayTransportHandle {
  const requests: Array<{ url: string; init: HttpRequestInit }> = [];
  const transport: HttpTransport = async (url, init) => {
    requests.push({ url, init });

    if (scenario.fault === "timeout") {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    if (scenario.fault === "http500") return jsonRes(500, { error: { code: "SERVER_ERROR" } });

    // POST /payment_links
    if (url.includes("/payment_links") && !url.includes("/cancel")) {
      const { amount, currency } = bodyAmount(init);
      return jsonRes(200, {
        id: "plink_test_0001",
        status: scenario.linkStatus ?? "created",
        amount,
        currency,
        short_url: "https://rzp.io/i/testLink",
      });
    }
    // POST /payments/:id/capture
    const capture = /\/payments\/([^/]+)\/capture$/.exec(url);
    if (capture) {
      const { amount, currency } = bodyAmount(init);
      return jsonRes(200, {
        id: capture[1],
        amount,
        currency,
        status: scenario.captureStatus ?? "captured",
        captured: (scenario.captureStatus ?? "captured") === "captured",
      });
    }
    // GET /payments?count=1 (verify connection)
    if (url.includes("/payments?count=")) {
      return jsonRes(200, { entity: "collection", count: 1, items: [] });
    }
    // GET /payments/:id (fetch — capability check)
    const fetchPayment = /\/payments\/([^/?]+)(?:\?.*)?$/.exec(url);
    if (fetchPayment) {
      return jsonRes(200, {
        id: fetchPayment[1],
        amount: 500_000,
        currency: "INR",
        status: scenario.fetchStatus ?? "authorized",
      });
    }
    return jsonRes(404, { error: { code: "NOT_FOUND" } });
  };
  return { transport, requests };
}

// --- Webhook replay helpers ------------------------------------------------

export interface WebhookReplayOptions {
  secret: string;
  accountId: string;
  paymentId: string;
  amountMinor: number;
  currency?: string;
  createdAt?: number;
  eventId?: string;
}

/** Build a signed `payment.captured` webhook for replay (customer paid). */
export function capturedWebhook(o: WebhookReplayOptions): WebhookFixture {
  return buildWebhookFixture("payment.captured", o.secret, {
    accountId: o.accountId,
    paymentId: o.paymentId,
    amountMinor: o.amountMinor,
    currency: o.currency,
    createdAt: o.createdAt,
    eventId: o.eventId ?? `evt_${o.paymentId}_captured`,
  });
}

/** Build a signed `payment.authorized` webhook for replay (out-of-order tests). */
export function authorizedWebhook(o: WebhookReplayOptions): WebhookFixture {
  return buildWebhookFixture("payment.authorized", o.secret, {
    accountId: o.accountId,
    paymentId: o.paymentId,
    amountMinor: o.amountMinor,
    currency: o.currency,
    createdAt: o.createdAt,
    eventId: o.eventId ?? `evt_${o.paymentId}_authorized`,
  });
}

/** Build a signed `payment.failed` webhook for replay (customer did not pay). */
export function failedWebhook(o: WebhookReplayOptions): WebhookFixture {
  return buildWebhookFixture("payment.failed", o.secret, {
    accountId: o.accountId,
    paymentId: o.paymentId,
    amountMinor: o.amountMinor,
    currency: o.currency,
    createdAt: o.createdAt,
    eventId: o.eventId ?? `evt_${o.paymentId}_failed`,
  });
}
