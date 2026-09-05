import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MetricCard } from "./MetricCard";
import { DataTable, type Column } from "./DataTable";
import { FunnelChart } from "./FunnelChart";
import { AsyncBoundary } from "./AsyncBoundary";
import { CaseStatusBadge, PolicyBadge } from "./primitives";
import { CaseDetailView } from "./CaseDetailView";
import type { CaseDetailDTO, CaseListItemDTO, FunnelStage, MoneyMeta } from "../lib/types";

const MONEY: MoneyMeta = { unit: "minor", exponent: 2, currency: "INR" };
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

// --- Dashboard widgets ------------------------------------------------------

test("MetricCard renders label and pre-formatted value", () => {
  const html = render(createElement(MetricCard, { label: "Revenue at Risk", value: "₹3,41,169.00", accent: "danger", icon: "⚠" }));
  assert.ok(html.includes("Revenue at Risk"));
  assert.ok(html.includes("₹3,41,169.00"));
});

test("FunnelChart renders every stage with case counts", () => {
  const stages: FunnelStage[] = [
    { key: "at_risk", label: "At Risk", cases: 20, amountMinor: 5000000 },
    { key: "recovered", label: "Recovered", cases: 5, amountMinor: 1000000 },
  ];
  const html = render(createElement(FunnelChart, { stages, money: MONEY }));
  // The funnel relabels stages to the recovery narrative (presentation only).
  assert.ok(html.includes("Revenue at Risk"));
  assert.ok(html.includes("Verified Recoveries"));
  assert.ok(html.includes("20 cases"));
});

// --- Case list --------------------------------------------------------------

test("DataTable renders rows and an empty state", () => {
  const columns: Array<Column<CaseListItemDTO>> = [
    { key: "id", header: "ID", render: (c) => c.id },
    { key: "status", header: "Status", render: (c) => createElement(CaseStatusBadge, { status: c.status }) },
  ];
  const rows: CaseListItemDTO[] = [
    {
      id: "case_abc", status: "PENDING_APPROVAL", reason: "FAILED_PAYMENT", rootCause: "TIMEOUT", severity: "HIGH",
      priorityScore: 60, amountAtRiskMinor: 100000, currency: "INR", paymentId: "p1", customerId: "cu1",
      openedAt: "2026-09-01T00:00:00.000Z", lastDetectedAt: null,
    },
  ];
  const html = render(createElement(DataTable<CaseListItemDTO>, { columns, rows, rowKey: (c) => c.id }));
  assert.ok(html.includes("case_abc"));
  assert.ok(html.includes("Awaiting Approval")); // professional status vocabulary

  const empty = render(createElement(DataTable<CaseListItemDTO>, { columns, rows: [], rowKey: (c) => c.id, emptyLabel: "Nothing here" }));
  assert.ok(empty.includes("Nothing here"));
});

// --- API error handling -----------------------------------------------------

test("AsyncBoundary renders a friendly error state (no internals)", () => {
  const html = render(
    createElement(AsyncBoundary<{ x: number }>, {
      loading: false,
      error: { status: 503, code: "api_unavailable", message: "raw internal detail" },
      data: null,
      children: (d: { x: number }) => createElement("div", null, String(d.x)),
    }),
  );
  assert.ok(html.includes("API unavailable"));
  assert.ok(html.includes("not reachable"));
  assert.ok(!html.includes("raw internal detail"));
});

test("AsyncBoundary renders children when data is present", () => {
  const html = render(
    createElement(AsyncBoundary<{ x: number }>, {
      loading: false,
      error: null,
      data: { x: 42 },
      children: (d: { x: number }) => createElement("div", null, `value-${d.x}`),
    }),
  );
  assert.ok(html.includes("value-42"));
});

// --- Case detail + policy state --------------------------------------------

