/**
 * RecoverOS development database seed (`pnpm db:seed`).
 *
 * ============================================================================
 * SYNTHETIC DATA ONLY — READ THIS FIRST
 * ============================================================================
 * Every record produced here is FABRICATED for local development and demos.
 *
 *   - NOTHING in this file calls Razorpay, Gemini, or any external service.
 *   - NO real customer, merchant, or cardholder data is used.
 *   - NO real financial transaction, payment link, or message is created.
 *   - All external-looking identifiers are deliberately prefixed so they can
 *     never be mistaken for real provider ids:
 *         seed_rzp_payment_...   seed_rzp_customer_...   seed_rzp_order_...
 *         seed_rzp_plink_...     seed_webhook_evt_...     seed_idem_...
 *     The literal token "seed_" marks the row as synthetic. Payloads also carry
 *     an explicit `_synthetic: true` / `_note` marker.
 *
 * ----------------------------------------------------------------------------
 * DETERMINISM
 * ----------------------------------------------------------------------------
 * The seed is fully deterministic and safe to re-run:
 *   - A fixed PRNG seed (SEED) drives every "random" choice, and records are
 *     produced in a fixed iteration order, so every run yields identical data.
 *   - Every row is written with an explicit, stable primary key (e.g.
 *     `seed_payment_1_007`), so ids never drift between runs.
 *   - Counts are fixed (see COUNTS), not random.
 *
 * ----------------------------------------------------------------------------
 * IDEMPOTENT RESET (LOCAL DEV DATABASE ONLY)
 * ----------------------------------------------------------------------------
 * To stay re-runnable, the seed first deletes all rows (child tables → parent
 * tables) inside a single transaction, then recreates them. This is a
 * DESTRUCTIVE, full wipe intended ONLY for the disposable local development
 * database described in docker-compose.yml. It refuses to run when
 * NODE_ENV === "production" as a guardrail.
 *
 * ----------------------------------------------------------------------------
 * SCOPE (Phase 1)
 * ----------------------------------------------------------------------------
 * No AI, no Gemini, no Razorpay API, no authentication, no recovery automation.
 * Agent runs / decisions / policy outcomes below are pre-baked illustrative
 * traces, NOT the output of a live model or policy engine.
 */
import { prisma, disconnectDatabase, type Prisma } from "@recoveros/database";

// ---------------------------------------------------------------------------
// Determinism primitives
// ---------------------------------------------------------------------------

/** Fixed PRNG seed. Change only if you intend the synthetic dataset to change. */
const SEED = 0x5eed_c0de;

/**
 * Fixed reference instant for all generated timestamps (2026-08-01T09:00:00Z,
 * one month before the project "today"). Using a constant base — rather than
 * the wall clock — keeps generated dates identical across runs.
 */
const BASE_MS = Date.UTC(2026, 7, 1, 9, 0, 0);
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** mulberry32 — tiny, fast, deterministic PRNG. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const rng = makeRng(SEED);

/** Deterministic integer in [min, max]. */
function randInt(min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Index into an array with a guard that satisfies noUncheckedIndexedAccess. */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[((i % arr.length) + arr.length) % arr.length];
  if (v === undefined) throw new Error("at(): empty array");
  return v;
}

/** Deterministic pick from an array. */
function pick<T>(arr: readonly T[]): T {
  return at(arr, Math.floor(rng() * arr.length));
}

/** Zero-padded index for readable, sortable ids. */
const pad = (n: number): string => String(n).padStart(3, "0");

/** A timestamp `daysBack` days (and `hours` hours) before BASE_MS. */
function ts(daysBack: number, hours = 0): Date {
  return new Date(BASE_MS - daysBack * DAY_MS - hours * HOUR_MS);
}

// ---------------------------------------------------------------------------
// Catalogs (all synthetic)
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  "Aarav", "Diya", "Vihaan", "Ananya", "Kabir", "Isha", "Arjun", "Meera",
  "Rohan", "Saanvi", "Vivaan", "Aisha", "Devansh", "Riya", "Kartik", "Neha",
] as const;

const LAST_NAMES = [
  "Sharma", "Iyer", "Patel", "Reddy", "Nair", "Gupta", "Mehta", "Singh",
  "Bose", "Kapoor", "Rao", "Chopra",
] as const;

