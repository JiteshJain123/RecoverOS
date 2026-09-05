/**
 * FailureLab — a controlled DEVELOPMENT-ONLY demonstration + evaluation engine.
 *
 * It proves that RecoverOS fails SAFELY (it never claims a recovery that did not
 * happen) by running the REAL connected lifecycle — strategy → policy → executor
 * safeguards → provider → webhook → reconciliation → verified outcome → recovered
 * revenue → audit — against a set of adversarial scenarios (provider faults,
 * webhook delivery quirks, expired/stale/blocked actions, malformed AI output).
 *
 * It reuses the existing failure harness (deterministic mock Razorpay transport +
 * signed-webhook fixtures) and the existing RecoveryLifecycle. It NEVER uses real
 * credentials, the network, Live Mode, or real customer messages. Nothing here is
 * a production failure mechanism: it is a reproducible test/demo surface.
 *
 * Every field a caller sees (safety result, invariants, statistics) is DERIVED
 * from the actual LifecycleTrace + the mock transport's recorded calls — never a
 * hardcoded claim. In particular, `revenueCreditedMinor` is read straight from
 * the execution ledger, so the UI can never display "Recovered" unless the
 * accounting layer actually credited a verified capture.
 */
import {
  InMemoryExecutionStore,
  SimulatedRecoveryProvider,
  type Clock,
  type PaymentRecoveryProvider,
  type PipelineCase,
} from "@recoveros/execution";
import {
  RazorpayClient,
  RazorpayTestProvider,
  StaticRazorpayCredentialSource,
  defaultRazorpayConfig,
  type HttpTransport,
} from "@recoveros/payments";
import { DeterministicRecoveryStrategyProvider, type RecoveryPlan } from "@recoveros/strategy";
import { RecoveryLifecycle, type LifecycleTrace, type RunCaseOptions } from "./lifecycle";
import { makeRazorpayTransport, type RazorpayScenario } from "./failure-harness";
import type { ExecutionProviderMode } from "./provider-mode";

const WEBHOOK_SECRET = "whsec_failure_lab_secret";
const WEBHOOK_ACCOUNT = "acc_test_FAILURELAB1";
const RUN_INSTANT = "2026-09-05T12:00:00.000Z";
const RZP_TEST_SECRET = "failure_lab_test_secret";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type FailureScenarioGroup = "success" | "provider" | "webhook" | "policy" | "ai";

export interface FailureScenarioMeta {
  id: string;
  title: string;
  /** One-line "what this simulates" for the scenario card. */
  summary: string;
  group: FailureScenarioGroup;
  /** Whether a genuine recovery is EXPECTED to be credited (verified against the run). */
  expectsRecovery: boolean;
}

export type StageStatus = "ok" | "info" | "blocked" | "failed" | "skipped" | "pending";

export interface FailureLabStage {
  key: string;
  /** 1..11 canonical order. */
  order: number;
  label: string;
  status: StageStatus;
  /** Human sentence describing what happened / why it stopped. */
  detail: string;
  /** Safe, non-secret metadata for this stage. */
  meta?: Record<string, string | number | boolean | null>;
  /** Deterministic run instant when the stage ran; null when skipped. */
  at: string | null;
}

export interface InvariantResult {
  id: string;
  statement: string;
  /** Whether this invariant is exercised by THIS scenario. */
  applicable: boolean;
  /** Whether it held (only meaningful when applicable). */
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
  /** STRICTLY from the accounting ledger — true only if verified revenue was credited. */
  credited: boolean;
  tone: "success" | "danger" | "warning" | "info";
}

export interface FailureLabPass {
  label: string;
  finalOutcome: LifecycleTrace["finalOutcome"];
  providerCallsDelta: number;
  recoveredRevenueMinor: number;
  duplicatePrevented: boolean;
  stopReason?: string;
}

export interface FailureLabRun {
  mode: "development";
  simulation: true;
  scenario: FailureScenarioMeta;
  providerMode: ExecutionProviderMode;
  generatedAt: string;
  stages: FailureLabStage[];
  safety: SafetyResult;
  invariants: InvariantResult[];
  stats: FailureLabStats;
  passes: FailureLabPass[];
  /** Provider HTTP calls actually made (method + path only; never bodies/secrets). */
  providerRequests: Array<{ method: string; path: string }>;
  /** Development audit event names produced by this run (labelled as simulation). */
  auditEvents: string[];
  /** The raw domain trace of the primary pass (already secret-safe by construction). */
  trace: LifecycleTrace;
}

// ---------------------------------------------------------------------------
// Scenario configuration
// ---------------------------------------------------------------------------

interface CaseOverrides {
  rootCause?: string;
  amountAtRiskMinor?: number;
  paymentStatus?: string;
  caseStatus?: string;
  alreadyRecovered?: boolean;
}

interface ScenarioConfig extends FailureScenarioMeta {
  providerMode: ExecutionProviderMode;
  razorpay?: RazorpayScenario;
  caseOverrides?: CaseOverrides;
  executorConfig?: { executionTtlMs?: number; approvalTtlMs?: number };
  strategy?: "deterministic" | "malformed";
  /** One or more sequential runCase passes on the SAME lifecycle. */
  passes: Array<{ label: string; opts: RunCaseOptions }>;
  /** Which pass drives the displayed stage trace (default: last). */
  primaryPassIndex?: number;
  /** Safety headline + non-credit result/reason text (credited flag comes from the trace). */
  safety: { headline: string; result: string; reason: string; tone: SafetyResult["tone"] };
}

const APPROVE = { userId: "dev-operator", role: "APPROVER" as const };

