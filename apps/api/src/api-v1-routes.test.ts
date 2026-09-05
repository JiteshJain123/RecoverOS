/**
 * HTTP-level tests for the /api/v1/intelligence surface. Starts the real
 * Express router on an ephemeral port with an in-memory-backed read service
 * (no database) and exercises it over `fetch`. Deterministic (fixed clock).
 *
 * Responses are dynamic JSON, so `any` is intentionally permitted in this test
 * file for concise assertions.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import {
  IntelligenceReadService,
  InMemoryReadRepository,
  type Clock,
  type InMemoryReadSeed,
  type MemCase,
} from "@recoveros/intelligence";
import { createApiV1Router } from "./api-v1-routes";

const fixedClock: Clock = { now: () => new Date("2026-08-01T09:00:00.000Z") };

function baseCase(over: Partial<MemCase> & { id: string; tenantId: string }): MemCase {
  return {
    id: over.id,
    tenantId: over.tenantId,
    paymentId: over.paymentId ?? null,
    customerId: over.customerId ?? null,
    status: over.status ?? "DETECTED",
    reason: over.reason ?? "FAILED_PAYMENT",
    rootCause: over.rootCause ?? null,
    severity: over.severity ?? null,
    priorityScore: over.priorityScore ?? null,
    amountAtRiskMinor: over.amountAtRiskMinor ?? 100_000,
    currency: over.currency ?? "INR",
    openedAt: over.openedAt ?? "2026-07-25T00:00:00.000Z",
    resolvedAt: over.resolvedAt ?? null,
    lastDetectedAt: over.lastDetectedAt ?? "2026-07-31T00:00:00.000Z",
    detectionRuleVersion: over.detectionRuleVersion ?? "detect-v1",
    riskSignals: over.riskSignals ?? [],
    priorityComponents: over.priorityComponents ?? null,
  };
}

const seed: InMemoryReadSeed = {
  cases: [
    baseCase({
      id: "c1", tenantId: "t1", paymentId: "pay1", customerId: "cust1", status: "DETECTED",
      rootCause: "BANK_DECLINE", severity: "CRITICAL", priorityScore: 90, amountAtRiskMinor: 2_000_000,
      openedAt: "2026-07-30T00:00:00.000Z",
      riskSignals: [
        {
          type: "FAILED_PAYMENT", severity: "CRITICAL", confidence: 0.99, reason: "failed",
          rootCause: "BANK_DECLINE", estimatedRevenueAtRiskMinor: 2_000_000, ruleId: "failed_payment",
          ruleVersion: "detect-v1", evidence: { failureCode: "bank_declined" },
        },
      ],
      priorityComponents: { score: 90, formulaVersion: "priority-v1", components: [{ key: "amount", value: 1, weight: 0.35, contribution: 35, label: "Amount at risk", detail: "x" }] },
    }),
    baseCase({ id: "c2", tenantId: "t1", paymentId: "pay2", customerId: "cust2", status: "DETECTED", rootCause: "TIMEOUT", severity: "MEDIUM", priorityScore: 40, amountAtRiskMinor: 300_000, openedAt: "2026-07-29T00:00:00.000Z" }),
    baseCase({ id: "c3", tenantId: "t1", paymentId: "pay3", customerId: "cust1", status: "PENDING_APPROVAL", rootCause: "GATEWAY_ERROR", severity: "HIGH", priorityScore: 65, amountAtRiskMinor: 900_000, openedAt: "2026-07-28T00:00:00.000Z" }),
    baseCase({ id: "c4", tenantId: "t1", paymentId: "pay4", customerId: "cust3", status: "RECOVERED", severity: "MEDIUM", priorityScore: 50, amountAtRiskMinor: 500_000, openedAt: "2026-07-20T00:00:00.000Z", resolvedAt: "2026-07-22T00:00:00.000Z" }),
    baseCase({ id: "c5", tenantId: "t1", paymentId: "pay5", customerId: "cust2", status: "FAILED", severity: "HIGH", priorityScore: 55, amountAtRiskMinor: 400_000, openedAt: "2026-07-21T00:00:00.000Z" }),
    baseCase({ id: "c9", tenantId: "t2", paymentId: "pay9", customerId: "custX", status: "DETECTED", rootCause: "TIMEOUT", severity: "LOW", priorityScore: 20, amountAtRiskMinor: 111_000, openedAt: "2026-07-30T00:00:00.000Z" }),
  ],
  payments: [
    {
      id: "pay1", tenantId: "t1", customerId: "cust1", status: "FAILED", method: "card",
      amountMinor: 2_000_000, currency: "INR", failureCode: "bank_declined", failureReason: "declined",
      paymentRef: "seed_rzp_payment_1", orderRef: "seed_rzp_order_1",
      createdAt: "2026-07-30T00:00:00.000Z", capturedAt: null,
      events: [
        { eventType: "PAYMENT_CREATED", rawType: "payment.created", occurredAt: "2026-07-30T00:00:00.000Z" },
        { eventType: "PAYMENT_FAILED", rawType: "payment.failed", occurredAt: "2026-07-30T01:00:00.000Z" },
      ],
    },
    { id: "pay9", tenantId: "t2", customerId: "custX", status: "FAILED", method: "upi", amountMinor: 111_000, currency: "INR", failureCode: "bank_timeout", failureReason: "t/o", paymentRef: "seed_rzp_payment_9", orderRef: "seed_rzp_order_9", createdAt: "2026-07-30T00:00:00.000Z", capturedAt: null, events: [{ eventType: "PAYMENT_CREATED", rawType: "payment.created", occurredAt: "2026-07-30T00:00:00.000Z" }] },
  ],
  customers: [{ id: "cust1", tenantId: "t1", name: "Cust One", email: "one@t1.seed.test", phone: "+9199100001" }],
  decisions: [{ id: "d1", tenantId: "t1", caseId: "c1", proposedAction: "RETRY_PAYMENT", amountMinor: 2_000_000, confidence: 0.9, diagnosis: "dx", rationale: "rx", createdAt: "2026-07-30T02:00:00.000Z" }],
  actions: [{ id: "a1", tenantId: "t1", caseId: "c1", type: "RETRY_PAYMENT", status: "AUTHORIZED", amountMinor: 2_000_000, currency: "INR", policyDecision: "ALLOW", policyVersion: 2, idempotencyKey: "seed_idem_1", externalReference: null, createdAt: "2026-07-30T02:05:00.000Z" }],
  audits: [
    { id: "au1", tenantId: "t1", entityType: "RecoveryCase", entityId: "c1", actorType: "SYSTEM", action: "intelligence.batch.case.created", summary: "opened", metadata: { what: "recovery_case_created", evidence: { paymentRef: "seed_rzp_payment_1", failureHistory: { retryCount: 1 }, ruleVersions: { detection: "detect-v1" } } }, createdAt: "2026-07-30T02:10:00.000Z" },
  ],
};

let server: Server;
let base = "";

function makeApp(): express.Express {
  const service = new IntelligenceReadService({ repo: new InMemoryReadRepository(seed), clock: fixedClock });
  const app = express();
  app.use(express.json());
  app.use(createApiV1Router({ service }));
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: { code: "internal_error", message: "internal" } });
  });
  return app;
}

async function get(path: string, tenant?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, tenant ? { headers: { "x-tenant-id": tenant } } : {});
  return { status: res.status, body: await res.json() };
}

before(async () => {
  server = makeApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
});

describe("GET /summary", () => {
  it("requires a tenant context header", async () => {
    const r = await get("/api/v1/intelligence/summary");
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, "tenant_context_required");
  });

  it("returns tenant-scoped aggregates with explicit minor-unit money", async () => {
    const r = await get("/api/v1/intelligence/summary", "t1");
    assert.equal(r.status, 200);
    assert.equal(r.body.revenueAtRiskMinor, 3_200_000); // c1+c2+c3
    assert.equal(r.body.affectedPayments, 3);
    assert.equal(r.body.affectedCustomers, 2);
    assert.equal(r.body.highPriorityCases, 2); // c1(90), c3(65)
    assert.equal(r.body.reviewRequiredCases, 2); // c1 CRITICAL, c3 PENDING_APPROVAL
    assert.equal(r.body.recoveredRevenueMinor, 500_000);
    assert.equal(r.body.recoverySuccessRate, 0.5); // 1 recovered / (1 recovered + 1 failed)
    assert.equal(r.body.money.unit, "minor");
    assert.equal(r.body.money.exponent, 2);
  });
});

describe("GET /cases — tenant isolation", () => {
  it("tenant A only sees tenant A cases", async () => {
    const r = await get("/api/v1/intelligence/cases", "t1");
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 5);
    assert.ok(r.body.items.every((c: { id: string }) => c.id !== "c9"));
  });

  it("tenant A cannot read tenant B's case (404, no existence leak)", async () => {
    const asT1 = await get("/api/v1/intelligence/cases/c9", "t1");
    assert.equal(asT1.status, 404);
    assert.equal(asT1.body.error.code, "not_found");
    const asT2 = await get("/api/v1/intelligence/cases/c9", "t2");
    assert.equal(asT2.status, 200);
    assert.equal(asT2.body.id, "c9");
  });

  it("rejects a client-supplied tenantId override", async () => {
    const r = await get("/api/v1/intelligence/cases?tenantId=t2", "t1");
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "tenant_override_forbidden");
  });
});

describe("GET /cases — pagination & stable sort", () => {
  it("paginates deterministically", async () => {
    const p1 = await get("/api/v1/intelligence/cases?pageSize=2&page=1&sort=priority", "t1");
    assert.equal(p1.body.total, 5);
    assert.equal(p1.body.totalPages, 3);
    assert.equal(p1.body.items.length, 2);
    assert.equal(p1.body.items[0].id, "c1"); // priority 90 first
    assert.equal(p1.body.items[1].id, "c3"); // 65

    const p2 = await get("/api/v1/intelligence/cases?pageSize=2&page=2&sort=priority", "t1");
    assert.equal(p2.body.items.length, 2);
    // No overlap between pages.
    const ids1 = p1.body.items.map((c: { id: string }) => c.id);
    const ids2 = p2.body.items.map((c: { id: string }) => c.id);
    assert.equal(ids1.filter((x: string) => ids2.includes(x)).length, 0);
  });
});

describe("GET /cases — filters", () => {
  it("filters by severity", async () => {
    const r = await get("/api/v1/intelligence/cases?severity=CRITICAL", "t1");
    assert.equal(r.body.total, 1);
    assert.equal(r.body.items[0].id, "c1");
  });
  it("filters by status and rootCause", async () => {
    assert.equal((await get("/api/v1/intelligence/cases?status=DETECTED", "t1")).body.total, 2);
    assert.equal((await get("/api/v1/intelligence/cases?rootCause=TIMEOUT", "t1")).body.total, 1);
  });
  it("filters by minAmountMinor and minPriority", async () => {
    assert.equal((await get("/api/v1/intelligence/cases?minAmountMinor=800000", "t1")).body.total, 2); // c1, c3
    assert.equal((await get("/api/v1/intelligence/cases?minPriority=60", "t1")).body.total, 2); // c1, c3
  });
});

describe("GET /cases/:id — detail includes evidence", () => {
  it("returns full detail with evidence, signals, components, actions", async () => {
    const r = await get("/api/v1/intelligence/cases/c1", "t1");
    assert.equal(r.status, 200);
    assert.equal(r.body.id, "c1");
    assert.ok(r.body.evidence, "evidence present");
    assert.equal(r.body.evidence.ruleVersions.detection, "detect-v1");
    assert.ok(Array.isArray(r.body.detectedSignals) && r.body.detectedSignals.length === 1);
    assert.ok(r.body.scoreComponents && r.body.scoreComponents.score === 90);
    assert.equal(r.body.recoveryDecisions.length, 1);
    assert.equal(r.body.recoveryActions.length, 1);
    assert.equal(r.body.eventTimeline.length, 2);
    assert.equal(r.body.customer.email, "one@t1.seed.test");
    assert.equal(r.body.money.unit, "minor");
  });

  it("returns 404 for a missing case", async () => {
    const r = await get("/api/v1/intelligence/cases/does_not_exist", "t1");
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, "not_found");
  });
});

describe("GET /cases — validation errors", () => {
  it("rejects an out-of-range pageSize", async () => {
    const r = await get("/api/v1/intelligence/cases?pageSize=9999", "t1");
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "validation_error");
    assert.ok(Array.isArray(r.body.error.details));
  });
  it("rejects an unknown sort and a non-numeric minPriority", async () => {
    assert.equal((await get("/api/v1/intelligence/cases?sort=sideways", "t1")).status, 400);
    assert.equal((await get("/api/v1/intelligence/cases?minPriority=abc", "t1")).status, 400);
  });
});

describe("GET /payments/:id/timeline", () => {
  it("returns the normalized event timeline for a tenant's payment", async () => {
    const r = await get("/api/v1/intelligence/payments/pay1/timeline", "t1");
    assert.equal(r.status, 200);
    assert.equal(r.body.paymentId, "pay1");
    assert.equal(r.body.events.length, 2);
    assert.equal(r.body.events[0].eventType, "PAYMENT_CREATED");
  });
  it("does not expose another tenant's payment (404)", async () => {
    const r = await get("/api/v1/intelligence/payments/pay9/timeline", "t1");
    assert.equal(r.status, 404);
  });
});
