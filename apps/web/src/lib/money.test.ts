import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney, formatMoneyCompact, formatRate } from "./money";

test("formatMoney is integer-safe for minor units (INR)", () => {
  const out = formatMoney(34116900, { currency: "INR" });
  assert.ok(out.includes("3,41,169.00"), out); // Indian grouping, exact fraction
  assert.ok(out.startsWith("₹"), out);
});

test("formatMoney pads fractional minor units exactly", () => {
  assert.ok(formatMoney(1, { currency: "INR" }).endsWith("0.01"));
  assert.ok(formatMoney(0, { currency: "INR" }).endsWith("0.00"));
  assert.ok(formatMoney(99, { currency: "INR" }).endsWith("0.99"));
});

test("formatMoney never produces floating-point drift for large amounts", () => {
  // 999999999999 minor = 9,99,99,99,999.99 — the fraction (99) is exact.
  const out = formatMoney(999999999999, { currency: "INR" });
  assert.ok(out.endsWith(".99"), out);
  assert.ok(!out.includes("NaN"));
  // exactly one decimal separator (no float artifacts)
  assert.equal((out.match(/\./g) ?? []).length, 1);
  // a divisible amount ends in .00 exactly
  assert.ok(formatMoney(500000000000, { currency: "INR" }).endsWith(".00"));
});

test("formatMoney handles negatives", () => {
  const out = formatMoney(-500000, { currency: "INR" });
  assert.ok(out.startsWith("-"), out);
  assert.ok(out.endsWith("5,000.00"), out);
});

test("formatMoney groups USD with western separators", () => {
  const out = formatMoney(34116900, { currency: "USD" });
  assert.ok(out.includes("341,169.00"), out);
});

test("formatMoneyCompact abbreviates INR (L / Cr)", () => {
  assert.ok(formatMoneyCompact(34116900, { currency: "INR" }).includes("L")); // 3.4L
  assert.ok(formatMoneyCompact(1500000000, { currency: "INR" }).includes("Cr"));
});

test("formatRate renders percent or em-dash", () => {
  assert.equal(formatRate(0.0644), "6.4%");
  assert.equal(formatRate(null), "—");
  assert.equal(formatRate(1), "100.0%");
});