const SCENARIOS: ScenarioConfig[] = [
  {
    id: "successful_recovery",
    title: "Successful recovery",
    summary: "Authorized payment is captured and a verified capture credits revenue.",
    group: "success",
    expectsRecovery: true,
    providerMode: "RAZORPAY_TEST",
    caseOverrides: { rootCause: "TIMEOUT", amountAtRiskMinor: 500_000 },
    razorpay: { fetchStatus: "authorized", captureStatus: "captured" },
    passes: [{ label: "Execute", opts: { autoApprove: true, approver: APPROVE, replayWebhook: "none" } }],
    safety: { headline: "RECOVERY VERIFIED", result: "Revenue credited", reason: "A verified capture proved the payment was collected.", tone: "success" },
  },
  {
    id: "provider_timeout",
    title: "Provider timeout",
    summary: "The gateway call times out; the outcome is never verified.",
    group: "provider",
    expectsRecovery: false,
    providerMode: "RAZORPAY_TEST",
    caseOverrides: { rootCause: "BANK_DECLINE", amountAtRiskMinor: 500_000 },
    razorpay: { fault: "timeout" },
    passes: [{ label: "Execute", opts: { autoApprove: true, approver: APPROVE, replayWebhook: "none" } }],
    safety: { headline: "PROVIDER TIMEOUT", result: "Recovery NOT credited", reason: "Provider outcome not verified.", tone: "warning" },
  },
  {
    id: "provider_500",
    title: "Provider 500",
    summary: "The gateway returns HTTP 500; the action fails with no recovery.",
    group: "provider",
    expectsRecovery: false,
    providerMode: "RAZORPAY_TEST",
    caseOverrides: { rootCause: "BANK_DECLINE", amountAtRiskMinor: 500_000 },
    razorpay: { fault: "http500" },
    passes: [{ label: "Execute", opts: { autoApprove: true, approver: APPROVE, replayWebhook: "none" } }],
    safety: { headline: "PROVIDER ERROR (500)", result: "Recovery NOT credited", reason: "Provider reported a server error; no capture occurred.", tone: "warning" },
  },
  {
    id: "duplicate_execution",
    title: "Duplicate execution",
    summary: "The same case is executed twice; idempotency prevents a second provider call.",
    group: "provider",
    expectsRecovery: true,
    providerMode: "RAZORPAY_TEST",
    caseOverrides: { rootCause: "BANK_DECLINE", amountAtRiskMinor: 500_000 },
    passes: [
      { label: "First execution", opts: { autoApprove: true, approver: APPROVE, replayWebhook: "captured" } },
      { label: "Duplicate attempt", opts: { autoApprove: true, approver: APPROVE, replayWebhook: "none" } },
    ],
    primaryPassIndex: 0,
    safety: { headline: "DUPLICATE EXECUTION", result: "No duplicate provider call", reason: "The idempotency key returned the existing action; the provider was not called again.", tone: "info" },
  },
  {
    id: "duplicate_webhook",
    title: "Duplicate webhook",
    summary: "The same signed capture event is delivered twice; it is credited only once.",
    group: "webhook",
    expectsRecovery: true,
    providerMode: "RAZORPAY_TEST",
    caseOverrides: { rootCause: "BANK_DECLINE", amountAtRiskMinor: 500_000 },
    passes: [{ label: "Execute + duplicate webhook", opts: { autoApprove: true, approver: APPROVE, replayWebhook: "duplicate" } }],
    safety: { headline: "DUPLICATE WEBHOOK", result: "Ignored safely", reason: "Event id already processed — no double credit.", tone: "info" },
  },
  {
    id: "out_of_order_webhook",
    title: "Out-of-order webhook",
    summary: "A late 'authorized' event arrives after 'captured'; state never regresses.",
    group: "webhook",
    expectsRecovery: true,
    providerMode: "RAZORPAY_TEST",
    caseOverrides: { rootCause: "BANK_DECLINE", amountAtRiskMinor: 500_000 },
    passes: [{ label: "Execute + out-of-order webhooks", opts: { autoApprove: true, approver: APPROVE, replayWebhook: "out_of_order" } }],
    safety: { headline: "OUT-OF-ORDER WEBHOOK", result: "No state regression", reason: "A late authorized event did not downgrade a captured payment or re-credit.", tone: "info" },
  },
  {
    id: "delayed_webhook",
    title: "Delayed webhook",
    summary: "A payment link is created; revenue is credited only when the capture arrives later.",
    group: "webhook",
    expectsRecovery: true,
    providerMode: "RAZORPAY_TEST",
    caseOverrides: { rootCause: "BANK_DECLINE", amountAtRiskMinor: 500_000 },
    passes: [
      { label: "Link created (webhook not yet arrived)", opts: { autoApprove: true, approver: APPROVE, replayWebhook: "none" } },
      { label: "Delayed capture webhook arrives", opts: { autoApprove: true, approver: APPROVE, replayWebhook: "captured" } },
    ],
    primaryPassIndex: 1,
    safety: { headline: "DELAYED WEBHOOK", result: "Credited only after verification", reason: "The link alone did not credit revenue; the delayed verified capture did.", tone: "success" },
  },
  {
    id: "failed_payment",
    title: "Failed payment",
    summary: "A link is created but the customer never pays; nothing is credited.",
    group: "webhook",
    expectsRecovery: false,
    providerMode: "RAZORPAY_TEST",
    caseOverrides: { rootCause: "BANK_DECLINE", amountAtRiskMinor: 500_000 },
    passes: [{ label: "Execute + failed webhook", opts: { autoApprove: true, approver: APPROVE, replayWebhook: "failed" } }],
    safety: { headline: "PAYMENT LINK CREATED", result: "Revenue NOT recovered yet", reason: "No successful payment has been verified.", tone: "warning" },
  },
  {
    id: "payment_already_recovered",
    title: "Payment already recovered",
    summary: "The case is already recovered; policy blocks any new action.",
    group: "policy",
    expectsRecovery: false,
    providerMode: "RAZORPAY_TEST",
    caseOverrides: { rootCause: "BANK_DECLINE", amountAtRiskMinor: 500_000, paymentStatus: "CAPTURED", alreadyRecovered: true, caseStatus: "RECOVERED" },
    passes: [{ label: "Evaluate", opts: { autoApprove: true, approver: APPROVE, replayWebhook: "none" } }],
    safety: { headline: "ALREADY RECOVERED", result: "0 provider calls", reason: "Policy blocked a duplicate recovery on an already-recovered case.", tone: "info" },
  },
  {
    id: "payment_already_captured",
    title: "Payment already captured",
    summary: "The payment is already captured at the provider; capture is refused (no fake success).",
    group: "provider",
    expectsRecovery: false,
    providerMode: "RAZORPAY_TEST",
    caseOverrides: { rootCause: "TIMEOUT", amountAtRiskMinor: 500_000 },
    razorpay: { fetchStatus: "captured" },
    passes: [{ label: "Execute", opts: { autoApprove: true, approver: APPROVE, replayWebhook: "none" } }],
    safety: { headline: "ALREADY CAPTURED", result: "Recovery NOT credited", reason: "Payment is not in a capturable state; RecoverOS never fakes success from an already-captured payment.", tone: "info" },
  },
  {
    id: "expired_action",
    title: "Expired action",
    summary: "The action's execution TTL has passed; the safeguard blocks it.",
    group: "policy",
    expectsRecovery: false,
    providerMode: "RAZORPAY_TEST",
    caseOverrides: { rootCause: "BANK_DECLINE", amountAtRiskMinor: 500_000 },
    executorConfig: { executionTtlMs: -1000 },
    passes: [{ label: "Execute", opts: { autoApprove: true, approver: APPROVE, replayWebhook: "none" } }],
    safety: { headline: "EXPIRED ACTION", result: "0 provider calls", reason: "The action expired before execution; the safeguard blocked it.", tone: "warning" },
  },
  {
    id: "stale_approval",
    title: "Stale approval",
    summary: "A human approval is older than the freshness window; execution is blocked.",
    group: "policy",
    expectsRecovery: false,
    providerMode: "RAZORPAY_TEST",
    caseOverrides: { rootCause: "BANK_DECLINE", amountAtRiskMinor: 1_200_000 },
    executorConfig: { approvalTtlMs: -1000 },
    passes: [{ label: "Approve + execute", opts: { autoApprove: true, approver: APPROVE, replayWebhook: "none" } }],
    safety: { headline: "STALE APPROVAL", result: "0 provider calls", reason: "The approval was no longer fresh; the safeguard blocked execution.", tone: "warning" },
  },
  {
    id: "policy_version_changed",
    title: "Policy version changed",
    summary: "The active policy version changed after authorization; execution is re-gated.",
    group: "policy",
    expectsRecovery: false,
    providerMode: "RAZORPAY_TEST",
    caseOverrides: { rootCause: "BANK_DECLINE", amountAtRiskMinor: 500_000 },
    passes: [{ label: "Execute under new policy version", opts: { autoApprove: true, approver: APPROVE, replayWebhook: "none", currentPolicyVersion: 999 } }],
    safety: { headline: "POLICY CHANGED", result: "0 provider calls", reason: "A policy-version mismatch forced re-evaluation and cancelled execution.", tone: "warning" },
  },
  {
    id: "capability_error",
    title: "Capability error",
    summary: "The payment is not in a capturable state; a classified capability error is returned.",
    group: "provider",
    expectsRecovery: false,
    providerMode: "RAZORPAY_TEST",
    caseOverrides: { rootCause: "TIMEOUT", amountAtRiskMinor: 500_000 },
    razorpay: { fetchStatus: "created" },
    passes: [{ label: "Execute", opts: { autoApprove: true, approver: APPROVE, replayWebhook: "none" } }],
    safety: { headline: "CAPABILITY ERROR", result: "Recovery NOT credited", reason: "The payment could not be captured; no fake success was recorded.", tone: "warning" },
  },
  {
    id: "malformed_ai_output",
    title: "Malformed / invalid AI output",
    summary: "The AI returns a plan that fails schema validation; it can never execute.",
    group: "ai",
    expectsRecovery: false,
    providerMode: "RAZORPAY_TEST",
    caseOverrides: { rootCause: "BANK_DECLINE", amountAtRiskMinor: 500_000 },
    strategy: "malformed",
    passes: [{ label: "Validate AI plan", opts: { autoApprove: true, approver: APPROVE, replayWebhook: "none" } }],
    safety: { headline: "INVALID AI OUTPUT", result: "0 provider calls", reason: "The AI plan failed schema validation and was rejected before execution.", tone: "danger" },
  },
  {
    id: "blocked_policy",
    title: "BLOCKED policy action",
    summary: "The amount exceeds the policy ceiling; the action is blocked with zero provider calls.",
    group: "policy",
    expectsRecovery: false,
    providerMode: "RAZORPAY_TEST",
    caseOverrides: { rootCause: "BANK_DECLINE", amountAtRiskMinor: 2_000_000 },
    passes: [{ label: "Evaluate", opts: { autoApprove: true, approver: APPROVE, replayWebhook: "none" } }],
    safety: { headline: "BLOCKED", result: "0 provider calls", reason: "Policy denied the action.", tone: "danger" },
  },
  {
    id: "review_without_approval",
    title: "REVIEW without approval",
    summary: "The action needs human approval and none is given; nothing executes.",
    group: "policy",
    expectsRecovery: false,
    providerMode: "RAZORPAY_TEST",
    caseOverrides: { rootCause: "BANK_DECLINE", amountAtRiskMinor: 1_200_000 },
    passes: [{ label: "Evaluate (no approval)", opts: { autoApprove: false, replayWebhook: "none" } }],
    safety: { headline: "REVIEW REQUIRED", result: "0 provider calls", reason: "Human approval is required before any execution.", tone: "warning" },
  },
];

