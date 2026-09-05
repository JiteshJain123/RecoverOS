/**
 * @recoveros/evaluation
 *
 * Offline evaluation of recovery decisions against synthetic datasets with
 * known ground truth, comparing the AI-assisted system to a non-AI baseline
 * (see docs/ARCHITECTURE.md §12). Works with the simulator, which generates the
 * datasets.
 *
 * SCAFFOLD ONLY: the metric computations are not implemented yet.
 */

/** Metrics reported per evaluation run. */
export interface EvaluationMetrics {
  /** Of the cases we acted on, fraction that were genuinely recoverable. */
  precision: number;
  /** Of genuinely recoverable cases, fraction we acted on. */
  recall: number;
  /** Cost/harm incurred by acting on non-recoverable cases. */
  falsePositiveCost: number;
  /** Fraction of at-risk cases actually recovered. */
  recoveryRate: number;
  /** Total (simulated) recovered revenue, in minor currency units. */
  recoveredRevenueMinor: number;
}

/** Ground-truth-labeled outcome for a single synthetic case. */
export interface LabeledCaseOutcome {
  caseId: string;
  recoverable: boolean;
  actedOn: boolean;
  recovered: boolean;
  amountMinor: number;
}

export class EvaluationNotConfiguredError extends Error {
  constructor() {
    super("Evaluation engine is not implemented yet (Phase 9). See docs/ARCHITECTURE.md §12.");
    this.name = "EvaluationNotConfiguredError";
  }
}

/** Compute evaluation metrics from labeled outcomes. Not implemented yet. */
export function computeMetrics(_outcomes: LabeledCaseOutcome[]): EvaluationMetrics {
  throw new EvaluationNotConfiguredError();
}
