/**
 * Recovery revenue accounting rules — the single source of truth for when money
 * is considered RECOVERED. Revenue is credited ONLY when provider facts prove
 * the expected outcome; an HTTP 200 alone is never enough.
 *
 *   successful payment / capture   → RECOVERED (credit the amount)
 *   created payment link           → NOT recovered (link exists, unpaid)
 *   failed payment / link          → NOT recovered
 *   provider timeout               → NOT recovered
 *   duplicate execution/webhook    → NOT recovered (already counted, if at all)
 *   provider capability error      → NOT recovered
 *
 * Link-based recovery becomes RECOVERED only when a later, signature-verified
 * `payment.captured` webhook proves the customer paid.
 */
import type { ProviderOutcome } from "@recoveros/execution";

/** A provider outcome credits revenue only when it is a genuine capture. */
export function isRecoveredOutcome(outcome: ProviderOutcome): boolean {
  return outcome === "SUCCEEDED";
}

/** Amount to credit for a provider outcome (0 unless a genuine capture). */
export function recoveredAmountFor(outcome: ProviderOutcome, amountMinor: number): number {
  return isRecoveredOutcome(outcome) ? Math.max(0, amountMinor) : 0;
}

/** Human-readable accounting table (used in docs/traces). */
export const RECOVERY_ACCOUNTING_RULES: Array<{ event: string; recovered: boolean }> = [
  { event: "capture succeeded", recovered: true },
  { event: "webhook payment.captured (verified)", recovered: true },
  { event: "payment link created", recovered: false },
  { event: "payment link expired/failed", recovered: false },
  { event: "provider timeout", recovered: false },
  { event: "duplicate execution/webhook", recovered: false },
  { event: "provider capability error", recovered: false },
];
