/**
 * Strict, provider-neutral schema for the Recovery Strategy Engine's output.
 *
 * The `RecoveryPlan` is the ONLY thing a strategy provider (deterministic today,
 * Gemini later) may emit. It is a *recommendation*, never an authorization and
 * never an execution: it carries no ability to move money. Downstream, the
 * deterministic policy engine decides whether any proposed action is allowed,
 * and only an approved action can eventually reach a payment-provider adapter.
 *
 * MONEY: every monetary field is an integer in MINOR currency units (e.g. paise)
 * and is suffixed `Minor`. Currencies are ISO-4217 alpha-3 codes.
 *
 * The schema is defined with zod so the same definition both *types* the plan
 * and *validates* it at the execution boundary (see {@link validateRecoveryPlan}).
 * Refinements below encode the invariants that keep a malformed or internally
 * inconsistent plan out of the execution layer.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * Supported recovery strategies. A strategy is an *intent*; it does not imply
 * that a given provider can execute it (that is decided later by capability +
 * policy). `HUMAN_REVIEW` and `NO_ACTION` are always safe terminal choices.
 */
export const STRATEGIES = [
  "NO_ACTION",
  "RETRY_PAYMENT",
  "SEND_PAYMENT_LINK",
  "CHECKOUT_RECOVERY",
  "CUSTOMER_REMINDER",
  "HUMAN_REVIEW",
] as const;
export const strategySchema = z.enum(STRATEGIES);
export type Strategy = (typeof STRATEGIES)[number];

/**
 * The bounded set of executable action primitives a plan may propose. These are
 * deliberately smaller/more concrete than strategies: one strategy may expand
 * into several actions (e.g. CHECKOUT_RECOVERY → CREATE_PAYMENT_LINK + message).
 */
export const ACTION_KINDS = [
  "RETRY_PAYMENT",
  "CREATE_PAYMENT_LINK",
  "SEND_CUSTOMER_MESSAGE",
  "FLAG_FOR_HUMAN_REVIEW",
  "NONE",
] as const;
export const actionKindSchema = z.enum(ACTION_KINDS);
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Risk of performing the intervention itself (not the risk of the case). */
export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const riskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Machine-readable reasons an action/plan must stop. */
export const STOPPING_CONDITION_TYPES = [
  "PAYMENT_RECOVERED",
  "MAX_ATTEMPTS",
  "TTL_EXPIRED",
  "POLICY_BLOCK",
  "HUMAN_DECISION_REQUIRED",
  "CUSTOMER_OPT_OUT",
  "AMOUNT_CEILING",
] as const;
export const stoppingConditionTypeSchema = z.enum(STOPPING_CONDITION_TYPES);
export type StoppingConditionType = (typeof STOPPING_CONDITION_TYPES)[number];

/** Where a piece of supporting evidence came from. */
export const EVIDENCE_SOURCES = ["intelligence", "policy", "payment", "rule"] as const;
export const evidenceSourceSchema = z.enum(EVIDENCE_SOURCES);
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "currency must be an ISO-4217 alpha-3 code");

