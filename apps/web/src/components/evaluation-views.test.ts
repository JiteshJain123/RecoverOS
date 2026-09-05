import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SafetyEvidenceList, RevenueBreakdown } from "./EvaluationViews";
import type { SafetyEvidenceRow } from "../lib/types";

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

test("SafetyEvidenceList renders each guarantee with its measured evidence", () => {
  const evidence: SafetyEvidenceRow[] = [
    { id: "block_zero_calls", statement: "Policy BLOCK → 0 provider calls", holds: true, evidence: "0 provider calls", scenarioId: "blocked_policy", scenarioTitle: "BLOCKED policy action" },
    { id: "unverified_zero_revenue", statement: "Unverified outcome → ₹0 recovered", holds: true, evidence: "outcome TIMEOUT; recovered ₹0", scenarioId: "provider_timeout", scenarioTitle: "Provider timeout" },
  ];
  const html = render(createElement(SafetyEvidenceList, { evidence }));
  assert.ok(html.includes("Policy BLOCK → 0 provider calls"));
  assert.ok(html.includes("0 provider calls"));
  assert.ok(html.includes("blocked_policy"));
  assert.ok(html.includes("verified"));
});

test("SafetyEvidenceList flags a failed guarantee", () => {
  const evidence: SafetyEvidenceRow[] = [
    { id: "x", statement: "guarantee", holds: false, evidence: "1 provider call", scenarioId: "s", scenarioTitle: "S" },
  ];
  const html = render(createElement(SafetyEvidenceList, { evidence }));
  assert.ok(html.includes("FAILED"));
});

test("RevenueBreakdown shows verified recovered vs still at risk (minor→major, integer-safe)", () => {
  const html = render(
    createElement(RevenueBreakdown, { atRiskMinor: 1_000_000, recoveredMinor: 250_000, stillAtRiskMinor: 750_000, currency: "INR" }),
  );
  assert.ok(html.includes("Verified recovered"));
  assert.ok(html.includes("Still at risk"));
  assert.ok(html.includes("2,500.00")); // recovered ₹250000 minor → ₹2,500.00
  assert.ok(html.includes("7,500.00")); // still at risk
  assert.ok(html.includes("25% verified recovered"));
});
