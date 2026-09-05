/**
 * GeminiRecoveryStrategyProvider — implements the Phase 3
 * `RecoveryStrategyProvider` interface, backed by Google Gemini.
 *
 * Flow: minimal prompt → Gemini structured output → schema validation →
 * enrichment into a strict RecoveryPlan → RecoveryPlan validation. Gemini is
 * advisory: it chooses a STRATEGY and explains it. The concrete bounded actions
 * (amounts, currency, capabilities, idempotency keys) are assembled
 * DETERMINISTICALLY from trusted context, so the model can never invent
 * financial facts, and the resulting plan is always schema-valid or rejected.
 *
 * Safety guardrails applied here:
 *  - low-confidence actionable recommendations are downgraded to HUMAN_REVIEW;
 *  - only whitelisted context reaches the model (see prompt.ts);
 *  - retries happen ONLY for safe transport/timeout failures, never for
 *    malformed output and never for anything financial (nothing is executed).
 */
import {
  CAPABILITY,
  TTL_SECONDS,
  generateIdempotencyKey,
  validateRecoveryPlan,
  type ProposedRecoveryAction,
  type RecoveryPlan,
  type RecoveryStrategyContext,
  type RecoveryStrategyProvider,
  type StoppingCondition,
  type Strategy,
} from "@recoveros/strategy";
import { GeminiError, GeminiMalformedOutputError } from "./errors";
import type { GeminiClient } from "./client";
import { geminiOutputSchema, geminiResponseSchema, type GeminiOutput } from "./output-schema";
import { buildSystemInstruction, buildUserPrompt, type GeminiPromptInput } from "./prompt";

/** Strategies that move money / contact customers (i.e. not terminal-safe). */
const ACTIONABLE_STRATEGIES: ReadonlySet<Strategy> = new Set([
  "RETRY_PAYMENT",
  "SEND_PAYMENT_LINK",
  "CHECKOUT_RECOVERY",
  "CUSTOMER_REMINDER",
]);

export interface GeminiProviderConfig {
  /** Total attempts for safe/retryable client failures (>=1). Default 3. */
  maxAttempts: number;
  /** Actionable recommendations below this confidence become HUMAN_REVIEW. */
  lowConfidenceFloor: number;
  /** Whether the underlying generation is deterministic (temperature 0). */
  deterministic: boolean;
}

export const DEFAULT_GEMINI_PROVIDER_CONFIG: GeminiProviderConfig = {
  maxAttempts: 3,
  lowConfidenceFloor: 0.4,
  deterministic: true,
};

export interface GeminiProviderDeps {
  client: GeminiClient;
  config?: Partial<GeminiProviderConfig>;
  /** Injectable millisecond clock for latency (defaults to Date.now). */
  now?: () => number;
}

/** Non-secret metadata about a single Gemini generation, for AgentRun records. */
export interface GeminiCallMeta {
  provider: "gemini";
  model: string;
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  attempts: number;
  coercedToHumanReview: boolean;
}

export interface GeminiRecommendation {
  plan: RecoveryPlan;
  /** The validated raw model output (concise; no hidden chain-of-thought). */
  raw: GeminiOutput;
  meta: GeminiCallMeta;
}

export class GeminiRecoveryStrategyProvider implements RecoveryStrategyProvider {
  readonly name = "gemini";
  private readonly client: GeminiClient;
  private readonly config: GeminiProviderConfig;
  private readonly now: () => number;

  constructor(deps: GeminiProviderDeps) {
    this.client = deps.client;
    this.config = { ...DEFAULT_GEMINI_PROVIDER_CONFIG, ...deps.config };
    this.now = deps.now ?? Date.now;
  }

  /** Non-secret model id (from GEMINI_MODEL via the client). */
  get modelId(): string {
    return this.client.model;
  }

  /** RecoveryStrategyProvider surface: returns just the validated plan. */
  async generatePlan(ctx: RecoveryStrategyContext): Promise<RecoveryPlan> {
    return (await this.recommend({ ctx })).plan;
  }

