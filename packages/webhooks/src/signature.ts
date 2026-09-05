/**
 * Razorpay webhook signature verification.
 *
 * Razorpay signs the webhook by computing HMAC-SHA256 over the EXACT raw request
 * body using the webhook secret, and sends the hex digest in the
 * `X-Razorpay-Signature` header. We MUST verify against the raw bytes — never a
 * re-serialized JSON — because any re-stringify changes the bytes and breaks the
 * HMAC. The comparison is constant-time to avoid timing side channels.
 *
 * The secret is used only here; it is never logged, stored, or returned.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Compute the hex HMAC-SHA256 of the raw body with the given secret. */
export function computeSignature(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Verify an `X-Razorpay-Signature` against the raw body. Returns false for any
 * mismatch, missing signature, or malformed hex — never throws on bad input.
 */
export function verifyRazorpaySignature(
  rawBody: Buffer | string,
  signature: string | undefined | null,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expected = computeSignature(rawBody, secret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  // Length must match for timingSafeEqual; unequal lengths ⇒ not equal.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
