import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StageTrace, SafetyCard, InvariantList, StatsGrid } from "./FailureLabViews";
import type { FailureLabStage, InvariantResult, FailureLabStats, SafetyResult } from "../lib/types";

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

test("StageTrace renders every stage with its status and detail", () => {
  const stages: FailureLabStage[] = [
    { key: "detected", order: 1, label: "Payment detected", status: "ok", detail: "Failed payment detected.", at: "2026-09-05T12:00:00.000Z" },
    { key: "provider", order: 7, label: "Provider call", status: "skipped", detail: "0 provider calls (policy denied the action).", at: null },
  ];
  const html = render(createElement(StageTrace, { stages }));
  assert.ok(html.includes("Payment detected"));
  assert.ok(html.includes("Provider call"));
  assert.ok(html.includes("0 provider calls"));
});

test("StageTrace marks the first blocked/failed stage as the stopping point", () => {
  const stages: FailureLabStage[] = [
    { key: "detected", order: 1, label: "Payment detected", status: "ok", detail: "ok", at: null },
    { key: "policy", order: 4, label: "Policy evaluation", status: "blocked", detail: "Policy BLOCK.", at: null },
    { key: "provider", order: 7, label: "Provider call", status: "skipped", detail: "0 provider calls.", at: null },
  ];
  const html = render(createElement(StageTrace, { stages }));
  assert.ok(html.includes("Stopped here"), "the failing stage should be marked as the stopping point");
});

test("SafetyCard shows credited state strictly from the data", () => {
  const notCredited: SafetyResult = { headline: "PROVIDER TIMEOUT", result: "Recovery NOT credited", reason: "Provider outcome not verified.", credited: false, tone: "warning" };
  const html = render(createElement(SafetyCard, { safety: notCredited }));
  assert.ok(html.includes("PROVIDER TIMEOUT"));
  assert.ok(html.includes("No revenue credited"));
  assert.ok(!html.includes("Revenue credited</")); // never falsely claims recovery

  const credited: SafetyResult = { headline: "RECOVERY VERIFIED", result: "Revenue credited", reason: "verified capture", credited: true, tone: "success" };
  const okHtml = render(createElement(SafetyCard, { safety: credited }));
  assert.ok(okHtml.includes("Revenue credited"));
});

test("InvariantList marks applicable/held invariants and dims non-applicable ones", () => {
  const invariants: InvariantResult[] = [
    { id: "block_zero_calls", statement: "BLOCK → 0 provider calls", applicable: true, holds: true, detail: "provider calls: 0" },
    { id: "review_zero_calls", statement: "REVIEW without approval → 0 provider calls", applicable: false, holds: false, detail: "n/a" },
  ];
  const html = render(createElement(InvariantList, { invariants }));
  assert.ok(html.includes("BLOCK → 0 provider calls"));
  assert.ok(html.includes("not exercised"));
  assert.ok(html.includes("inv-row--na")); // non-applicable dimmed
});

test("StatsGrid formats money and counts", () => {
  const stats: FailureLabStats = {
    providerCalls: 1,
    webhookEvents: 2,
    duplicateEventsIgnored: 1,
    actionsPrevented: 0,
    invalidSuccessClaimsPrevented: 1,
    revenueCreditedMinor: 0,
    revenueLeftAtRiskMinor: 500000,
    currency: "INR",
  };
  const html = render(createElement(StatsGrid, { stats }));
  assert.ok(html.includes("Provider calls"));
  assert.ok(html.includes("Invalid success claims prevented"));
  assert.ok(html.includes("5,000.00")); // revenue left at risk formatted (minor→major)
});