const SCENARIO_BY_ID = new Map(SCENARIOS.map((s) => [s.id, s]));

/** The public catalogue of scenarios (metadata only). */
export function listFailureScenarios(): FailureScenarioMeta[] {
  return SCENARIOS.map((s) => ({ id: s.id, title: s.title, summary: s.summary, group: s.group, expectsRecovery: s.expectsRecovery }));
}

export function isFailureScenario(id: string): boolean {
  return SCENARIO_BY_ID.has(id);
}

// ---------------------------------------------------------------------------
// Wiring helpers
// ---------------------------------------------------------------------------

function makeCase(tenantId: string, scenarioId: string, over: CaseOverrides = {}): PipelineCase {
  const rootCause = (over.rootCause ?? "BANK_DECLINE") as Exclude<PipelineCase["strategyContext"]["rootCause"], null>;
  const amount = over.amountAtRiskMinor ?? 500_000;
  const caseId = `fl_${scenarioId}`;
  const paymentId = `fl_pay_${scenarioId}`;
  const caseStatus = (over.caseStatus ?? "DETECTED") as PipelineCase["policyCase"]["status"];
  const paymentStatus = over.paymentStatus ?? "FAILED";
  const severity = "MEDIUM" as const;
  return {
    strategyContext: {
      caseId,
      tenantId,
      caseStatus: (over.alreadyRecovered ? "RECOVERED" : "DETECTED") as PipelineCase["strategyContext"]["caseStatus"],
      paymentStatus: paymentStatus as PipelineCase["strategyContext"]["paymentStatus"],
      reason: "FAILED_PAYMENT",
      rootCause,
      severity,
      priorityScore: 60,
      amountAtRiskMinor: amount,
      currency: "INR",
      paymentId,
      customerId: `fl_cust_${scenarioId}`,
      retryCount: 0,
      hasContactChannel: true,
      hasExpiredLink: false,
      policyState: "OK",
      signals: [{ type: "FAILED_PAYMENT", severity, rootCause, confidence: 0.9, reason: `${rootCause} detected` }],
    },
    policyCase: {
      id: caseId,
      tenantId,
      status: caseStatus,
      rootCause,
      severity,
      amountAtRiskMinor: amount,
      currency: "INR",
      retryCount: 0,
      openedAt: new Date("2026-09-03T00:00:00.000Z"),
      expiresAt: null,
    },
    paymentContext: {
      paymentStatus,
      alreadyRecovered: over.alreadyRecovered ?? false,
      usedIdempotencyKeys: [],
    },
    policy: {
      version: 2,
      limits: {
        maxRetryAmountMinor: 1_500_000,
        reviewAmountMinor: 1_000_000,
        minConfidence: 0.5,
        maxRetriesPerCase: 2,
        allowedActions: ["RETRY_PAYMENT", "SEND_PAYMENT_LINK", "CONTACT_CUSTOMER"],
      },
    },
  };
}

