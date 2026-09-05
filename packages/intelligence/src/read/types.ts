/**
 * DTOs for the read-only dashboard API surface. These shapes are what the HTTP
 * layer serializes; they are provider-agnostic and carry no secrets.
 *
 * MONEY: every monetary field is an integer in MINOR currency units (e.g.
 * paise for INR) and is named `*Minor`. Each response also carries an explicit
 * `money` descriptor so clients never have to guess the unit or exponent.
 */
import type { RootCause, Severity, SignalType } from "../domain/types";

/** Case lifecycle status (mirrors Prisma RecoveryCaseStatus). */
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

/** Explicit money descriptor attached to every money-bearing response. */
export interface MoneyMeta {
  /** All amounts are integers in this unit. */
  unit: "minor";
  /** ISO-4217 exponent (2 for INR/USD → 100 minor units per major). */
  exponent: number;
  currency: string;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

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

  /** Sum of amount-at-risk across currently open (non-terminal) cases. */
  revenueAtRiskMinor: number;
  affectedPayments: number;
  affectedCustomers: number;
  highPriorityCases: number;
  reviewRequiredCases: number;

  recoveredRevenueMinor: number;
  /** RECOVERED / (RECOVERED + FAILED); null when no resolved cases exist. */
  recoverySuccessRate: number | null;

  byRootCause: RootCauseBreakdownEntry[];
  bySeverity: SeverityBreakdownEntry[];
}

// ---------------------------------------------------------------------------
// Case list
// ---------------------------------------------------------------------------

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

export interface CaseListFilters {
  status?: CaseStatus;
  severity?: Severity;
  rootCause?: RootCause;
  minAmountMinor?: number;
  minPriority?: number;
  from?: string; // ISO date (inclusive), filters openedAt
  to?: string; // ISO date (inclusive)
}

export interface CaseListQuery extends CaseListFilters {
  page: number;
  pageSize: number;
  sort: CaseSort;
}

export interface CaseListDTO {
  tenantId: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  sort: CaseSort;
  filters: CaseListFilters;
  money: MoneyMeta;
  items: CaseListItemDTO[];
}

// ---------------------------------------------------------------------------
// Case detail
// ---------------------------------------------------------------------------

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
  /** Provider-neutral references (never a secret). */
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
  type: SignalType;
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
  /** The stored PriorityScore explainability payload ({score, components,...}). */
  scoreComponents: unknown;
  /** Consolidated "why" evidence bundle from the latest engine/batch audit. */
  evidence: unknown;

  recoveryDecisions: RecoveryDecisionDTO[];
  recoveryActions: RecoveryActionDTO[];
  auditHistory: AuditEntryDTO[];
}

// ---------------------------------------------------------------------------
// Payment timeline
// ---------------------------------------------------------------------------

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
