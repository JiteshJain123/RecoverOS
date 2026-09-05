/**
 * Frontend domain types for the RecoverOS Control Room.
 *
 * These mirror the read-only DTOs served by `@recoveros/intelligence`
 * (`packages/intelligence/src/read/types.ts`) and the Phase-4/5 dev endpoints.
 * They are intentionally a thin, dependency-free mirror so the Next bundle never
 * pulls Prisma/server code into the browser. Keep them in sync with the backend
 * DTOs — this is the single place the UI references API shapes.
 */

export type CaseStatus =
  | "DETECTED"
  | "ANALYZING"
  | "PROPOSED"
  | "PENDING_APPROVAL"
  | "AUTHORIZED"
  | "EXECUTING"
  | "RECOVERED"
  | "FAILED"
  | "BLOCKED"
  | "REJECTED"
  | "EXPIRED";

export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type RootCause =
  | "BANK_DECLINE"
  | "INSUFFICIENT_FUNDS"
  | "TIMEOUT"
  | "GATEWAY_ERROR"
  | "CUSTOMER_ABANDONMENT"
  | "EXPIRED_CHECKOUT"
  | "UNKNOWN";

export type PolicyDecision = "ALLOW" | "REVIEW" | "BLOCK";

export interface MoneyMeta {
  unit: "minor";
  exponent: number;
  currency: string;
}

export interface RootCauseBreakdownEntry {
  rootCause: RootCause;
  cases: number;
  amountAtRiskMinor: number;
}
export interface SeverityBreakdownEntry {
  severity: Severity;
  cases: number;
  amountAtRiskMinor: number;
}

export interface IntelligenceSummaryDTO {
  tenantId: string;
  generatedAt: string;
  money: MoneyMeta;
  revenueAtRiskMinor: number;
  affectedPayments: number;
  affectedCustomers: number;
  highPriorityCases: number;
  reviewRequiredCases: number;
  recoveredRevenueMinor: number;
  recoverySuccessRate: number | null;
  byRootCause: RootCauseBreakdownEntry[];
  bySeverity: SeverityBreakdownEntry[];
}

export interface CaseListItemDTO {
  id: string;
  status: CaseStatus;
  reason: string;
  rootCause: RootCause | null;
  severity: Severity | null;
  priorityScore: number | null;
  amountAtRiskMinor: number;
  currency: string;
  paymentId: string | null;
  customerId: string | null;
  openedAt: string;
  lastDetectedAt: string | null;
}

export type CaseSort = "priority" | "amount" | "recent";

export interface CaseListDTO {
  tenantId: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  sort: CaseSort;
  filters: Record<string, unknown>;
  money: MoneyMeta;
  items: CaseListItemDTO[];
}

