/**
 * Explainable, deterministic priority scoring.
 *
 * The score is a transparent weighted sum of normalized inputs — NOT a
 * black-box ML model. Every component (its raw input, normalized value, weight
 * and point contribution) is returned so the dashboard can answer
 * "why is this case high priority?".
 *
 *   score = 100 * Σ (weightᵢ · valueᵢ)     valueᵢ ∈ [0,1],  Σ weightᵢ = 1
 *
 * Inputs:
 *   - amount    : amount at risk, normalized against a cap
 *   - severity  : max signal severity (LOW..CRITICAL → 0.25..1.0)
 *   - retry     : failed-attempt count, normalized against a cap
 *   - recency   : linear decay of the payment's age (newer = higher)
 *   - customer  : customer's prior successful-payment history (value at stake)
 */
import { SCORE_NORMALIZERS, SCORE_WEIGHTS, SCORING_FORMULA_VERSION } from "../config";
import type {
  NormalizedPayment,
  PriorityComponent,
  PriorityScore,
  RiskSignal,
  Severity,
} from "./types";
import { SEVERITY_RANK } from "./types";

/** Customer history used as a scoring input (provider-agnostic aggregates). */
export interface CustomerHistory {
  /** Count of previously captured (successful) payments by this customer. */
  successfulPayments: number;
  /** Total captured amount (minor units) — value of the relationship. */
  totalCapturedMinor: number;
}

export interface ScoreContext {
  now: Date;
  customerHistory: CustomerHistory;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const HOUR_MS = 3_600_000;

function maxSeverity(signals: RiskSignal[]): Severity {
  let best: Severity = "LOW";
  for (const s of signals) {
    if (SEVERITY_RANK[s.severity] > SEVERITY_RANK[best]) best = s.severity;
  }
  return best;
}

/**
 * Compute the priority score for a payment given its signals and context.
 * Deterministic: identical inputs always yield an identical score + breakdown.
 */
export function computePriority(
  payment: NormalizedPayment,
  signals: RiskSignal[],
  ctx: ScoreContext,
): PriorityScore {
  // amount: at-risk value vs cap.
  const amountValue = clamp01(payment.amountMinor / SCORE_NORMALIZERS.amountCapMinor);

  // severity: max signal severity mapped to [0.25, 1].
  const sev = maxSeverity(signals);
  const severityValue = SEVERITY_RANK[sev] / 4;

  // retry: failed attempts vs cap.
  const retryValue = clamp01(payment.retryCount / SCORE_NORMALIZERS.retryCap);

  // recency: linear decay over the decay window (newer → closer to 1).
  const ageHours = Math.max(0, (ctx.now.getTime() - payment.createdAt.getTime()) / HOUR_MS);
  const recencyValue = clamp01(1 - ageHours / SCORE_NORMALIZERS.recencyDecayHours);

  // customer: prior successful payments vs cap (loyal/valuable customers first).
  const customerValue = clamp01(
    ctx.customerHistory.successfulPayments / SCORE_NORMALIZERS.customerHistoryCap,
  );

  const raw: Array<Omit<PriorityComponent, "contribution">> = [
    {
      key: "amount",
      label: "Amount at risk",
      value: amountValue,
      weight: SCORE_WEIGHTS.amount,
      detail: `${payment.amountMinor} ${payment.currency} (minor) vs cap ${SCORE_NORMALIZERS.amountCapMinor}`,
    },
    {
      key: "severity",
      label: "Failure severity",
      value: severityValue,
      weight: SCORE_WEIGHTS.severity,
      detail: `max signal severity = ${sev}`,
    },
    {
      key: "retry",
      label: "Retry history",
      value: retryValue,
      weight: SCORE_WEIGHTS.retry,
      detail: `${payment.retryCount} failed attempt(s) vs cap ${SCORE_NORMALIZERS.retryCap}`,
    },
    {
      key: "recency",
      label: "Recency",
      value: recencyValue,
      weight: SCORE_WEIGHTS.recency,
      detail: `${Math.floor(ageHours)}h old; decays over ${SCORE_NORMALIZERS.recencyDecayHours}h`,
    },
    {
      key: "customer",
      label: "Customer history",
      value: customerValue,
      weight: SCORE_WEIGHTS.customer,
      detail: `${ctx.customerHistory.successfulPayments} prior successful payment(s)`,
    },
  ];

  const components: PriorityComponent[] = raw.map((c) => ({
    ...c,
    contribution: Math.round(c.value * c.weight * 100),
  }));

  // Score from the exact (unrounded) weighted sum, then round once.
  const exact = raw.reduce((sum, c) => sum + c.value * c.weight, 0) * 100;
  const score = Math.round(clamp01(exact / 100) * 100);

  return { score, components, formulaVersion: SCORING_FORMULA_VERSION };
}
