import { test } from "node:test";
import assert from "node:assert/strict";
import { redactString, redactValue, redactedJson } from "./redact";

test("redactString scrubs Razorpay keys, basic/bearer auth, and webhook secrets", () => {
  const dirty = "id rzp_test_ABC123 auth Basic YWJjOnNlY3JldA== token Bearer abcdef123456 whsec_xyz789";
  const clean = redactString(dirty);
  assert.ok(!clean.includes("rzp_test_ABC123"));
  assert.ok(!clean.includes("YWJjOnNlY3JldA=="));
  assert.ok(!clean.includes("abcdef123456"));
  assert.ok(!clean.includes("whsec_xyz789"));
  assert.ok(clean.includes("***"));
});

test("redactValue drops secret-named keys recursively", () => {
  const out = redactValue({
    ok: true,
    api_key: "AIzaSuperSecretKeyValue123",
    nested: { authorization: "Basic zzz", webhook_secret: "whsec_abc", amount: 500 },
  }) as Record<string, unknown>;
  assert.equal(out.api_key, "***");
  const nested = out.nested as Record<string, unknown>;
  assert.equal(nested.authorization, "***");
  assert.equal(nested.webhook_secret, "***");
  assert.equal(nested.amount, 500); // non-secret preserved
});

test("redactedJson never leaks a Google API key shape from audit metadata", () => {
  const json = redactedJson({ note: "key AIzaB1c2D3e4F5g6H7i8J9k0", keySecret: "s3cr3t" });
  assert.ok(!json.includes("AIzaB1c2D3e4F5g6H7i8J9k0"));
  assert.ok(!json.includes("s3cr3t"));
});
