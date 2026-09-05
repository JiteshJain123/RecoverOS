import { test } from "node:test";
import assert from "node:assert/strict";
import { toQuery } from "./client";

// `toQuery` is the shared filter serializer behind every filterable page
// (Revenue at Risk, Recovery Queue, Audit Log). These assertions pin the
// behavior the UI relies on: empty controls are dropped, real filters survive.

test("toQuery drops empty, null, and undefined filter values", () => {
  const q = toQuery({ severity: "", status: undefined, rootCause: null, page: 1 });
  // Only the non-empty value is serialized.
  assert.equal(q, "?page=1");
});

test("toQuery serializes an active filter set into a stable query string", () => {
  const q = toQuery({
    severity: "HIGH",
    status: "PENDING_APPROVAL",
    minAmountMinor: 50000,
    sort: "priority",
    page: 2,
    pageSize: 20,
  });
  const usp = new URLSearchParams(q.replace(/^\?/, ""));
  assert.equal(usp.get("severity"), "HIGH");
  assert.equal(usp.get("status"), "PENDING_APPROVAL");
  assert.equal(usp.get("minAmountMinor"), "50000"); // minor units, integer-safe
  assert.equal(usp.get("sort"), "priority");
  assert.equal(usp.get("page"), "2");
});

test("toQuery returns an empty string when no filters are active", () => {
  assert.equal(toQuery({ severity: "", status: undefined }), "");
});

test("toQuery keeps a zero value (a real filter), not just truthy ones", () => {
  // minPriority=0 is a meaningful floor; it must not be dropped like "".
  assert.equal(toQuery({ minPriority: 0 }), "?minPriority=0");
});