const PAYMENT_METHODS = ["card", "upi", "netbanking", "wallet"] as const;

/**
 * Failure catalog. `code` values match the states requested for the dev
 * dataset. `bank_timeout` etc. describe hard failures; `checkout_abandoned`
 * and `expired_payment_link` describe non-hard "at-risk revenue" states.
 */
const HARD_FAILURES = [
  { code: "bank_timeout", reason: "Issuing bank did not respond within the timeout window." },
  { code: "insufficient_funds", reason: "Payment declined: insufficient funds in the account." },
  { code: "bank_declined", reason: "Issuing bank declined the transaction." },
  { code: "gateway_error", reason: "Payment gateway returned an unexpected error." },
] as const;

const ABANDONED = {
  code: "checkout_abandoned",
  reason: "Customer left the checkout before completing payment.",
} as const;

const EXPIRED_LINK = {
  code: "expired_payment_link",
  reason: "Payment link expired before the customer paid.",
} as const;

/**
 * Fixed 20-slot status cycle → repeated to reach COUNTS.paymentsPerTenant.
 * Per 60 payments this yields exactly: CAPTURED 24, FAILED 18, CREATED 9,
 * AUTHORIZED 3, REFUNDED 3, PARTIALLY_REFUNDED 3. "CREATED" rows model
 * abandoned checkouts (pending, never captured).
 */
const STATUS_CYCLE = [
  "CAPTURED", "FAILED", "CAPTURED", "CREATED", "CAPTURED", "FAILED", "CAPTURED",
  "REFUNDED", "CAPTURED", "FAILED", "CREATED", "CAPTURED", "FAILED", "AUTHORIZED",
  "CAPTURED", "FAILED", "CAPTURED", "PARTIALLY_REFUNDED", "FAILED", "CREATED",
] as const satisfies readonly Prisma.PaymentCreateManyInput["status"][];

const COUNTS = {
  tenants: 2,
  customersPerTenant: 24,
  paymentsPerTenant: 60,
} as const;

/** A synthetic payload marker so no reader mistakes these for real events. */
function synthPayload(extra: Record<string, unknown>): Prisma.InputJsonValue {
  return { _synthetic: true, _note: "SEED DATA — not from Razorpay", ...extra };
}

// ---------------------------------------------------------------------------
// Tenant definitions
// ---------------------------------------------------------------------------

interface TenantDef {
  index: number;
  id: string;
  name: string;
  slug: string;
  razorpayKeyId: string;
}

const TENANTS: readonly TenantDef[] = [
  {
    index: 1,
    id: "seed_tenant_1",
    name: "Acme Storefront",
    slug: "acme-store",
    razorpayKeyId: "rzp_test_seed_acme",
  },
  {
    index: 2,
    id: "seed_tenant_2",
    name: "Globex Digital",
    slug: "globex-digital",
    razorpayKeyId: "rzp_test_seed_globex",
  },
] as const;

/**
 * The four dev users per tenant. RecoverOS Roles are OWNER/ADMIN/APPROVER/
 * ANALYST/VIEWER; "operator" maps to APPROVER (the role that authorizes and
 * runs recovery actions).
 */
const USER_SPECS = [
  { key: "owner", role: "OWNER", label: "Owner" },
  { key: "admin", role: "ADMIN", label: "Admin" },
  { key: "operator", role: "APPROVER", label: "Operator" },
  { key: "viewer", role: "VIEWER", label: "Viewer" },
] as const satisfies readonly {
  key: string;
  role: Prisma.MembershipCreateManyInput["role"];
  label: string;
}[];

// ---------------------------------------------------------------------------
// Recovery archetypes (the six required scenarios)
// ---------------------------------------------------------------------------

interface Archetype {
  key: string;
  caseStatus: Prisma.RecoveryCaseCreateManyInput["status"];
  reason: Prisma.RecoveryCaseCreateManyInput["reason"];
  proposedAction: Prisma.RecoveryDecisionCreateManyInput["proposedAction"];
  confidence: number;
  diagnosis: string;
  actionType: Prisma.RecoveryActionCreateManyInput["type"];
  actionStatus: Prisma.RecoveryActionCreateManyInput["status"];
  policyDecision: Prisma.RecoveryActionCreateManyInput["policyDecision"];
  policyReasons: readonly string[];
  resolved: boolean;
  approved: boolean;
  executed: boolean;
  failed: boolean;
  externalRef: boolean;
}

