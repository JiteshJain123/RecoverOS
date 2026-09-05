/**
 * Test-only helpers: a scripted mock GeminiClient (no network, no API key) and
 * a RecoveryStrategyContext factory. Not exported from the package barrel.
 */
import type { RecoveryStrategyContext } from "@recoveros/strategy";
import type { GeminiClient, GeminiGenerateRequest, GeminiGenerateResponse } from "./client";
import type { GeminiOutput } from "./output-schema";

/** A scripted step: return raw text, or throw the given error. */
export type MockStep =
  | { kind: "text"; text: string; requestId?: string; inputTokens?: number; outputTokens?: number }
  | { kind: "throw"; error: unknown };

/** Mock client that records requests and plays a script of responses/errors. */
export class MockGeminiClient implements GeminiClient {
  readonly model: string;
  readonly requests: GeminiGenerateRequest[] = [];
  private readonly script: MockStep[];
  private i = 0;

  constructor(script: MockStep[], model = "gemini-3.5-flash") {
    this.script = script;
    this.model = model;
  }

  get callCount(): number {
    return this.requests.length;
  }

  async generate(req: GeminiGenerateRequest): Promise<GeminiGenerateResponse> {
    this.requests.push(req);
    const step = this.script[Math.min(this.i, this.script.length - 1)];
    this.i += 1;
    if (!step) throw new Error("mock has no scripted step");
    if (step.kind === "throw") throw step.error;
    return {
      text: step.text,
      requestId: step.requestId,
      usage: { inputTokens: step.inputTokens, outputTokens: step.outputTokens },
    };
  }
}

/** Build a valid GeminiOutput JSON string with overrides. */
export function outputJson(over: Partial<GeminiOutput> = {}): string {
  const out: GeminiOutput = {
    recommendation: over.recommendation ?? "RETRY_PAYMENT",
    rationale: over.rationale ?? "Transient timeout; a bounded retry is warranted.",
    evidenceRefs: over.evidenceRefs ?? ["signal:BANK_TIMEOUT", "retryCount:1"],
    confidence: over.confidence ?? 0.8,
    riskLevel: over.riskLevel ?? "LOW",
    expectedOutcome: over.expectedOutcome ?? {
      successProbability: 0.6,
      description: "Retries often succeed for transient failures.",
    },
    proposedActionKinds: over.proposedActionKinds ?? ["RETRY_PAYMENT"],
    stoppingConditions: over.stoppingConditions ?? [
      { type: "PAYMENT_RECOVERED", description: "Stop on success." },
    ],
  };
  return JSON.stringify(out);
}

export function strategyCtx(
  over: Partial<RecoveryStrategyContext> = {},
): RecoveryStrategyContext {
  return {
    caseId: over.caseId ?? "case_1",
    tenantId: over.tenantId ?? "tenant_a",
    caseStatus: over.caseStatus ?? "DETECTED",
    paymentStatus: over.paymentStatus ?? "FAILED",
    reason: over.reason ?? "FAILED_PAYMENT",
    rootCause: over.rootCause ?? "TIMEOUT",
    severity: over.severity ?? "MEDIUM",
    priorityScore: over.priorityScore ?? 40,
    amountAtRiskMinor: over.amountAtRiskMinor ?? 500_000,
    currency: over.currency ?? "INR",
    paymentId: over.paymentId ?? "pay_1",
    customerId: over.customerId ?? "cust_1",
    retryCount: over.retryCount ?? 1,
    hasContactChannel: over.hasContactChannel ?? true,
    hasExpiredLink: over.hasExpiredLink ?? false,
    policyState: over.policyState ?? "OK",
    signals: over.signals ?? [
      { type: "BANK_TIMEOUT", severity: "MEDIUM", rootCause: "TIMEOUT", confidence: 0.9, reason: "bank timed out" },
    ],
    previousStrategy: over.previousStrategy,
  };
}