export const stoppingConditionSchema = z
  .object({
    type: stoppingConditionTypeSchema,
    description: z.string().min(1),
    /** Numeric bound where relevant (e.g. MAX_ATTEMPTS limit). */
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type StoppingCondition = z.infer<typeof stoppingConditionSchema>;

export const evidenceItemSchema = z
  .object({
    label: z.string().min(1),
    detail: z.string().min(1),
    source: evidenceSourceSchema,
  })
  .strict();
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const expectedOutcomeSchema = z
  .object({
    /** Deterministic heuristic estimate in [0, 1]; NOT a model probability. */
    successProbability: z.number().min(0).max(1),
    description: z.string().min(1),
    /** Revenue (minor units) this plan could recover if it succeeds. */
    revenueRecoverableMinor: z.number().int().nonnegative(),
  })
  .strict();
export type ExpectedOutcome = z.infer<typeof expectedOutcomeSchema>;

export const modelMetadataSchema = z
  .object({
    /** Which kind of provider produced this plan. */
    provider: z.enum(["deterministic", "gemini"]),
    /** Human-readable engine label (e.g. "deterministic-rules"). */
    strategyEngine: z.string().min(1),
    /** Ruleset / model version stamp. */
    version: z.string().min(1),
    /** True when the same input always yields the same plan. */
    deterministic: z.boolean(),
    /** The specific rule that fired (deterministic provider only). */
    ruleId: z.string().min(1).optional(),
    /** Wall-clock cost of generation, if measured. */
    latencyMs: z.number().nonnegative().optional(),
  })
  .strict();
export type ModelMetadata = z.infer<typeof modelMetadataSchema>;

export const proposedActionSchema = z
  .object({
    actionKind: actionKindSchema,
    /** Why this action exists — one clear sentence. */
    purpose: z.string().min(1),
    /** Amount in minor units, when the action moves/quotes money. */
    amountMinor: z.number().int().nonnegative().optional(),
    /** ISO-4217 currency, when `amountMinor` is present. */
    currency: currencySchema.optional(),
    /** Provider capability this action would require to execute. */
    requiredCapability: z.string().min(1),
    /** Risk of performing this action. */
    riskLevel: riskLevelSchema,
    /** Optional time-to-live (seconds) after which the action must not run. */
    ttlSeconds: z.number().int().positive().optional(),
    /** Deterministic key that makes execution idempotent (at-most-once). */
    idempotencyKey: z.string().min(1),
    /** The primary condition under which this action must stop. */
    stoppingCondition: stoppingConditionSchema,
  })
  .strict();
export type ProposedRecoveryAction = z.infer<typeof proposedActionSchema>;

// ---------------------------------------------------------------------------
// RecoveryPlan
// ---------------------------------------------------------------------------

/** Action kinds that move/quote money and therefore MUST carry amount+currency. */
const MONEY_BEARING_ACTIONS: ReadonlySet<ActionKind> = new Set([
  "RETRY_PAYMENT",
  "CREATE_PAYMENT_LINK",
]);

/** For each strategy, an action kind the plan MUST contain to be coherent. */
const REQUIRED_ACTION_FOR_STRATEGY: Partial<Record<Strategy, ActionKind>> = {
  RETRY_PAYMENT: "RETRY_PAYMENT",
  SEND_PAYMENT_LINK: "CREATE_PAYMENT_LINK",
  CHECKOUT_RECOVERY: "CREATE_PAYMENT_LINK",
  CUSTOMER_REMINDER: "SEND_CUSTOMER_MESSAGE",
  HUMAN_REVIEW: "FLAG_FOR_HUMAN_REVIEW",
};

export const recoveryPlanSchema = z
  .object({
    caseId: z.string().min(1),
    strategy: strategySchema,
    rationale: z.string().min(1),
    /** Engine confidence in the *strategy choice*, in [0, 1]. */
    confidence: z.number().min(0).max(1),
    expectedOutcome: expectedOutcomeSchema,
    riskLevel: riskLevelSchema,
    proposedActions: z.array(proposedActionSchema),
    stoppingConditions: z.array(stoppingConditionSchema).min(1),
    /** Why the engine reached this plan — must never be empty (explainability). */
    evidence: z.array(evidenceItemSchema).min(1),
    modelMetadata: modelMetadataSchema,
    generatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    // 1) Idempotency keys must be unique within a plan.
    const keys = plan.proposedActions.map((a) => a.idempotencyKey);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    if (dupes.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposedActions"],
        message: `duplicate idempotencyKey(s): ${[...new Set(dupes)].join(", ")}`,
      });
    }

    // 2) NO_ACTION must not propose any executable action.
    if (plan.strategy === "NO_ACTION" && plan.proposedActions.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposedActions"],
        message: "NO_ACTION plans must not contain proposed actions",
      });
    }

    // 3) HUMAN_REVIEW must not smuggle a financial action past a human.
    if (plan.strategy === "HUMAN_REVIEW") {
      const financial = plan.proposedActions.find((a) => MONEY_BEARING_ACTIONS.has(a.actionKind));
      if (financial) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["proposedActions"],
          message: `HUMAN_REVIEW plans must not contain financial actions (${financial.actionKind})`,
        });
      }
    }

    // 4) Each non-trivial strategy must contain its defining action kind.
    const required = REQUIRED_ACTION_FOR_STRATEGY[plan.strategy];
    if (required && !plan.proposedActions.some((a) => a.actionKind === required)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposedActions"],
        message: `strategy ${plan.strategy} requires a ${required} action`,
      });
    }

    // 5) Money-bearing actions must carry a positive amount and a currency.
    plan.proposedActions.forEach((a, i) => {
      if (MONEY_BEARING_ACTIONS.has(a.actionKind)) {
        if (a.amountMinor === undefined || a.amountMinor <= 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["proposedActions", i, "amountMinor"],
            message: `${a.actionKind} requires a positive amountMinor`,
          });
        }
        if (!a.currency) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["proposedActions", i, "currency"],
            message: `${a.actionKind} requires a currency`,
          });
        }
      }
    });
  });

export type RecoveryPlan = z.infer<typeof recoveryPlanSchema>;

// ---------------------------------------------------------------------------
// Validation surface
// ---------------------------------------------------------------------------

export interface PlanValidationIssue {
  path: string;
  message: string;
}

export type ValidateResult =
  | { valid: true; plan: RecoveryPlan }
  | { valid: false; issues: PlanValidationIssue[] };

/** Thrown when an invalid plan is asserted at the execution boundary. */
export class RecoveryPlanValidationError extends Error {
  constructor(public readonly issues: PlanValidationIssue[]) {
    super(`RecoveryPlan failed validation: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.name = "RecoveryPlanValidationError";
  }
}

function toIssues(error: z.ZodError): PlanValidationIssue[] {
  return error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message }));
}

/**
 * Validate an untrusted object against the RecoveryPlan schema. Returns a
 * discriminated result rather than throwing, so callers can decide how to react
 * (the service turns a failure into a `recovery.strategy.rejected` audit event).
 */
export function validateRecoveryPlan(input: unknown): ValidateResult {
  const parsed = recoveryPlanSchema.safeParse(input);
  if (parsed.success) return { valid: true, plan: parsed.data };
  return { valid: false, issues: toIssues(parsed.error) };
}

/**
 * Assert a plan is valid, returning the typed plan or throwing
 * {@link RecoveryPlanValidationError}. Use this as the last gate before a plan
 * is allowed to enter the execution/authorization layer.
 */
export function assertValidRecoveryPlan(input: unknown): RecoveryPlan {
  const result = validateRecoveryPlan(input);
  if (!result.valid) throw new RecoveryPlanValidationError(result.issues);
  return result.plan;
}
