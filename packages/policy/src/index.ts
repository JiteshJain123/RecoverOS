/**
 * @recoveros/policy
 *
 * Deterministic financial authorization engine — the single gate that decides
 * whether a proposed recovery action may execute. PURE: no network, no LLM, no
 * randomness, no clock reads except those passed in. The same input always
 * produces the same decision so every authorization is testable, replayable and
 * auditable (see docs/ARCHITECTURE.md §7–§8).
 *
 * SECURITY INVARIANT: a strategy provider (Gemini or deterministic) may only
 * PROPOSE. Only this engine may AUTHORIZE. This package must never import the AI
 * or payments packages, and never executes anything itself.
 */
export {
  PolicyEvaluator,
  strategyToActionType,
} from "./evaluator";
export type {
  PolicyDecision,
  PolicyDecisionType,
  PolicyEvaluationInput,
  PolicyCaseView,
  PolicyPaymentContext,
} from "./evaluator";
export {
  resolvePolicyConfig,
  DEFAULT_POLICY_CONFIG,
} from "./config";
export type { PolicyConfig, PolicyLimits, PolicyActionType } from "./config";