const ARCHETYPES: readonly Archetype[] = [
  {
    key: "high_conf_auto",
    caseStatus: "AUTHORIZED",
    reason: "FAILED_PAYMENT",
    proposedAction: "RETRY_PAYMENT",
    confidence: 0.94,
    diagnosis: "Transient bank timeout; retry has a high success likelihood.",
    actionType: "RETRY_PAYMENT",
    actionStatus: "AUTHORIZED",
    policyDecision: "ALLOW",
    policyReasons: ["within_amount_ceiling", "within_retry_limit", "high_confidence"],
    resolved: false,
    approved: false,
    executed: false,
    failed: false,
    externalRef: false,
  },
  {
    key: "medium_conf_review",
    caseStatus: "PENDING_APPROVAL",
    reason: "FAILED_PAYMENT",
    proposedAction: "SEND_PAYMENT_LINK",
    confidence: 0.62,
    diagnosis: "Ambiguous decline; a payment link is proposed pending human review.",
    actionType: "SEND_PAYMENT_LINK",
    actionStatus: "AWAITING_APPROVAL",
    policyDecision: "REVIEW",
    policyReasons: ["medium_confidence", "requires_human_approval"],
    resolved: false,
    approved: false,
    executed: false,
    failed: false,
    externalRef: false,
  },
  {
    key: "blocked",
    caseStatus: "BLOCKED",
    reason: "FAILED_PAYMENT",
    proposedAction: "RETRY_PAYMENT",
    confidence: 0.71,
    diagnosis: "Retry proposed, but amount exceeds the policy ceiling.",
    actionType: "RETRY_PAYMENT",
    actionStatus: "BLOCKED",
    policyDecision: "BLOCK",
    policyReasons: ["amount_exceeds_ceiling"],
    resolved: false,
    approved: false,
    executed: false,
    failed: false,
    externalRef: false,
  },
  {
    key: "already_recovered",
    caseStatus: "RECOVERED",
    reason: "ABANDONED_CHECKOUT",
    proposedAction: "SEND_PAYMENT_LINK",
    confidence: 0.88,
    diagnosis: "Abandoned checkout recovered via a payment link the customer paid.",
    actionType: "SEND_PAYMENT_LINK",
    actionStatus: "SUCCEEDED",
    policyDecision: "ALLOW",
    policyReasons: ["within_amount_ceiling", "within_contact_cap"],
    resolved: true,
    approved: true,
    executed: true,
    failed: false,
    externalRef: true,
  },
  {
    key: "recovery_failed",
    caseStatus: "FAILED",
    reason: "FAILED_PAYMENT",
    proposedAction: "RETRY_PAYMENT",
    confidence: 0.8,
    diagnosis: "Retry authorized but the subsequent charge attempt also failed.",
    actionType: "RETRY_PAYMENT",
    actionStatus: "FAILED",
    policyDecision: "ALLOW",
    policyReasons: ["within_amount_ceiling", "within_retry_limit"],
    resolved: true,
    approved: false,
    executed: true,
    failed: true,
    externalRef: false,
  },
  {
    key: "no_action_required",
    caseStatus: "REJECTED",
    reason: "FAILED_PAYMENT",
    proposedAction: "NO_ACTION",
    confidence: 0.31,
    diagnosis: "Low recovery likelihood and customer opted out; no action advised.",
    actionType: "NO_ACTION",
    actionStatus: "CANCELLED",
    policyDecision: "REVIEW",
    policyReasons: ["low_confidence", "no_action_recommended"],
    resolved: true,
    approved: false,
    executed: false,
    failed: false,
    externalRef: false,
  },
] as const;

// ---------------------------------------------------------------------------
// Idempotent reset (LOCAL DEV ONLY)
// ---------------------------------------------------------------------------

/**
 * Wipe every table in FK-safe order (children before parents) inside one
 * transaction. DESTRUCTIVE — dev database only. Guarded against production.
 */
