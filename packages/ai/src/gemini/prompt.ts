/**
 * Prompt construction for Gemini. The prompt contains only the MINIMUM context
 * needed to choose a recovery strategy, assembled from trusted deterministic
 * data. It NEVER contains API keys, database URLs, secrets, credentials, or
 * unnecessary personal data — the builder whitelists fields explicitly rather
 * than serializing whole objects.
 */
import { STRATEGIES, ACTION_KINDS, RISK_LEVELS, STOPPING_CONDITION_TYPES } from "@recoveros/strategy";
import type { RecoveryStrategyContext } from "@recoveros/strategy";

export interface CustomerRecoveryHistory {
  /** Count of prior successful (captured) payments — an aggregate, not PII. */
  successfulPayments: number;
  /** Total prior captured value (minor units) — an aggregate, not PII. */
  totalCapturedMinor: number;
}

export interface GeminiPromptInput {
  ctx: RecoveryStrategyContext;
  customerHistory?: CustomerRecoveryHistory;
  /** Compact, non-secret policy constraints (amount ceilings, retry caps, …). */
  policyConstraints?: Record<string, unknown>;
}

/**
 * The system instruction: role, hard guardrails, and output contract. This is
 * the single place we tell the model what it is and is NOT allowed to do.
 */
export function buildSystemInstruction(): string {
  return [
    "You are RecoverOS's payment-recovery RECOMMENDATION engine.",
    "",
    "You are advisory only. You CANNOT and MUST NOT:",
    "- authorize or execute any movement of money;",
    "- call any payment provider, send any customer message, or take any action;",
    "- exceed the provided policy limits/constraints;",
    "- invent payment amounts, currencies, customer information, or payment status;",
    "- use any fact that was not provided to you in the context.",
    "",
    "A separate deterministic policy engine decides whether your recommendation is",
    "allowed, and only then may an approved action be executed. Amounts, currency,",
    "and identifiers are filled from trusted data — do not restate or alter them.",
    "",
    "Decision guidance:",
    "- Return NO_ACTION when the evidence is insufficient or no safe intervention applies.",
    "- Prefer HUMAN_REVIEW for ambiguous, unusual, or high-risk/high-value cases.",
    "- Only reference evidence that appears in the provided context (evidenceRefs).",
    "",
    "Respond with a single JSON object matching the provided schema. Allowed values:",
    `- recommendation (strategy): ${STRATEGIES.join(", ")}`,
    `- proposedActionKinds: ${ACTION_KINDS.join(", ")}`,
    `- riskLevel: ${RISK_LEVELS.join(", ")}`,
    `- stoppingConditions[].type: ${STOPPING_CONDITION_TYPES.join(", ")}`,
    "Provide a concise rationale (no hidden step-by-step reasoning), a confidence in",
    "[0,1], an expected outcome, evidence references, and stopping conditions.",
  ].join("\n");
}

/**
 * The user prompt: a compact JSON block of whitelisted facts. Note the absence
 * of any secret, connection string, raw PII (email/phone/name), or provider key.
 */
export function buildUserPrompt(input: GeminiPromptInput): string {
  const { ctx } = input;

  const facts = {
    case: {
      caseId: ctx.caseId,
      status: ctx.caseStatus,
      reason: ctx.reason,
    },
    payment: {
      status: ctx.paymentStatus,
      failureCode: ctx.rootCause, // classified cause token (no raw provider text)
      retryCount: ctx.retryCount,
      hasExpiredLink: ctx.hasExpiredLink,
    },
    revenueAtRisk: {
      amountMinor: ctx.amountAtRiskMinor,
      currency: ctx.currency,
      severity: ctx.severity,
      priorityScore: ctx.priorityScore,
    },
    rootCause: ctx.rootCause,
    signals: ctx.signals.map((s) => ({
      type: s.type,
      severity: s.severity,
      rootCause: s.rootCause,
      confidence: s.confidence,
      reason: s.reason,
    })),
    customerRecoveryHistory: input.customerHistory
      ? {
          successfulPayments: input.customerHistory.successfulPayments,
          totalCapturedMinor: input.customerHistory.totalCapturedMinor,
        }
      : null,
    // Whether the customer is contactable — a boolean capability flag, not PII.
    customerContactable: ctx.hasContactChannel,
    policyConstraints: input.policyConstraints ?? { note: "no explicit policy constraints provided" },
  };

  return [
    "Recommend the single best bounded recovery strategy for this case.",
    "Context (the only facts you may use):",
    "```json",
    JSON.stringify(facts, null, 2),
    "```",
    "Return only the JSON object required by the schema.",
  ].join("\n");
}