function caseDetail(over: Partial<CaseDetailDTO> = {}): CaseDetailDTO {
  return {
    id: "case_1", tenantId: "seed_tenant_1", status: "PENDING_APPROVAL", reason: "FAILED_PAYMENT",
    rootCause: "GATEWAY_ERROR", severity: "HIGH", priorityScore: 72, amountAtRiskMinor: 250000, currency: "INR",
    money: MONEY, openedAt: "2026-09-01T00:00:00.000Z", resolvedAt: null, lastDetectedAt: null, detectionRuleVersion: "detect-v1",
    customer: { id: "cust_1", name: "Nadia Khan", email: null, phone: null },
    payment: { id: "pay_1", status: "FAILED", method: null, amountMinor: 250000, currency: "INR", failureCode: "gateway_error", failureReason: null, paymentRef: "seed_rzp_payment_1", orderRef: null, createdAt: "2026-09-01T00:00:00.000Z", capturedAt: null },
    paymentHistory: [],
    eventTimeline: [{ eventType: "PAYMENT_FAILED", rawType: "payment.failed", occurredAt: "2026-09-01T00:00:00.000Z" }],
    detectedSignals: [{ type: "FAILED_PAYMENT", severity: "HIGH", confidence: 0.91, reason: "failed", rootCause: "GATEWAY_ERROR", estimatedRevenueAtRiskMinor: 250000, ruleId: "r1", ruleVersion: "v1", evidence: { note: "safe" } }],
    scoreComponents: {}, evidence: {},
    recoveryDecisions: [{ id: "d1", proposedAction: "SEND_PAYMENT_LINK", amountMinor: 250000, confidence: 0.8, diagnosis: "Gateway error", rationale: "Send a fresh payment link.", createdAt: "2026-09-01T00:00:00.000Z" }],
    recoveryActions: [{ id: "a1", type: "SEND_PAYMENT_LINK", status: "PENDING_APPROVAL", amountMinor: 250000, currency: "INR", policyDecision: "REVIEW", policyVersion: 2, idempotencyKey: "k1", externalReference: null, createdAt: "2026-09-01T00:00:00.000Z" }],
    auditHistory: [{ id: "au1", actorType: "SYSTEM", action: "recovery.strategy.generated", summary: "Strategy proposed", metadata: { ok: true }, createdAt: "2026-09-01T00:00:00.000Z" }],
    ...over,
  };
}

test("CaseDetailView renders all sections and the policy decision", () => {
  const html = render(createElement(CaseDetailView, { detail: caseDetail() }));
  for (const section of ["A · Revenue summary", "B · Payment timeline", "C · Intelligence", "D · Gemini decision", "E · Policy decision", "F · Recovery action", "G · Audit timeline"]) {
    assert.ok(html.includes(section), `missing section: ${section}`);
  }
  assert.ok(html.includes("REVIEW"), "policy decision REVIEW should show");
  assert.ok(html.includes("₹2,500.00"), "amount at risk should be formatted");
  assert.ok(html.includes("Send payment link"), "Gemini strategy should show");
});

test("CaseDetailView redacts any secret-shaped audit metadata before display", () => {
  const html = render(
    createElement(CaseDetailView, {
      detail: caseDetail({
        detectedSignals: [
          { type: "FAILED_PAYMENT", severity: "HIGH", confidence: 0.9, reason: "x", rootCause: "GATEWAY_ERROR", estimatedRevenueAtRiskMinor: 1, ruleId: "r", ruleVersion: "v", evidence: { leaked: "rzp_test_SHOULDNOTAPPEAR", apiKey: "AIzaLEAKLEAKLEAK123" } },
        ],
      }),
    }),
  );
  assert.ok(!html.includes("rzp_test_SHOULDNOTAPPEAR"));
  assert.ok(!html.includes("AIzaLEAKLEAKLEAK123"));
  assert.ok(html.includes("***"));
});

test("PolicyBadge renders each decision", () => {
  assert.ok(render(createElement(PolicyBadge, { decision: "ALLOW" })).includes("ALLOW"));
  assert.ok(render(createElement(PolicyBadge, { decision: "BLOCK" })).includes("BLOCK"));
});