/** A strategy provider that returns an invalid plan (empty evidence → schema failure). */
function malformedStrategyProvider(): { name: string; generatePlan(): Promise<RecoveryPlan> } {
  return {
    name: "gemini-malformed",
    async generatePlan(): Promise<RecoveryPlan> {
      const plan: RecoveryPlan = {
        caseId: "fl",
        strategy: "SEND_PAYMENT_LINK",
        rationale: "model returned a plan with no supporting evidence",
        confidence: 0.8,
        expectedOutcome: { successProbability: 0.4, description: "recover via link", revenueRecoverableMinor: 500_000 },
        riskLevel: "MEDIUM",
        proposedActions: [
          {
            actionKind: "CREATE_PAYMENT_LINK",
            purpose: "send a recovery payment link",
            amountMinor: 500_000,
            currency: "INR",
            requiredCapability: "payment_links.create",
            riskLevel: "MEDIUM",
            idempotencyKey: "fl_malformed_key",
            stoppingCondition: { type: "PAYMENT_RECOVERED", description: "stop when paid" },
          },
        ],
        stoppingConditions: [{ type: "PAYMENT_RECOVERED", description: "stop when paid" }],
        // Invalid on purpose: the schema requires at least one evidence item
        // (explainability). A malformed model output can never execute.
        evidence: [],
        modelMetadata: { provider: "gemini", strategyEngine: "gemini-flash", version: "sim", deterministic: false },
        generatedAt: RUN_INSTANT,
      };
      return plan;
    },
  };
}

function razorpayProvider(transport: HttpTransport): PaymentRecoveryProvider {
  const client = new RazorpayClient({
    credentials: new StaticRazorpayCredentialSource({ keyId: "rzp_test_failurelab", keySecret: RZP_TEST_SECRET }),
    config: defaultRazorpayConfig({ timeoutMs: 1000 }),
    transport,
    now: () => 0,
  });
  return new RazorpayTestProvider({ client });
}

