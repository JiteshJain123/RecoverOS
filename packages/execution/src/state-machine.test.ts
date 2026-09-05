import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertTransition, canTransition, isTerminal } from "./state-machine";
import { InvalidActionTransitionError } from "./errors";

describe("action state machine", () => {
  it("permits the happy path PROPOSED→APPROVED→EXECUTING→SUCCEEDED", () => {
    assert.ok(canTransition("PROPOSED", "APPROVED"));
    assert.ok(canTransition("APPROVED", "EXECUTING"));
    assert.ok(canTransition("EXECUTING", "SUCCEEDED"));
  });

  it("permits the review path PROPOSED→APPROVAL_REQUIRED→APPROVED", () => {
    assert.ok(canTransition("PROPOSED", "APPROVAL_REQUIRED"));
    assert.ok(canTransition("APPROVAL_REQUIRED", "APPROVED"));
  });

  it("rejects illegal jumps", () => {
    assert.ok(!canTransition("PROPOSED", "SUCCEEDED"));
    assert.ok(!canTransition("SUCCEEDED", "EXECUTING"));
    assert.ok(!canTransition("APPROVAL_REQUIRED", "EXECUTING"));
    assert.throws(() => assertTransition("SUCCEEDED", "EXECUTING"), InvalidActionTransitionError);
  });

  it("marks terminal states", () => {
    for (const s of ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"] as const) assert.ok(isTerminal(s));
    for (const s of ["PROPOSED", "APPROVAL_REQUIRED", "APPROVED", "EXECUTING"] as const) assert.ok(!isTerminal(s));
  });
});
