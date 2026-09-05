import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AiBoundaryStrip, VerifiedRecoveryLegend } from "./FlowViews";

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

test("AiBoundaryStrip states the boundary: Gemini advises, policy decides, execution acts", () => {
  const html = render(createElement(AiBoundaryStrip));
  assert.ok(html.includes("GEMINI"));
  assert.ok(html.includes("DETERMINISTIC POLICY"));
  assert.ok(html.includes("EXECUTION SERVICE"));
  assert.ok(html.includes("never calls Razorpay directly"));
});

test("VerifiedRecoveryLegend marks only a verified payment as recovered revenue", () => {
  const html = render(createElement(VerifiedRecoveryLegend));
  assert.ok(html.includes("Attempted recovery"));
  assert.ok(html.includes("Payment Link created"));
  assert.ok(html.includes("HTTP 200"));
  assert.ok(html.includes("Verified successful payment"));
  assert.ok(html.includes("= recovered revenue"));
});