function pathOf(url: string): string {
  const q = url.indexOf("?");
  const noQuery = q >= 0 ? url.slice(0, q) : url;
  const api = noQuery.indexOf("/v1/");
  return api >= 0 ? noQuery.slice(api) : noQuery;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunFailureScenarioDeps {
  tenantId: string;
  clock?: Clock;
}

export async function runFailureScenario(scenarioId: string, deps: RunFailureScenarioDeps): Promise<FailureLabRun> {
  const cfg = SCENARIO_BY_ID.get(scenarioId);
  if (!cfg) throw new Error(`Unknown failure-lab scenario: ${scenarioId}`);

  const clock = deps.clock ?? { now: () => new Date(RUN_INSTANT) };
  const pc = makeCase(deps.tenantId, cfg.id, cfg.caseOverrides);

  const execStore = new InMemoryExecutionStore({
    cases: [
      {
        id: pc.policyCase.id,
        tenantId: deps.tenantId,
        status: pc.policyCase.status,
        amountAtRiskMinor: pc.policyCase.amountAtRiskMinor,
        currency: "INR",
        resolvedAt: null,
      },
    ],
  });

  const { transport, requests } = makeRazorpayTransport(cfg.razorpay ?? {});
  const provider = cfg.providerMode === "SIMULATED" ? new SimulatedRecoveryProvider() : razorpayProvider(transport);
  const strategyProvider =
    cfg.strategy === "malformed" ? malformedStrategyProvider() : new DeterministicRecoveryStrategyProvider({ clock });

  const lifecycle = new RecoveryLifecycle({
    tenantId: deps.tenantId,
    execStore,
    provider,
    providerMode: cfg.providerMode,
    strategyProvider,
    clock,
    webhookSecret: WEBHOOK_SECRET,
    webhookAccountId: WEBHOOK_ACCOUNT,
    executorConfig: cfg.executorConfig,
  });

  const passes: FailureLabPass[] = [];
  const traces: LifecycleTrace[] = [];
  let callsBefore = 0;
  for (const p of cfg.passes) {
    const beforeCalls = lifecycle.providerCalls;
    const trace = await lifecycle.runCase(pc, p.opts);
    traces.push(trace);
    passes.push({
      label: p.label,
      finalOutcome: trace.finalOutcome,
      providerCallsDelta: lifecycle.providerCalls - beforeCalls,
      recoveredRevenueMinor: trace.recoveredRevenueMinor,
      duplicatePrevented: trace.duplicatePrevented,
      stopReason: trace.stopReason,
    });
    callsBefore = beforeCalls;
  }
  void callsBefore;

  const primaryIndex = cfg.primaryPassIndex ?? traces.length - 1;
  const primary = traces[primaryIndex] as LifecycleTrace;
  const currency = pc.policyCase.currency;

  const providerRequests = requests.map((r) => ({ method: (r.init.method ?? "GET").toUpperCase(), path: pathOf(r.url) }));
  const auditEvents = Array.from(new Set(traces.flatMap((t) => t.auditEvents)));

  const primaryPass = passes[primaryIndex] as FailureLabPass;
  const stages = projectStages(cfg, primary, primaryPass, clock.now().toISOString());
  const stats = computeStats(cfg, traces, passes, providerRequests.length, currency, pc.policyCase.amountAtRiskMinor);
  const invariants = computeInvariants(cfg, primary, passes, providerRequests.length, strategyProvider);
  const safety = deriveSafety(cfg, primary);

  return {
    mode: "development",
    simulation: true,
    scenario: { id: cfg.id, title: cfg.title, summary: cfg.summary, group: cfg.group, expectsRecovery: cfg.expectsRecovery },
    providerMode: cfg.providerMode,
    generatedAt: clock.now().toISOString(),
    stages,
    safety,
    invariants,
    stats,
    passes,
    providerRequests,
    auditEvents,
    trace: primary,
  };
}

// ---------------------------------------------------------------------------
// Projection: LifecycleTrace → 11 canonical stages
// ---------------------------------------------------------------------------

const SAFEGUARD_STOPS = new Set(["expired", "stale_approval", "policy_changed", "case_no_longer_qualifies", "already_recovered", "case_missing"]);

function projectStages(cfg: ScenarioConfig, t: LifecycleTrace, primaryPass: FailureLabPass, at: string): FailureLabStage[] {
  const decision = t.policyDecision.decision;
  const stop = t.stopReason;
  const invalidPlan = stop === "invalid_plan";
  const recovered = t.recoveredRevenueMinor;
  const calls = primaryPass.providerCallsDelta;
  const providerFailure = t.providerFailure;
  const isBlocked = t.finalOutcome === "BLOCKED";
  const isReviewPending = t.finalOutcome === "REVIEW_PENDING";
  const safeguardStopped = stop !== undefined && SAFEGUARD_STOPS.has(stop);

  const stage = (key: string, order: number, label: string, status: StageStatus, detail: string, meta?: FailureLabStage["meta"]): FailureLabStage => ({
    key,
    order,
    label,
    status,
    detail,
    meta,
    at: status === "skipped" ? null : at,
  });

  // 3. Gemini recommendation
  const aiStage = invalidPlan
    ? stage("ai", 3, "Gemini recommendation", "failed", "AI output failed schema validation — it can never execute.", { strategy: t.strategy.strategy })
    : stage("ai", 3, "Gemini recommendation", "ok", `Proposed ${t.strategy.strategy} (advisory only).`, {
        strategy: t.strategy.strategy,
        confidence: t.strategy.confidence,
      });

  // 4. Policy evaluation
  const policyStage =
    decision === "BLOCK"
      ? stage("policy", 4, "Policy evaluation", "blocked", `Policy BLOCK: ${t.policyDecision.reason}.`, {
          decision,
          policyVersion: t.policyDecision.policyVersion,
          violatedRules: t.policyDecision.violatedRules.join(", ") || "—",
        })
      : invalidPlan
        ? stage("policy", 4, "Policy evaluation", "skipped", "Skipped — the AI plan was rejected first.")
        : stage("policy", 4, "Policy evaluation", decision === "REVIEW" ? "pending" : "ok", `Policy ${decision}: ${t.policyDecision.reason}.`, {
            decision,
            policyVersion: t.policyDecision.policyVersion,
            requiredApproval: t.policyDecision.requiredApproval,
          });

  // 5. Approval
  let approvalStage: FailureLabStage;
  if (invalidPlan || decision === "BLOCK") {
    approvalStage = stage("approval", 5, "Approval", "skipped", "No action to approve.");
  } else if (isReviewPending) {
    approvalStage = stage("approval", 5, "Approval", "pending", "Human approval required — not granted. Execution cannot proceed.");
  } else if (decision === "REVIEW") {
    approvalStage = stage("approval", 5, "Approval", "ok", "Human approval granted (development operator).");
  } else {
    approvalStage = stage("approval", 5, "Approval", "ok", "Auto-approved by policy (ALLOW).");
  }

  // 6. Execution safeguard
  let safeguardStage: FailureLabStage;
  if (invalidPlan || isBlocked || isReviewPending) {
    safeguardStage = stage("safeguard", 6, "Execution safeguard", "skipped", "Not reached — stopped before the execution safeguards.");
  } else if (safeguardStopped) {
    safeguardStage = stage("safeguard", 6, "Execution safeguard", "blocked", `Blocked by safeguard: ${stop}.`, { stopReason: stop ?? null });
  } else {
    safeguardStage = stage("safeguard", 6, "Execution safeguard", "ok", "All safeguards passed (approved, fresh, in-policy, still qualifying).");
  }

  // 7. Provider call
  let providerStage: FailureLabStage;
  if (calls === 0) {
    const why = isBlocked
      ? "policy denied the action"
      : isReviewPending
        ? "awaiting human approval"
        : invalidPlan
          ? "AI plan rejected"
          : safeguardStopped
            ? `safeguard: ${stop}`
            : "no executable action";
    providerStage = stage("provider", 7, "Provider call", "skipped", `0 provider calls (${why}).`, { providerCalls: 0 });
  } else if (providerFailure) {
    providerStage = stage("provider", 7, "Provider call", "failed", `Provider call made but did not succeed (${t.finalOutcome}).`, {
      providerCalls: calls,
      providerReference: t.action?.providerReference ?? null,
    });
  } else {
    providerStage = stage("provider", 7, "Provider call", "ok", `Provider call completed (${t.action?.actionType ?? "action"}).`, {
      providerCalls: calls,
      providerReference: t.action?.providerReference ?? null,
    });
  }

  // 8. Webhook
  const webhookStage =
    t.webhookEvents.length === 0
      ? stage("webhook", 8, "Webhook", "skipped", "No webhook delivered in this scenario.")
      : stage(
          "webhook",
          8,
          "Webhook",
          "ok",
          t.webhookEvents.map((e) => `${e.eventType} → ${e.result}`).join("; "),
          { events: t.webhookEvents.length, duplicates: t.webhookEvents.filter((e) => e.result === "duplicate").length },
        );

  // 9. Reconciliation
  const reconciled = t.auditEvents.includes("recovery.recovered");
  const reconciliationStage = reconciled
    ? stage("reconciliation", 9, "Reconciliation", "ok", "A verified capture was reconciled to the case.")
    : t.webhookEvents.length > 0
      ? stage("reconciliation", 9, "Reconciliation", "info", "Webhook processed; no capture to reconcile (nothing credited).")
      : stage("reconciliation", 9, "Reconciliation", "skipped", "Nothing to reconcile.");

  // 10. Outcome verification
  let verifyStage: FailureLabStage;
  if (recovered > 0) {
    verifyStage = stage("verify", 10, "Outcome verification", "ok", "A verified successful payment was confirmed.");
  } else if (t.finalOutcome === "LINK_CREATED") {
    verifyStage = stage("verify", 10, "Outcome verification", "pending", "No verified successful payment — a link is not recovery.");
  } else if (providerFailure) {
    verifyStage = stage("verify", 10, "Outcome verification", "failed", "Provider outcome could not be verified.");
  } else {
    verifyStage = stage("verify", 10, "Outcome verification", "skipped", "No outcome to verify.");
  }

  // 11. Revenue accounting
  const accountingStage =
    recovered > 0
      ? stage("accounting", 11, "Revenue accounting", "ok", `Revenue credited: ${recovered} minor units (verified).`, { recoveredMinor: recovered })
      : stage("accounting", 11, "Revenue accounting", "info", "Revenue NOT credited — no verified capture.", { recoveredMinor: 0 });

  return [
    stage("detected", 1, "Payment detected", "ok", `Failed/at-risk payment detected (${t.action?.actionType ? "candidate" : "case"}).`, {
      paymentId: t.action?.providerReference ?? null,
      rootCause: cfg.caseOverrides?.rootCause ?? "BANK_DECLINE",
      amountMinor: cfg.caseOverrides?.amountAtRiskMinor ?? 500_000,
    }),
    stage(
      "candidate",
      2,
      "Recovery candidate",
      t.strategy.strategy === "NO_ACTION" ? "skipped" : "ok",
      t.strategy.strategy === "NO_ACTION" ? "No recovery candidate." : "Identified as a recovery candidate.",
      { strategy: t.strategy.strategy },
    ),
    aiStage,
    policyStage,
    approvalStage,
    safeguardStage,
    providerStage,
    webhookStage,
    reconciliationStage,
    verifyStage,
    accountingStage,
  ];
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function computeStats(
  cfg: ScenarioConfig,
  traces: LifecycleTrace[],
  passes: FailureLabPass[],
  totalProviderCalls: number,
  currency: string,
  amountAtRiskMinor: number,
): FailureLabStats {
  const webhookEvents = traces.reduce((n, t) => n + t.webhookEvents.length, 0);
  const duplicateEventsIgnored = traces.reduce((n, t) => n + t.webhookEvents.filter((e) => e.result === "duplicate").length, 0);
  const primary = traces[cfg.primaryPassIndex ?? traces.length - 1] as LifecycleTrace;
  const recovered = primary.recoveredRevenueMinor;

  // An action is "prevented" when a guard stopped it (block / unapproved review /
  // safeguard / invalid AI / idempotent duplicate) instead of calling the provider.
  const actionsPrevented =
    passes.filter(
      (p) =>
        p.finalOutcome === "BLOCKED" ||
        p.finalOutcome === "REVIEW_PENDING" ||
        p.duplicatePrevented ||
        (p.stopReason !== undefined && p.stopReason !== "already_executed"),
    ).length + (passes.some((p) => p.duplicatePrevented) ? 0 : 0);

  // A provider "success-shaped" result we refused to count as recovery
  // (e.g. a payment link created, or a SUCCEEDED action that credited nothing).
  const invalidSuccessClaimsPrevented = traces.filter(
    (t) => t.finalOutcome === "LINK_CREATED" && t.recoveredRevenueMinor === 0,
  ).length;

  return {
    providerCalls: totalProviderCalls,
    webhookEvents,
    duplicateEventsIgnored,
    actionsPrevented,
    invalidSuccessClaimsPrevented,
    revenueCreditedMinor: recovered,
    revenueLeftAtRiskMinor: Math.max(0, amountAtRiskMinor - recovered),
    currency,
  };
}

// ---------------------------------------------------------------------------
// Invariants (computed from the actual run, never hardcoded)
// ---------------------------------------------------------------------------

function computeInvariants(
  cfg: ScenarioConfig,
  t: LifecycleTrace,
  passes: FailureLabPass[],
  totalProviderCalls: number,
  strategyProvider: object,
): InvariantResult[] {
  const decision = t.policyDecision.decision;
  const stop = t.stopReason;
  const isReviewPending = t.finalOutcome === "REVIEW_PENDING";
  const unverified = ["LINK_CREATED", "TIMEOUT", "FAILED", "CAPABILITY_ERROR", "REVIEW_PENDING", "BLOCKED", "STOPPED"].includes(t.finalOutcome);

  // Duplicate-EXECUTION proof: a *repeat* pass (index > 0) that re-ran the same
  // case, was recognized as a duplicate, and added no new provider call. (This is
  // distinct from duplicate-webhook dedup, which is a webhook-pipeline concern.)
  const dupPass = passes.slice(1).find((p) => p.duplicatePrevented);

  const geminiCanExecute = typeof (strategyProvider as { execute?: unknown }).execute === "function";

  return [
    {
      id: "block_zero_calls",
      statement: "BLOCK → 0 provider calls",
      applicable: decision === "BLOCK",
      holds: totalProviderCalls === 0,
      detail: `provider calls: ${totalProviderCalls}`,
    },
    {
      id: "review_zero_calls",
      statement: "REVIEW without approval → 0 provider calls",
      applicable: isReviewPending,
      holds: totalProviderCalls === 0,
      detail: `provider calls: ${totalProviderCalls}`,
    },
    {
      id: "safeguard_zero_calls",
      statement: "Expired / stale / policy-changed action → 0 provider calls",
      applicable: stop === "expired" || stop === "stale_approval" || stop === "policy_changed",
      holds: totalProviderCalls === 0,
      detail: stop ? `stopped: ${stop}; provider calls: ${totalProviderCalls}` : "not applicable",
    },
    {
      id: "duplicate_no_extra_call",
      statement: "Duplicate action → no duplicate provider call",
      applicable: dupPass !== undefined,
      holds: dupPass ? dupPass.providerCallsDelta === 0 : false,
      detail: dupPass ? `duplicate pass added ${dupPass.providerCallsDelta} provider calls` : "not applicable",
    },
    {
      id: "unverified_zero_revenue",
      statement: "Unverified outcome → 0 recovered revenue",
      applicable: unverified,
      holds: t.recoveredRevenueMinor === 0,
      detail: `recovered: ${t.recoveredRevenueMinor} minor units`,
    },
    {
      id: "gemini_cannot_execute",
      statement: "Gemini → cannot execute provider actions",
      applicable: true,
      holds: !geminiCanExecute,
      detail: "the strategy provider exposes no execute() surface",
    },
  ];
}

// ---------------------------------------------------------------------------
// Safety result
// ---------------------------------------------------------------------------

function deriveSafety(cfg: ScenarioConfig, t: LifecycleTrace): SafetyResult {
  const credited = t.recoveredRevenueMinor > 0;
  // Authenticity guard: if the ledger disagrees with the scenario's expectation,
  // surface the mismatch rather than a canned message.
  if (credited !== cfg.expectsRecovery) {
    return {
      headline: "UNEXPECTED RESULT",
      result: credited ? "Revenue credited unexpectedly" : "No revenue credited (expected)",
      reason: `finalOutcome=${t.finalOutcome}, recovered=${t.recoveredRevenueMinor}`,
      credited,
      tone: "danger",
    };
  }
  return {
    headline: cfg.safety.headline,
    result: credited ? "Revenue credited" : cfg.safety.result,
    reason: cfg.safety.reason,
    credited,
    tone: cfg.safety.tone,
  };
}

// ---------------------------------------------------------------------------
// Safety report — a curated set of the product's safety guarantees, each backed
// by an ACTUAL failure-lab run (deterministic; never a hardcoded claim). Used by
// the Evaluations page to answer "does RecoverOS avoid false success claims?".
// ---------------------------------------------------------------------------

export interface SafetyEvidenceRow {
  id: string;
  /** The guarantee, in judge-readable language. */
  statement: string;
  /** Whether the guarantee held in the actual run. */
  holds: boolean;
  /** Concrete measured evidence from the run (e.g. "0 provider calls"). */
  evidence: string;
  /** The failure-lab scenario that produced this evidence. */
  scenarioId: string;
  scenarioTitle: string;
}

export interface SafetyReport {
  mode: "development";
  simulation: true;
  generatedAt: string;
  providerMode: ExecutionProviderMode;
  evidence: SafetyEvidenceRow[];
  /** True only if every guarantee held. */
  allHold: boolean;
}

function inr(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 0 })}`;
}

/**
 * Run the curated safety scenarios and project each onto a judge-readable
 * guarantee with concrete evidence. Every row is derived from a real run's
 * trace/stats/invariants — nothing here is asserted without a backing run.
 */
export async function runSafetyReport(deps: RunFailureScenarioDeps): Promise<SafetyReport> {
  const ids = [
    "blocked_policy",
    "review_without_approval",
    "expired_action",
    "duplicate_execution",
    "duplicate_webhook",
    "out_of_order_webhook",
    "provider_timeout",
    "failed_payment",
  ] as const;

  const runs = new Map<string, FailureLabRun>();
  for (const id of ids) runs.set(id, await runFailureScenario(id, deps));

  const get = (id: string): FailureLabRun => runs.get(id) as FailureLabRun;
  const invHolds = (run: FailureLabRun, invId: string): boolean =>
    run.invariants.find((i) => i.id === invId)?.holds ?? false;

  const blocked = get("blocked_policy");
  const review = get("review_without_approval");
  const expired = get("expired_action");
  const dupExec = get("duplicate_execution");
  const dupHook = get("duplicate_webhook");
  const ooo = get("out_of_order_webhook");
  const timeout = get("provider_timeout");
  const link = get("failed_payment");

  const dupExecPass = dupExec.passes[1];

  const evidence: SafetyEvidenceRow[] = [
    {
      id: "block_zero_calls",
      statement: "Policy BLOCK → 0 provider calls",
      holds: invHolds(blocked, "block_zero_calls"),
      evidence: `${blocked.stats.providerCalls} provider calls`,
      scenarioId: blocked.scenario.id,
      scenarioTitle: blocked.scenario.title,
    },
    {
      id: "review_zero_calls",
      statement: "REVIEW without approval → 0 provider calls",
      holds: invHolds(review, "review_zero_calls"),
      evidence: `${review.stats.providerCalls} provider calls; awaiting human approval`,
      scenarioId: review.scenario.id,
      scenarioTitle: review.scenario.title,
    },
    {
      id: "expired_zero_calls",
      statement: "Expired action → 0 provider calls",
      holds: invHolds(expired, "safeguard_zero_calls"),
      evidence: `${expired.stats.providerCalls} provider calls; stopped: ${expired.trace.stopReason ?? "—"}`,
      scenarioId: expired.scenario.id,
      scenarioTitle: expired.scenario.title,
    },
    {
      id: "duplicate_execution_no_extra_call",
      statement: "Duplicate execution → no duplicate provider call",
      holds: invHolds(dupExec, "duplicate_no_extra_call"),
      evidence: `re-run added ${dupExecPass?.providerCallsDelta ?? 0} provider calls`,
      scenarioId: dupExec.scenario.id,
      scenarioTitle: dupExec.scenario.title,
    },
    {
      id: "duplicate_webhook_ignored",
      statement: "Duplicate webhook → ignored safely (credited once)",
      holds: dupHook.stats.duplicateEventsIgnored >= 1 && dupHook.stats.revenueCreditedMinor === 500_000,
      evidence: `${dupHook.stats.duplicateEventsIgnored} duplicate event ignored; credited ${inr(dupHook.stats.revenueCreditedMinor)} once`,
      scenarioId: dupHook.scenario.id,
      scenarioTitle: dupHook.scenario.title,
    },
    {
      id: "out_of_order_no_regress",
      statement: "Out-of-order webhook → state does not regress",
      holds: ooo.trace.finalOutcome === "RECOVERED" && ooo.stats.revenueCreditedMinor === 500_000,
      evidence: `final state ${ooo.trace.finalOutcome}; credited ${inr(ooo.stats.revenueCreditedMinor)} once`,
      scenarioId: ooo.scenario.id,
      scenarioTitle: ooo.scenario.title,
    },
    {
      id: "unverified_zero_revenue",
      statement: "Unverified provider outcome → ₹0 recovered revenue",
      holds: invHolds(timeout, "unverified_zero_revenue"),
      evidence: `outcome ${timeout.trace.finalOutcome}; recovered ${inr(timeout.stats.revenueCreditedMinor)}`,
      scenarioId: timeout.scenario.id,
      scenarioTitle: timeout.scenario.title,
    },
    {
      id: "link_not_recovery",
      statement: "Payment Link created → ₹0 recovered until a verified payment follows",
      holds: link.trace.finalOutcome === "LINK_CREATED" && link.stats.revenueCreditedMinor === 0,
      evidence: `link created; recovered ${inr(link.stats.revenueCreditedMinor)} (no verified capture)`,
      scenarioId: link.scenario.id,
      scenarioTitle: link.scenario.title,
    },
    {
      id: "gemini_cannot_execute",
      statement: "Gemini cannot directly execute provider actions",
      holds: invHolds(blocked, "gemini_cannot_execute"),
      evidence: "the strategy provider exposes no execute() surface",
      scenarioId: blocked.scenario.id,
      scenarioTitle: blocked.scenario.title,
    },
  ];

  return {
    mode: "development",
    simulation: true,
    generatedAt: (deps.clock ?? { now: () => new Date(RUN_INSTANT) }).now().toISOString(),
    providerMode: blocked.providerMode,
    evidence,
    allHold: evidence.every((e) => e.holds),
  };
}