  /**
   * Full recommendation including raw output + call metadata, used by the
   * orchestrator to populate AgentRun/AgentToolCall.
   */
  async recommend(input: GeminiPromptInput): Promise<GeminiRecommendation> {
    const req = {
      systemInstruction: buildSystemInstruction(),
      prompt: buildUserPrompt(input),
      responseSchema: geminiResponseSchema,
    };

    const startedAt = this.now();
    let attempts = 0;
    let response;
    // Retry ONLY safe transport/timeout failures. Never retry malformed output,
    // config errors, or anything financial (nothing here executes money).
    for (;;) {
      attempts += 1;
      try {
        response = await this.client.generate(req);
        break;
      } catch (err) {
        const retryable = err instanceof GeminiError && err.retryable;
        if (retryable && attempts < this.config.maxAttempts) continue;
        throw err;
      }
    }
    const latencyMs = Math.max(0, this.now() - startedAt);

    // Parse + schema-validate the model's JSON.
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(response.text);
    } catch {
      throw new GeminiMalformedOutputError("Gemini output was not valid JSON.");
    }
    const parsed = geminiOutputSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new GeminiMalformedOutputError(
        "Gemini output did not match the required schema.",
        parsed.error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message })),
      );
    }

    const { plan, coerced } = this.toRecoveryPlan(input.ctx, parsed.data, latencyMs);

    // Final gate: the enriched plan MUST satisfy the strict RecoveryPlan schema.
    const validation = validateRecoveryPlan(plan);
    if (!validation.valid) {
      throw new GeminiMalformedOutputError(
        "Enriched Gemini plan failed RecoveryPlan validation.",
        validation.issues,
      );
    }

    return {
      plan: validation.plan,
      raw: parsed.data,
      meta: {
        provider: "gemini",
        model: this.client.model,
        requestId: response.requestId,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        latencyMs,
        attempts,
        coercedToHumanReview: coerced,
      },
    };
  }

  /** Enrich the model's strategy choice into a deterministic, safe RecoveryPlan. */
  private toRecoveryPlan(
    ctx: RecoveryStrategyContext,
    out: GeminiOutput,
    latencyMs: number,
  ): { plan: RecoveryPlan; coerced: boolean } {
    // Guardrail: low-confidence actionable advice is downgraded to HUMAN_REVIEW.
    let strategy: Strategy = out.recommendation;
    let coerced = false;
    if (ACTIONABLE_STRATEGIES.has(strategy) && out.confidence < this.config.lowConfidenceFloor) {
      strategy = "HUMAN_REVIEW";
      coerced = true;
    }

    const proposedActions = this.buildActions(ctx, strategy);
    const stoppingConditions = this.stoppingConditionsFor(strategy);

    const evidence = [
      { label: "rootCause", detail: ctx.rootCause ?? "UNCLASSIFIED", source: "intelligence" as const },
      { label: "severity", detail: ctx.severity ?? "UNKNOWN", source: "intelligence" as const },
      {
        label: "amountAtRisk",
        detail: `${ctx.amountAtRiskMinor} ${ctx.currency} (minor units)`,
        source: "intelligence" as const,
      },
      { label: "retryCount", detail: String(ctx.retryCount), source: "payment" as const },
      { label: "gemini-rationale", detail: out.rationale.slice(0, 500), source: "rule" as const },
      ...out.evidenceRefs.slice(0, 10).map((ref) => ({
        label: "evidence-ref",
        detail: ref.slice(0, 200),
        source: "rule" as const,
      })),
    ];
    if (coerced) {
      evidence.push({
        label: "guardrail",
        detail: `Downgraded ${out.recommendation} → HUMAN_REVIEW (confidence ${out.confidence} < ${this.config.lowConfidenceFloor}).`,
        source: "rule" as const,
      });
    }

    const plan: RecoveryPlan = {
      caseId: ctx.caseId,
      strategy,
      rationale: out.rationale,
      confidence: coerced ? Math.min(out.confidence, 0.5) : out.confidence,
      expectedOutcome: {
        successProbability: coerced ? 0 : out.expectedOutcome.successProbability,
        description: out.expectedOutcome.description,
        revenueRecoverableMinor: strategy === "NO_ACTION" ? 0 : ctx.amountAtRiskMinor,
      },
      riskLevel: coerced ? "HIGH" : out.riskLevel,
      proposedActions,
      stoppingConditions,
      evidence,
      modelMetadata: {
        provider: "gemini",
        strategyEngine: "gemini",
        version: this.client.model,
        deterministic: this.config.deterministic,
        latencyMs,
      },
      generatedAt: new Date(this.now()).toISOString(),
    };
    return { plan, coerced };
  }

  /** Deterministically assemble the bounded actions for a chosen strategy. */
  private buildActions(ctx: RecoveryStrategyContext, strategy: Strategy): ProposedRecoveryAction[] {
    const key = (actionKind: ProposedRecoveryAction["actionKind"]): string =>
      generateIdempotencyKey({
        tenantId: ctx.tenantId,
        caseId: ctx.caseId,
        actionKind,
        rootCause: ctx.rootCause,
        amountMinor: ctx.amountAtRiskMinor,
        retryCount: ctx.retryCount,
      });

    switch (strategy) {
      case "NO_ACTION":
        return [];
      case "HUMAN_REVIEW":
        return [
          {
            actionKind: "FLAG_FOR_HUMAN_REVIEW",
            purpose: "Route the case to a human for a manual recovery decision.",
            requiredCapability: CAPABILITY.HUMAN_REVIEW,
            riskLevel: "HIGH",
            idempotencyKey: key("FLAG_FOR_HUMAN_REVIEW"),
            stoppingCondition: { type: "HUMAN_DECISION_REQUIRED", description: "Awaiting a human decision." },
          },
        ];
      case "RETRY_PAYMENT":
        return [
          {
            actionKind: "RETRY_PAYMENT",
            purpose: "Re-attempt the charge (transient failure).",
            amountMinor: ctx.amountAtRiskMinor,
            currency: ctx.currency,
            requiredCapability: CAPABILITY.RETRY_PAYMENT,
            riskLevel: "LOW",
            ttlSeconds: TTL_SECONDS.retry,
            idempotencyKey: key("RETRY_PAYMENT"),
            stoppingCondition: { type: "MAX_ATTEMPTS", description: "Stop at the retry cap.", limit: 3 },
          },
        ];
      case "SEND_PAYMENT_LINK":
        return [
          {
            actionKind: "CREATE_PAYMENT_LINK",
            purpose: "Offer an alternate payment method via a fresh link.",
            amountMinor: ctx.amountAtRiskMinor,
            currency: ctx.currency,
            requiredCapability: CAPABILITY.CREATE_PAYMENT_LINK,
            riskLevel: "MEDIUM",
            ttlSeconds: TTL_SECONDS.paymentLink,
            idempotencyKey: key("CREATE_PAYMENT_LINK"),
            stoppingCondition: { type: "TTL_EXPIRED", description: "Payment link expires; stop if unpaid." },
          },
        ];
      case "CHECKOUT_RECOVERY": {
        const actions: ProposedRecoveryAction[] = [
          {
            actionKind: "CREATE_PAYMENT_LINK",
            purpose: "Send a fresh checkout link to recover an abandoned/expired checkout.",
            amountMinor: ctx.amountAtRiskMinor,
            currency: ctx.currency,
            requiredCapability: CAPABILITY.CREATE_PAYMENT_LINK,
            riskLevel: "MEDIUM",
            ttlSeconds: TTL_SECONDS.paymentLink,
            idempotencyKey: key("CREATE_PAYMENT_LINK"),
            stoppingCondition: { type: "TTL_EXPIRED", description: "Fresh link expires; stop if unpaid." },
          },
        ];
        if (ctx.hasContactChannel) {
          actions.push({
            actionKind: "SEND_CUSTOMER_MESSAGE",
            purpose: "Nudge the customer to complete the abandoned checkout.",
            requiredCapability: CAPABILITY.NOTIFY_CUSTOMER,
            riskLevel: "LOW",
            ttlSeconds: TTL_SECONDS.reminder,
            idempotencyKey: key("SEND_CUSTOMER_MESSAGE"),
            stoppingCondition: { type: "CUSTOMER_OPT_OUT", description: "Stop if the customer opts out." },
          });
        }
        return actions;
      }
      case "CUSTOMER_REMINDER":
        return [
          {
            actionKind: "SEND_CUSTOMER_MESSAGE",
            purpose: "Remind the customer their payment failed and invite them to retry.",
            requiredCapability: CAPABILITY.NOTIFY_CUSTOMER,
            riskLevel: "LOW",
            ttlSeconds: TTL_SECONDS.reminder,
            idempotencyKey: key("SEND_CUSTOMER_MESSAGE"),
            stoppingCondition: { type: "CUSTOMER_OPT_OUT", description: "Stop if the customer opts out." },
          },
          {
            actionKind: "CREATE_PAYMENT_LINK",
            purpose: "Give the customer a link to complete payment once funds are available.",
            amountMinor: ctx.amountAtRiskMinor,
            currency: ctx.currency,
            requiredCapability: CAPABILITY.CREATE_PAYMENT_LINK,
            riskLevel: "MEDIUM",
            ttlSeconds: TTL_SECONDS.paymentLink,
            idempotencyKey: key("CREATE_PAYMENT_LINK"),
            stoppingCondition: { type: "TTL_EXPIRED", description: "Payment link expires; stop if unpaid." },
          },
        ];
      default:
        return [];
    }
  }

  /** Canonical, always-valid stopping conditions for a strategy. */
  private stoppingConditionsFor(strategy: Strategy): StoppingCondition[] {
    switch (strategy) {
      case "NO_ACTION":
        return [{ type: "POLICY_BLOCK", description: "No action proposed for this case." }];
      case "HUMAN_REVIEW":
        return [{ type: "HUMAN_DECISION_REQUIRED", description: "Stop until a human decides." }];
      case "RETRY_PAYMENT":
        return [
          { type: "PAYMENT_RECOVERED", description: "Stop once the payment succeeds." },
          { type: "MAX_ATTEMPTS", description: "Stop at the retry cap.", limit: 3 },
          { type: "TTL_EXPIRED", description: "Stop if the retry window elapses." },
        ];
      default:
        return [
          { type: "PAYMENT_RECOVERED", description: "Stop once the payment succeeds." },
          { type: "TTL_EXPIRED", description: "Stop when the link/window expires." },
          { type: "CUSTOMER_OPT_OUT", description: "Stop if the customer opts out." },
        ];
    }
  }
}
