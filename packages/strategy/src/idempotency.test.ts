/**
 * Tests for deterministic idempotency-key generation: stable for identical case
 * state (so re-planning does not create a new executable attempt) and distinct
 * for a materially different attempt (a new retry) or a different action kind.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateIdempotencyKey, type IdempotencyInput } from "./idempotency";

function input(over: Partial<IdempotencyInput> = {}): IdempotencyInput {
  return {
    tenantId: over.tenantId ?? "tenant_a",
    caseId: over.caseId ?? "case_1",
    actionKind: over.actionKind ?? "RETRY_PAYMENT",
    rootCause: over.rootCause ?? "TIMEOUT",
    amountMinor: over.amountMinor ?? 500_000,
    retryCount: over.retryCount ?? 0,
  };
}

describe("generateIdempotencyKey", () => {
  it("is deterministic for identical inputs", () => {
    assert.equal(generateIdempotencyKey(input()), generateIdempotencyKey(input()));
  });

  it("embeds the case id and action kind for readability", () => {
    const key = generateIdempotencyKey(input());
    assert.match(key, /^rk_case_1_RETRY_PAYMENT_[0-9a-f]{8}$/);
  });

  it("changes when the retry attempt changes (a new distinct attempt)", () => {
    assert.notEqual(
      generateIdempotencyKey(input({ retryCount: 0 })),
      generateIdempotencyKey(input({ retryCount: 1 })),
    );
  });

  it("changes with a different action kind", () => {
    assert.notEqual(
      generateIdempotencyKey(input({ actionKind: "RETRY_PAYMENT" })),
      generateIdempotencyKey(input({ actionKind: "CREATE_PAYMENT_LINK" })),
    );
  });

  it("changes across tenants and cases (no cross-tenant collision)", () => {
    assert.notEqual(
      generateIdempotencyKey(input({ tenantId: "tenant_a" })),
      generateIdempotencyKey(input({ tenantId: "tenant_b" })),
    );
    assert.notEqual(
      generateIdempotencyKey(input({ caseId: "case_1" })),
      generateIdempotencyKey(input({ caseId: "case_2" })),
    );
  });

  it("changes when the amount changes", () => {
    assert.notEqual(
      generateIdempotencyKey(input({ amountMinor: 500_000 })),
      generateIdempotencyKey(input({ amountMinor: 600_000 })),
    );
  });
});
