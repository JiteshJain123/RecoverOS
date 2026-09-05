/**
 * Deterministic synthetic dataset for the runnable batch evaluation and pipeline
 * tests. It mirrors the SHAPE and distribution of the seeded recovery cases
 * (varied root causes, amounts, retry counts, and some already-recovered /
 * high-amount cases) so the pipeline exercises ALLOW / REVIEW / BLOCK paths —
 * WITHOUT requiring a database. Fully reproducible (fixed PRNG, fixed order).
 *
 * This is synthetic data only: no real customers, no real money, no PSP.
 */
import type { PolicyLimits } from "@recoveros/policy";
import type { RecoveryStrategyContext, StrategySignal } from "@recoveros/strategy";
import type { PipelineCase } from "./pipeline";
import type { ExecCaseRecord } from "./store";

/** mulberry32 — tiny deterministic PRNG. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const ROOT_CAUSES = [
  "TIMEOUT",
  "GATEWAY_ERROR",
  "BANK_DECLINE",
  "INSUFFICIENT_FUNDS",
  "CUSTOMER_ABANDONMENT",
  "EXPIRED_CHECKOUT",
  "UNKNOWN",
] as const;

const AMOUNTS = [200_000, 500_000, 800_000, 1_200_000, 1_800_000, 2_500_000];

/** The active policy applied across the synthetic tenant. */
export const SYNTHETIC_POLICY: { version: number; limits: PolicyLimits } = {
  version: 2,
  limits: {
    maxRetryAmountMinor: 1_500_000,
    reviewAmountMinor: 1_000_000,
    minConfidence: 0.5,
    maxRetriesPerCase: 2,
    allowedActions: ["RETRY_PAYMENT", "SEND_PAYMENT_LINK", "CONTACT_CUSTOMER"],
  },
};

export interface SyntheticDataset {
  cases: PipelineCase[];
  execCases: ExecCaseRecord[];
}

/**
 * Build a deterministic dataset of `count` cases for `tenantId`, relative to
 * the fixed reference instant `now`.
 */
export function buildSyntheticDataset(
  tenantId: string,
  count = 40,
  now: Date = new Date("2026-09-04T00:00:00.000Z"),
): SyntheticDataset {
  const rng = makeRng(0x5eed_c0de ^ hashStr(tenantId));
  const cases: PipelineCase[] = [];
  const execCases: ExecCaseRecord[] = [];

  for (let i = 0; i < count; i++) {
    const n = i + 1;
    const id = `syn_case_${tenantId}_${String(n).padStart(3, "0")}`;
    const rootCause = ROOT_CAUSES[i % ROOT_CAUSES.length] as (typeof ROOT_CAUSES)[number];
    const amountAtRiskMinor = AMOUNTS[Math.floor(rng() * AMOUNTS.length)] as number;
    const retryCount = Math.floor(rng() * 3); // 0..2
    const alreadyRecovered = rng() < 0.12; // ~1 in 8 already recovered
    const critical = rng() < 0.15;

    const paymentStatus = alreadyRecovered ? "CAPTURED" : "FAILED";
    const severity: StrategySignal["severity"] = critical ? "CRITICAL" : retryCount >= 2 ? "HIGH" : "MEDIUM";
    const hasExpiredLink = rootCause === "EXPIRED_CHECKOUT";

    const signals: StrategySignal[] = [
      {
        type: rootCause === "TIMEOUT" ? "BANK_TIMEOUT" : "FAILED_PAYMENT",
        severity,
        rootCause,
        confidence: 0.9,
        reason: `${rootCause} detected`,
      },
    ];

    const strategyContext: RecoveryStrategyContext = {
      caseId: id,
      tenantId,
      caseStatus: alreadyRecovered ? "RECOVERED" : "DETECTED",
      paymentStatus,
      reason: rootCause === "CUSTOMER_ABANDONMENT" || rootCause === "EXPIRED_CHECKOUT" ? "ABANDONED_CHECKOUT" : "FAILED_PAYMENT",
      rootCause,
      severity,
      priorityScore: 40 + (i % 50),
      amountAtRiskMinor,
      currency: "INR",
      paymentId: `syn_pay_${tenantId}_${n}`,
      customerId: `syn_cust_${tenantId}_${(i % 10) + 1}`,
      retryCount,
      hasContactChannel: true,
      hasExpiredLink,
      policyState: "OK",
      signals,
    };

    const openedAt = new Date(now.getTime() - (2 + (i % 5)) * 24 * 3600 * 1000); // 2..6 days old

    cases.push({
      strategyContext,
      policyCase: {
        id,
        tenantId,
        status: alreadyRecovered ? "RECOVERED" : "DETECTED",
        rootCause,
        severity,
        amountAtRiskMinor,
        currency: "INR",
        retryCount,
        openedAt,
        expiresAt: null,
      },
      paymentContext: {
        paymentStatus,
        alreadyRecovered,
        usedIdempotencyKeys: [],
      },
      policy: SYNTHETIC_POLICY,
    });

    execCases.push({
      id,
      tenantId,
      status: alreadyRecovered ? "RECOVERED" : "DETECTED",
      amountAtRiskMinor,
      currency: "INR",
      resolvedAt: null,
    });
  }

  return { cases, execCases };
}

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