export interface CustomerDTO {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}
export interface PaymentDTO {
  id: string;
  status: string;
  method: string | null;
  amountMinor: number;
  currency: string;
  failureCode: string | null;
  failureReason: string | null;
  paymentRef: string | null;
  orderRef: string | null;
  createdAt: string;
  capturedAt: string | null;
}
export interface PaymentHistoryItemDTO {
  id: string;
  status: string;
  amountMinor: number;
  currency: string;
  failureCode: string | null;
  createdAt: string;
}
export interface TimelineEventDTO {
  eventType: string;
  rawType: string;
  occurredAt: string;
}
export interface DetectedSignalDTO {
  type: string;
  severity: Severity;
  confidence: number;
  reason: string;
  rootCause: RootCause;
  estimatedRevenueAtRiskMinor: number;
  ruleId: string;
  ruleVersion: string;
  evidence: Record<string, unknown>;
}
export interface RecoveryDecisionDTO {
  id: string;
  proposedAction: string;
  amountMinor: number | null;
  confidence: number;
  diagnosis: string;
  rationale: string;
  createdAt: string;
}
export interface RecoveryActionDTO {
  id: string;
  type: string;
  status: string;
  amountMinor: number | null;
  currency: string;
  policyDecision: string | null;
  policyVersion: number | null;
  idempotencyKey: string;
  externalReference: string | null;
  createdAt: string;
}
export interface AuditEntryDTO {
  id: string;
  actorType: string;
  action: string;
  summary: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface CaseDetailDTO {
  id: string;
  tenantId: string;
  status: CaseStatus;
  reason: string;
  rootCause: RootCause | null;
  severity: Severity | null;
  priorityScore: number | null;
  amountAtRiskMinor: number;
  currency: string;
  money: MoneyMeta;
  openedAt: string;
  resolvedAt: string | null;
  lastDetectedAt: string | null;
  detectionRuleVersion: string | null;
  customer: CustomerDTO | null;
  payment: PaymentDTO | null;
  paymentHistory: PaymentHistoryItemDTO[];
  eventTimeline: TimelineEventDTO[];
  detectedSignals: DetectedSignalDTO[];
  scoreComponents: unknown;
  evidence: unknown;
  recoveryDecisions: RecoveryDecisionDTO[];
  recoveryActions: RecoveryActionDTO[];
  auditHistory: AuditEntryDTO[];
}

export interface PaymentTimelineDTO {
  tenantId: string;
  paymentId: string;
  paymentRef: string | null;
  status: string;
  amountMinor: number;
  currency: string;
  money: MoneyMeta;
  events: TimelineEventDTO[];
}

// --- Phase 5 aggregation / status shapes -----------------------------------

export interface FunnelStage {
  key: "at_risk" | "eligible" | "approved" | "attempted" | "recovered";
  label: string;
  cases: number;
  amountMinor: number;
}
export interface FunnelTrendPoint {
  date: string;
  atRiskMinor: number;
  recoveredMinor: number;
  cases: number;
}
export interface FunnelDTO {
  tenantId: string;
  generatedAt: string;
  money: MoneyMeta;
  stages: FunnelStage[];
  trend: FunnelTrendPoint[];
}

export type ConfigStatus = "OK" | "MISSING" | "MISCONFIGURED" | "REJECTED_LIVE";
export type ProbeStatus = "OK" | "SKIPPED" | "UNREACHABLE" | "RATE_LIMITED" | "FAILED";

export interface IntegrationStatusDTO {
  mode: string;
  probed: boolean;
  gemini: { config: ConfigStatus; model: string | null; connectivity: ProbeStatus; detail?: string };
  razorpay: { config: ConfigStatus; mode: "TEST" | null; connectivity: ProbeStatus; detail?: string };
  webhook: { config: "OK" | "MISSING" };
}

export interface EnvironmentInfo {
  /** Display name of the active workspace (never the raw tenantId in the UI). */
  workspace: string;
  workspaceKey: string;
  /** Whether the app is running against seeded/test data. */
  demo: boolean;
  nodeEnv: string;
  executionProvider: "SIMULATED" | "RAZORPAY_TEST";
}

/** A single action awaiting human approval (assembled by the BFF). */
export interface ApprovalItem {
  caseId: string;
  actionId: string;
  actionType: string;
  amountMinor: number;
  currency: string;
  customer: string | null;
  paymentRef: string | null;
  policyDecision: string | null;
  policyVersion: number | null;
  riskLevel: Severity | null;
  rootCause: RootCause | null;
  geminiStrategy: string | null;
  geminiRationale: string | null;
  openedAt: string;
}

// ---------------------------------------------------------------------------
// Failure Lab (development-only demonstration). DTOs mirror the domain shapes in
// @recoveros/lifecycle's failure-lab engine; the server is authoritative.
// ---------------------------------------------------------------------------

export type FailureScenarioGroup = "success" | "provider" | "webhook" | "policy" | "ai";

export interface FailureScenarioMeta {
  id: string;
  title: string;
  summary: string;
  group: FailureScenarioGroup;
  expectsRecovery: boolean;
}

export interface FailureScenarioListDTO {
  mode: "development";
  simulation: true;
  scenarios: FailureScenarioMeta[];
}

export type StageStatus = "ok" | "info" | "blocked" | "failed" | "skipped" | "pending";

export interface FailureLabStage {
  key: string;
  order: number;
  label: string;
  status: StageStatus;
  detail: string;
  meta?: Record<string, string | number | boolean | null>;
  at: string | null;
}

export interface InvariantResult {
  id: string;
  statement: string;
  applicable: boolean;
  holds: boolean;
  detail: string;
}

export interface FailureLabStats {
  providerCalls: number;
  webhookEvents: number;
  duplicateEventsIgnored: number;
  actionsPrevented: number;
  invalidSuccessClaimsPrevented: number;
  revenueCreditedMinor: number;
  revenueLeftAtRiskMinor: number;
  currency: string;
}

export interface SafetyResult {
  headline: string;
  result: string;
  reason: string;
  credited: boolean;
  tone: "success" | "danger" | "warning" | "info";
}

export interface FailureLabPass {
  label: string;
  finalOutcome: string;
  providerCallsDelta: number;
  recoveredRevenueMinor: number;
  duplicatePrevented: boolean;
  stopReason?: string;
}

export interface FailureLabRunDTO {
  mode: "development";
  simulation: true;
  scenario: FailureScenarioMeta;
  providerMode: "SIMULATED" | "RAZORPAY_TEST";
  generatedAt: string;
  stages: FailureLabStage[];
  safety: SafetyResult;
  invariants: InvariantResult[];
  stats: FailureLabStats;
  passes: FailureLabPass[];
  providerRequests: Array<{ method: string; path: string }>;
  auditEvents: string[];
  trace: {
    finalOutcome: string;
    recoveredRevenueMinor: number;
    policyDecision: { decision: string; reason: string; policyVersion: number | null };
    action: { actionType: string; state: string; providerReference: string | null } | null;
  };
}

// ---------------------------------------------------------------------------
// Evaluations — deterministic safety report (mirrors @recoveros/lifecycle).
// ---------------------------------------------------------------------------

export interface SafetyEvidenceRow {
  id: string;
  statement: string;
  holds: boolean;
  evidence: string;
  scenarioId: string;
  scenarioTitle: string;
}

export interface SafetyReportDTO {
  mode: "development";
  simulation: true;
  generatedAt: string;
  providerMode: "SIMULATED" | "RAZORPAY_TEST";
  evidence: SafetyEvidenceRow[];
  allHold: boolean;
}

/** Consistent client-side error envelope surfaced by the BFF. */
export interface ApiError {
  code: string;
  message: string;
  status: number;
}