async function resetDatabase(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run destructive seed reset with NODE_ENV=production.");
  }
  await prisma.$transaction([
    prisma.evaluationResult.deleteMany(),
    prisma.evaluationRun.deleteMany(),
    prisma.agentToolCall.deleteMany(),
    prisma.recoveryAction.deleteMany(),
    prisma.recoveryDecision.deleteMany(),
    prisma.agentRun.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.paymentEvent.deleteMany(),
    prisma.webhookEvent.deleteMany(),
    prisma.recoveryCase.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.policy.deleteMany(),
    prisma.membership.deleteMany(),
    prisma.user.deleteMany(),
    prisma.tenant.deleteMany(),
  ]);
}

// ---------------------------------------------------------------------------
// Per-tenant builders
// ---------------------------------------------------------------------------

interface PaymentRow {
  input: Prisma.PaymentCreateManyInput;
  status: (typeof STATUS_CYCLE)[number];
  customerId: string;
  index: number;
  createdAt: Date;
  webhookId: string | null;
}

async function seedTenant(t: TenantDef): Promise<void> {
  const tid = t.id;

  // --- Tenant -------------------------------------------------------------
  await prisma.tenant.create({
    data: {
      id: tid,
      name: t.name,
      slug: t.slug,
      status: "ACTIVE",
      razorpayKeyId: t.razorpayKeyId,
      secretsRef: `seed_secretsref_${t.index}`,
      createdAt: ts(120),
      updatedAt: ts(1),
    },
  });

  // --- Users + memberships ------------------------------------------------
  const userIdByKey = new Map<string, string>();
  for (const spec of USER_SPECS) {
    const userId = `seed_user_${t.index}_${spec.key}`;
    userIdByKey.set(spec.key, userId);
    await prisma.user.create({
      data: {
        id: userId,
        email: `${spec.key}@${t.slug}.seed.test`,
        name: `${t.name} ${spec.label}`,
        createdAt: ts(120),
        updatedAt: ts(1),
        memberships: {
          create: {
            id: `seed_membership_${t.index}_${spec.key}`,
            tenantId: tid,
            role: spec.role,
            status: "ACTIVE",
            createdAt: ts(120),
            updatedAt: ts(1),
          },
        },
      },
    });
  }
  const ownerId = userIdByKey.get("owner") ?? null;

  // --- Policies (v1 retired, v2 active) — exercises (tenantId, version) ----
  await prisma.policy.createMany({
    data: [
      {
        id: `seed_policy_${t.index}_v1`,
        tenantId: tid,
        version: 1,
        name: "Initial guardrails",
        isActive: false,
        limits: synthPayload({
          maxRetryAmountMinor: 500_000,
          maxRetriesPerCase: 1,
          cooldownHours: 48,
          contactCapPerDay: 1,
          allowedActions: ["RETRY_PAYMENT"],
          rollingDailyCapMinor: 2_000_000,
        }),
        effectiveFrom: ts(120),
        effectiveTo: ts(60),
        createdAt: ts(120),
        updatedAt: ts(60),
      },
      {
        id: `seed_policy_${t.index}_v2`,
        tenantId: tid,
        version: 2,
        name: "Active guardrails",
        isActive: true,
        limits: synthPayload({
          maxRetryAmountMinor: 1_500_000,
          maxRetriesPerCase: 2,
          cooldownHours: 24,
          contactCapPerDay: 2,
          allowedActions: ["RETRY_PAYMENT", "SEND_PAYMENT_LINK", "CONTACT_CUSTOMER"],
          rollingDailyCapMinor: 5_000_000,
        }),
        effectiveFrom: ts(60),
        effectiveTo: null,
        createdAt: ts(60),
        updatedAt: ts(1),
      },
    ],
  });
  const activePolicyId = `seed_policy_${t.index}_v2`;

  // --- Customers ----------------------------------------------------------
  const customerIds: string[] = [];
  const customers: Prisma.CustomerCreateManyInput[] = [];
  for (let i = 1; i <= COUNTS.customersPerTenant; i++) {
    const id = `seed_customer_${t.index}_${pad(i)}`;
    customerIds.push(id);
    customers.push({
      id,
      tenantId: tid,
      razorpayCustomerId: `seed_rzp_customer_${t.index}_${pad(i)}`,
      email: `customer${pad(i)}@${t.slug}.seed.test`,
      phone: `+9199${t.index}00${pad(i)}`,
      name: `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
      createdAt: ts(randInt(90, 119)),
      updatedAt: ts(randInt(1, 30)),
    });
  }
  await prisma.customer.createMany({ data: customers });

  // --- Payments (+ decide which get webhooks) -----------------------------
  const payments: Prisma.PaymentCreateManyInput[] = [];
  const paymentRows: PaymentRow[] = [];
  const webhooks: Prisma.WebhookEventCreateManyInput[] = [];

  for (let i = 1; i <= COUNTS.paymentsPerTenant; i++) {
    const status = at(STATUS_CYCLE, i - 1);
    const customerId = at(customerIds, i - 1);
    const amountMinor = randInt(500, 25_000) * 100;
    const createdAt = ts(randInt(1, 89), randInt(0, 23));

    let failureCode: string | null = null;
    let failureReason: string | null = null;
    let capturedAt: Date | null = null;

    if (status === "FAILED") {
      const f = at(HARD_FAILURES, i);
      failureCode = f.code;
      failureReason = f.reason;
    } else if (status === "CREATED") {
      // Pending → at-risk revenue. Even-indexed rows model an EXPIRED payment
      // link; the rest model an abandoned checkout. Neither was ever captured.
      const atRisk = i % 2 === 0 ? EXPIRED_LINK : ABANDONED;
      failureCode = atRisk.code;
      failureReason = atRisk.reason;
    } else if (status === "CAPTURED" || status === "REFUNDED" || status === "PARTIALLY_REFUNDED") {
      capturedAt = new Date(createdAt.getTime() + HOUR_MS);
    }

    // Webhook exists for provider-confirmed terminal states.
    const hasWebhook =
      status === "CAPTURED" ||
      status === "FAILED" ||
      status === "REFUNDED" ||
      status === "PARTIALLY_REFUNDED";
    const webhookId = hasWebhook ? `seed_webhook_${t.index}_${pad(i)}` : null;

    if (webhookId) {
      const eventType =
        status === "CAPTURED"
          ? "payment.captured"
          : status === "FAILED"
            ? "payment.failed"
            : "refund.created";
      webhooks.push({
        id: webhookId,
        tenantId: tid,
        provider: "RAZORPAY",
        providerEventId: `seed_webhook_evt_${t.index}_${pad(i)}`,
        eventType,
        signatureValid: true,
        status: "PROCESSED",
        payload: synthPayload({ event: eventType, paymentRef: `seed_rzp_payment_${t.index}_${pad(i)}` }),
        receivedAt: new Date(createdAt.getTime() + 2 * HOUR_MS),
        processedAt: new Date(createdAt.getTime() + 2 * HOUR_MS + 5_000),
        createdAt: new Date(createdAt.getTime() + 2 * HOUR_MS),
        updatedAt: new Date(createdAt.getTime() + 2 * HOUR_MS + 5_000),
      });
    }

    const input: Prisma.PaymentCreateManyInput = {
      id: `seed_payment_${t.index}_${pad(i)}`,
      tenantId: tid,
      customerId,
      razorpayPaymentId: `seed_rzp_payment_${t.index}_${pad(i)}`,
      razorpayOrderId: `seed_rzp_order_${t.index}_${pad(i)}`,
      status,
      method: pick(PAYMENT_METHODS),
      amountMinor,
      currency: "INR",
      failureCode,
      failureReason,
      capturedAt,
      createdAt,
      updatedAt: capturedAt ?? createdAt,
    };
    payments.push(input);
    paymentRows.push({ input, status, customerId, index: i, createdAt, webhookId });
  }

  await prisma.webhookEvent.createMany({ data: webhooks });
  await prisma.payment.createMany({ data: payments });

  // --- Payment events -----------------------------------------------------
  const events: Prisma.PaymentEventCreateManyInput[] = [];
  const pushEvent = (
    row: PaymentRow,
    seq: number,
    type: Prisma.PaymentEventCreateManyInput["type"],
    rawType: string,
    linkWebhook = false,
  ): void => {
    events.push({
      id: `seed_pevent_${t.index}_${pad(row.index)}_${seq}`,
      tenantId: tid,
      paymentId: row.input.id ?? null,
      type,
      rawType,
      payload: synthPayload({ rawType, paymentRef: row.input.razorpayPaymentId ?? null }),
      sourceWebhookEventId: linkWebhook ? row.webhookId : null,
      occurredAt: new Date(row.createdAt.getTime() + seq * HOUR_MS),
      createdAt: new Date(row.createdAt.getTime() + seq * HOUR_MS),
    });
  };

  for (const row of paymentRows) {
    pushEvent(row, 1, "PAYMENT_CREATED", "payment.created");
    switch (row.status) {
      case "CAPTURED":
        pushEvent(row, 2, "PAYMENT_AUTHORIZED", "payment.authorized");
        pushEvent(row, 3, "PAYMENT_CAPTURED", "payment.captured", true);
        break;
      case "AUTHORIZED":
        pushEvent(row, 2, "PAYMENT_AUTHORIZED", "payment.authorized");
        break;
      case "FAILED":
        pushEvent(row, 2, "PAYMENT_FAILED", "payment.failed", true);
        break;
      case "REFUNDED":
      case "PARTIALLY_REFUNDED":
        pushEvent(row, 2, "PAYMENT_CAPTURED", "payment.captured");
        pushEvent(row, 3, "REFUND_CREATED", "refund.created", true);
        break;
      case "CREATED":
        // Abandoned checkout: link created; half of them then expire.
        pushEvent(row, 2, "PAYMENT_LINK_CREATED", "payment_link.created");
        if (row.index % 2 === 0) {
          pushEvent(row, 3, "PAYMENT_LINK_EXPIRED", "payment_link.expired");
        }
        break;
    }
  }
  await prisma.paymentEvent.createMany({ data: events });

  // --- Recovery archetypes: cases, agent runs+tools, decisions, actions ----
  const failedRows = paymentRows.filter((r) => r.status === "FAILED");
  const abandonedRows = paymentRows.filter((r) => r.status === "CREATED");

  const cases: Prisma.RecoveryCaseCreateManyInput[] = [];
  const agentRuns: Prisma.AgentRunCreateManyInput[] = [];
  const toolCalls: Prisma.AgentToolCallCreateManyInput[] = [];
  const decisions: Prisma.RecoveryDecisionCreateManyInput[] = [];
  const actions: Prisma.RecoveryActionCreateManyInput[] = [];
  const audits: Prisma.AuditLogCreateManyInput[] = [];

  ARCHETYPES.forEach((a, idx) => {
    const k = a.key;
    // Source payment: abandoned archetypes use a CREATED payment, others FAILED.
    const src =
      a.reason === "ABANDONED_CHECKOUT" ? at(abandonedRows, idx) : at(failedRows, idx);
    const caseId = `seed_case_${t.index}_${k}`;
    const runId = `seed_agentrun_${t.index}_${k}`;
    const decisionId = `seed_decision_${t.index}_${k}`;
    const actionId = `seed_action_${t.index}_${k}`;
    const openedAt = new Date(src.createdAt.getTime() + 3 * HOUR_MS);
    const amount = src.input.amountMinor;

    cases.push({
      id: caseId,
      tenantId: tid,
      paymentId: src.input.id ?? null,
      customerId: src.customerId,
      reason: a.reason,
      status: a.caseStatus,
      amountAtRiskMinor: amount,
      currency: "INR",
      openedAt,
      resolvedAt: a.resolved ? new Date(openedAt.getTime() + 6 * HOUR_MS) : null,
      createdAt: openedAt,
      updatedAt: new Date(openedAt.getTime() + 6 * HOUR_MS),
    });

    // Agent run (pre-baked trace — no live model was called).
    const runStart = new Date(openedAt.getTime() + 1 * HOUR_MS);
    agentRuns.push({
      id: runId,
      tenantId: tid,
      caseId,
      status: "SUCCEEDED",
      model: "seed-sim/deterministic-v1",
      inputTokens: 1200 + idx * 40,
      outputTokens: 260 + idx * 15,
      latencyMs: 800 + idx * 25,
      startedAt: runStart,
      completedAt: new Date(runStart.getTime() + 1_500),
      createdAt: runStart,
      updatedAt: new Date(runStart.getTime() + 1_500),
    });
    const toolPlan = [
      { name: "get_payment_history", args: { paymentRef: src.input.razorpayPaymentId } },
      { name: "check_policy_limits", args: { amountMinor: amount } },
      { name: "draft_recovery_plan", args: { proposedAction: a.proposedAction } },
    ] as const;
    toolPlan.forEach((call, ci) => {
      toolCalls.push({
        id: `seed_toolcall_${t.index}_${k}_${ci + 1}`,
        tenantId: tid,
        agentRunId: runId,
        sequence: ci + 1,
        name: call.name,
        args: synthPayload(call.args),
        result: synthPayload({ ok: true, note: "simulated tool result" }),
        isError: false,
        createdAt: new Date(runStart.getTime() + (ci + 1) * 300),
      });
    });

    decisions.push({
      id: decisionId,
      tenantId: tid,
      caseId,
      agentRunId: runId,
      proposedAction: a.proposedAction,
      amountMinor: a.proposedAction === "NO_ACTION" ? null : amount,
      confidence: a.confidence,
      diagnosis: a.diagnosis,
      rationale: `Deterministic seed rationale for the "${k}" scenario.`,
      createdAt: new Date(runStart.getTime() + 2_000),
    });

    const executedAt = a.executed ? new Date(openedAt.getTime() + 4 * HOUR_MS) : null;
    actions.push({
      id: actionId,
      tenantId: tid,
      caseId,
      decisionId,
      policyId: activePolicyId,
      type: a.actionType,
      status: a.actionStatus,
      amountMinor: a.actionType === "NO_ACTION" ? null : amount,
      currency: "INR",
      policyDecision: a.policyDecision,
      policyReasons: synthPayload({ reasons: a.policyReasons }),
      policyVersion: 2,
      idempotencyKey: `seed_idem_${t.index}_${k}`,
      externalReference: a.externalRef ? `seed_rzp_plink_${t.index}_${k}` : null,
      approvedByUserId: a.approved ? ownerId : null,
      approvedAt: a.approved ? new Date(openedAt.getTime() + 3.5 * HOUR_MS) : null,
      executedAt,
      completedAt: a.executed ? new Date(openedAt.getTime() + 5 * HOUR_MS) : null,
      failureReason: a.failed ? "Retry charge attempt failed at the gateway (simulated)." : null,
      createdAt: new Date(openedAt.getTime() + 2 * HOUR_MS),
      updatedAt: new Date(openedAt.getTime() + 5 * HOUR_MS),
    });

    // Audit trail for this case.
    audits.push(
      {
        id: `seed_audit_${t.index}_${k}_agent`,
        tenantId: tid,
        actorType: "AGENT",
        actorUserId: null,
        action: "recovery.proposal.created",
        entityType: "RecoveryCase",
        entityId: caseId,
        summary: `Agent proposed ${a.proposedAction} (confidence ${a.confidence}).`,
        metadata: synthPayload({ runId }),
        createdAt: new Date(runStart.getTime() + 2_500),
      },
      {
        id: `seed_audit_${t.index}_${k}_policy`,
        tenantId: tid,
        actorType: "POLICY_ENGINE",
        actorUserId: null,
        action: "recovery.policy.evaluated",
        entityType: "RecoveryAction",
        entityId: actionId,
        summary: `Policy decision ${a.policyDecision}.`,
        metadata: synthPayload({ reasons: a.policyReasons, policyVersion: 2 }),
        createdAt: new Date(openedAt.getTime() + 2 * HOUR_MS + 1_000),
      },
    );
    if (a.approved && ownerId) {
      audits.push({
        id: `seed_audit_${t.index}_${k}_approval`,
        tenantId: tid,
        actorType: "USER",
        actorUserId: ownerId,
        action: "recovery.action.approved",
        entityType: "RecoveryAction",
        entityId: actionId,
        summary: "Owner approved the recovery action.",
        metadata: synthPayload({ approvedBy: ownerId }),
        createdAt: new Date(openedAt.getTime() + 3.5 * HOUR_MS),
      });
    }
  });

  // Tenant-level audit entry.
  audits.push({
    id: `seed_audit_${t.index}_tenant_created`,
    tenantId: tid,
    actorType: "SYSTEM",
    actorUserId: null,
    action: "tenant.seeded",
    entityType: "Tenant",
    entityId: tid,
    summary: `Synthetic dev data seeded for ${t.name}.`,
    metadata: synthPayload({ seed: true }),
    createdAt: ts(120),
  });

  await prisma.recoveryCase.createMany({ data: cases });
  await prisma.agentRun.createMany({ data: agentRuns });
  await prisma.agentToolCall.createMany({ data: toolCalls });
  await prisma.recoveryDecision.createMany({ data: decisions });
  await prisma.recoveryAction.createMany({ data: actions });
  await prisma.auditLog.createMany({ data: audits });

  // --- Evaluation (synthetic dataset — NO FKs into merchant data) ---------
  const evalRunId = `seed_evalrun_${t.index}`;
  await prisma.evaluationRun.create({
    data: {
      id: evalRunId,
      tenantId: tid,
      kind: "AI_ASSISTED",
      datasetName: `synthetic-recovery-${t.slug}`,
      status: "COMPLETED",
      config: synthPayload({ sampleSize: 100, seed: SEED }),
      startedAt: ts(2),
      completedAt: ts(2, -1),
      createdAt: ts(2),
      updatedAt: ts(2, -1),
    },
  });
  await prisma.evaluationResult.create({
    data: {
      id: `seed_evalresult_${t.index}_all`,
      evaluationRunId: evalRunId,
      segment: "all",
      precision: 0.83,
      recall: 0.77,
      falsePositiveCost: 1250.5,
      recoveryRate: 0.41,
      recoveredRevenueMinor: BigInt(1_250_000 + t.index * 25_000),
      casesTotal: 100,
      casesActedOn: 62,
      casesRecovered: 41,
      perCase: synthPayload({ note: "synthetic per-case breakdown omitted" }),
      createdAt: ts(2, -1),
    },
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

async function reportCounts(): Promise<void> {
  const [
    tenants, users, memberships, customers, payments, paymentEvents,
    recoveryCases, recoveryDecisions, recoveryActions, policies,
    webhookEvents, agentRuns, agentToolCalls, auditLogs, evaluationRuns, evaluationResults,
  ] = await Promise.all([
    prisma.tenant.count(),
    prisma.user.count(),
    prisma.membership.count(),
    prisma.customer.count(),
    prisma.payment.count(),
    prisma.paymentEvent.count(),
    prisma.recoveryCase.count(),
    prisma.recoveryDecision.count(),
    prisma.recoveryAction.count(),
    prisma.policy.count(),
    prisma.webhookEvent.count(),
    prisma.agentRun.count(),
    prisma.agentToolCall.count(),
    prisma.auditLog.count(),
    prisma.evaluationRun.count(),
    prisma.evaluationResult.count(),
  ]);

  console.log(
    JSON.stringify(
      {
        seed: "recoveros",
        status: "ok",
        synthetic: true,
        counts: {
          tenants, users, memberships, customers, payments, paymentEvents,
          recoveryCases, recoveryDecisions, recoveryActions, policies,
          webhookEvents, agentRuns, agentToolCalls, auditLogs, evaluationRuns, evaluationResults,
        },
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Tenant-agnostic development approval actor. The web BFF injects
 * `x-user-id: "dev-operator"` for dev approvals, and `RecoveryAction.approvedByUserId`
 * is a foreign key to `User` — so this row must exist for the Approve action to
 * persist. Given an APPROVER membership in each seeded tenant so it is a valid
 * approver everywhere. Never used for authentication; real auth replaces it later.
 */
async function seedDevOperator(): Promise<void> {
  await prisma.user.create({
    data: {
      id: "dev-operator",
      email: "dev-operator@recoveros.seed.test",
      name: "Development Operator",
      createdAt: ts(120),
      updatedAt: ts(1),
      memberships: {
        create: TENANTS.map((t) => ({
          id: `seed_membership_${t.index}_devop`,
          tenantId: t.id,
          role: "APPROVER",
          status: "ACTIVE",
          createdAt: ts(120),
          updatedAt: ts(1),
        })),
      },
    },
  });
}

async function main(): Promise<void> {
  console.log("[seed] Resetting local development database (synthetic data only)...");
  await resetDatabase();
  for (const t of TENANTS) {
    console.log(`[seed] Seeding tenant "${t.name}" (${t.slug})...`);
    await seedTenant(t);
  }
  await seedDevOperator();
  await reportCounts();
  console.log("[seed] Done.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectDatabase();
  });
