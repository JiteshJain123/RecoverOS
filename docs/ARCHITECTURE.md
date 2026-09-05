# RecoverOS Architecture

> **Status of this document**
>
> This is a **design and architecture specification**, not a description of shipped
> functionality. At the time of writing, **no application code exists** in this
> repository — only tooling/harness configuration (`.claude/`). Every capability
> described below is **PLANNED** unless explicitly marked `IMPLEMENTED`.
>
> To keep the distinction honest, sections use these tags:
>
> - **[PLANNED]** — intended design, not yet built.
> - **[IMPLEMENTED]** — exists and works in the codebase today.
> - **[PARTIAL]** — scaffolding or a subset exists.
>
> As modules land, their tags should be updated in the same commit that implements
> them. Do not mark anything `IMPLEMENTED` before it is merged and tested.
>
> **Current global status: everything below is [PLANNED].**

---

## 1. Product Overview

RecoverOS is a multi-tenant B2B SaaS platform that helps online merchants **recover
revenue they are silently losing** at the payment layer, using AI to diagnose the
situation and a deterministic policy engine to keep every financial action safe and
bounded.

### The real merchant problem

Merchants selling online lose a meaningful fraction of revenue not to lack of demand,
but to **mechanical and behavioral failures around payment**:

- **Failed payments.** A customer intends to pay, but the charge fails — insufficient
  funds, issuer decline, expired card, network error, 3-D Secure drop-off, or a
  transient gateway problem. Many of these are _recoverable_ with a well-timed retry
  or a fresh payment link, but merchants rarely react in time or at all.
- **Abandoned checkout.** A customer reaches checkout, generates an order or an
  intent, and never completes payment. Some of this is genuine loss of intent; some
  is a recoverable nudge away (a reminder, a payment link, addressing a specific
  failure reason).
- **Subscription / recurring payment failures.** Renewal charges fail (card expiry,
  insufficient funds, mandate issues). Without intervention this becomes **involuntary
  churn** — the customer did not choose to leave; the payment just stopped working.
- **Revenue at risk.** The sum of the above is a continuously accumulating pool of
  _at-risk revenue_ — money the merchant has a legitimate, recoverable claim to, but
  which will be lost unless someone acts on each case correctly and quickly.

### What RecoverOS does about it

RecoverOS turns that diffuse loss into an explicit, auditable workflow:

1. **Detects** at-risk revenue by ingesting payment events and applying deterministic
   risk rules.
2. **Analyzes** each case with an AI agent that diagnoses the likely cause and
   proposes a bounded recovery strategy.
3. **Decides** safely: a deterministic **policy engine** — never the LLM — authorizes,
   flags for review, or blocks every proposed financial action.
4. **Acts** through Razorpay (Test Mode for this project): retries, payment links, and
   customer contact, only when policy (and, where required, a human) approves.
5. **Verifies** outcomes via Razorpay webhooks and records whether revenue was actually
   recovered.
6. **Audits** everything — every event, AI turn, policy decision, approval, and action
   — in an append-only trail.
7. **Evaluates** its own effectiveness on synthetic datasets with held-out test data.

### Bounded automation (the core principle)

RecoverOS is deliberately **not** a system that "lets the AI take actions." It is a
system where **AI recommends and deterministic code authorizes**. Automation is
_bounded_: every action has hard financial limits, retry ceilings, cooldowns, and
contact caps that live in code and policy — not in a prompt. The AI's authority ends
at producing a structured recommendation. See §7 and §8.

---

## 2. Product Goals

1. **Recover recoverable revenue.** Materially reduce revenue lost to failed payments,
   abandoned checkout, and subscription failures for each merchant tenant.
2. **Safety-first automation.** Guarantee that no financial action can occur without
   passing a deterministic, testable policy gate. The LLM must never have unilateral
   financial authority.
3. **Multi-tenant from day one.** Strict isolation between merchants; per-merchant
   configuration, policies, data, and audit.
4. **Human-in-the-loop where it matters.** High-value, low-confidence, or unusual
   actions route to a human approver before execution.
5. **Explainability and auditability.** Every decision — AI and deterministic — is
   recorded with its inputs, rationale, and outcome, reconstructable after the fact.
6. **Measurable effectiveness.** The system can be evaluated on synthetic data with
   precision, recall, false-positive cost, recovery rate, and recovered revenue, and
   compared against a non-AI baseline.
7. **Production-oriented engineering.** Idempotency, webhook signature verification,
   out-of-order handling, RBAC, and observability treated as first-class, not
   afterthoughts.

---

## 3. Non-Goals

- **Not a payment gateway or PSP.** RecoverOS does not process or custody funds. It
  orchestrates recovery _through_ Razorpay's APIs.
- **Not a general-purpose marketing/CRM tool.** Customer contact is scoped strictly to
  payment recovery, under contact caps.
- **Not autonomous financial control.** The LLM never executes actions. There is no
  mode in which AI output directly triggers a financial API call.
- **Not a production/live-money deployment for this project.** All Razorpay usage is
  **Test Mode**. No real settlements.
- **Not a real-ML-training project (initially).** "AI" here means an LLM agent plus a
  deterministic policy engine. There is no bespoke trained model in the first phases;
  the evaluation harness measures the _system_, not a trained classifier. (A learned
  risk model is a possible later addition — see §12.)
- **Not multi-PSP.** Only Razorpay is integrated. The adapter is isolated so other PSPs
  _could_ be added later, but that is out of scope.
- **Not handling arbitrary currencies/regions initially.** Assume Razorpay's supported
  test configuration (INR-centric); multi-currency is a later concern.

---

## 4. SaaS Architecture

RecoverOS is a **multi-tenant** application. The tenancy model:

### Tenants / merchants

A **Tenant** represents a merchant organization — the top-level isolation boundary.
All business data (customers, payments, cases, actions, policies, audit) is owned by
exactly one tenant and is never visible across tenants.

### Workspaces

A **Workspace** is a working environment within a tenant. For most merchants there is
one workspace per tenant, but the model supports multiple (e.g. separate storefronts,
brands, or staging vs. production event streams) so that data, policies, and Razorpay
credentials can be scoped per workspace. Tenant is the _ownership_ boundary; workspace
is the _operational_ boundary within it.

> Design note: Tenant and Workspace are modeled as distinct entities even where a
> merchant uses only one workspace, so the isolation story does not have to be
> retrofitted later. Row-level scoping keys off both `tenantId` and `workspaceId`.

### Users

A **User** is an individual identity (a person) that can belong to one or more tenants.
Users authenticate once; their access within a given tenant/workspace is defined by
membership and role.

### Memberships and Roles (RBAC)

A **Membership** links a User to a Tenant (and/or Workspace) with a **Role**. Planned
roles:

| Role       | Capabilities                                                              |
| ---------- | ------------------------------------------------------------------------- |
| `owner`    | Full control incl. billing, tenant settings, member management.           |
| `admin`    | Manage workspaces, policies, integrations, members (non-billing).         |
| `approver` | Approve/reject recovery actions that require human review.                |
| `analyst`  | View cases, run simulations/evaluations, propose but not approve actions. |
| `viewer`   | Read-only access to dashboards, cases, and audit.                         |

RBAC is enforced server-side in the API layer; the frontend reflects but never
enforces authorization.

### Tenant isolation

- Every domain table carries `tenantId` (and `workspaceId` where applicable).
- Isolation is enforced **centrally** — a request-scoped tenant context plus a Prisma
  client extension/middleware that constrains queries — rather than relying on each
  query author to remember the filter. **[PLANNED]**
- Razorpay credentials, webhook secrets, and Anthropic usage are scoped per
  tenant/workspace and stored server-side only.

### Merchant-specific policies

Each tenant (optionally each workspace) has its own **Policy** configuration governing
the financial safety model (§8): amount ceilings, retry limits, cooldown windows,
contact caps, and which action types are permitted. Policies are versioned so that any
past decision can be replayed against the exact policy that was in force at the time.

---

## 5. High-Level Architecture

RecoverOS is a pnpm + Turborepo monorepo with three deployable apps and a set of shared
packages. Data flows from the payment edge inward to a deterministic decision core.

```
                          ┌──────────────────────────────────────────┐
                          │              apps/web (Next.js)            │
                          │  Dashboards · Approvals · Traces · Labs    │
                          └───────────────────┬────────────────────────┘
                                              │ HTTPS (authenticated, RBAC)
                                              ▼
                          ┌──────────────────────────────────────────┐
                          │              apps/api (Express)            │
                          │  Auth · RBAC · Tenant context · Routes     │
                          │  Webhook receiver · Ingestion              │
                          └───────────────────┬────────────────────────┘
                                              │
                 ┌────────────────────────────┼───────────────────────────────┐
                 ▼                            ▼                                ▼
     ┌────────────────────┐     ┌──────────────────────────┐     ┌────────────────────┐
     │ Application services│     │   Webhook processor       │     │  apps/worker        │
     │ (case mgmt, approval│     │ (verify · idempotency ·   │     │  (async jobs:       │
     │  workflow, actions) │     │  out-of-order handling)   │     │  detection, agent,  │
     └─────────┬──────────┘     └────────────┬─────────────┘     │  evaluation)        │
               │                             │                    └─────────┬──────────┘
               │                             │                              │
               ▼                             │                              ▼
     ┌────────────────────┐                  │                    ┌────────────────────┐
     │  Agent runtime      │                  │                    │ Analytics /         │
     │  (Claude, tools,    │                  │                    │ Evaluation engine   │
     │  structured output) │                  │                    └─────────┬──────────┘
     └─────────┬──────────┘                   │                              │
               │ proposal (NO financial power)│                              │
               ▼                              │                              │
     ┌────────────────────┐                   │                              │
     │  Policy engine      │  ← deterministic, pure, unit-tested             │
     │  ALLOW/REVIEW/BLOCK │                   │                              │
     └─────────┬──────────┘                   │                              │
               │ authorized action            │                              │
               ▼                              ▼                              │
     ┌────────────────────┐         ┌────────────────────┐                  │
     │  Razorpay adapter   │────────▶│   Razorpay (Test)   │                  │
     │ (links, retries,    │◀────────│   webhooks back     │                  │
     │  signature verify)  │         └────────────────────┘                  │
     └─────────┬──────────┘                                                   │
               │                                                              │
               ▼                                                              ▼
     ┌───────────────────────────────────────────────────────────────────────────┐
     │                             PostgreSQL (Prisma)                              │
     │  Tenants · Users · Payments · Events · Cases · Decisions · Actions ·         │
     │  Policies · AuditLog · WebhookEvents · AgentRuns · Evaluations               │
     └───────────────────────────────────────────────────────────────────────────┘
```

**Layer responsibilities:**

- **Next.js (`apps/web`)** — presentation only. Dashboards, approval queue, agent
  trace viewer, Failure Lab, analytics. Holds no secrets; enforces no authorization.
- **Express API (`apps/api`)** — authentication, RBAC, tenant-context resolution,
  request validation, and routing. Hosts the webhook receiver endpoint.
- **Application services** — domain orchestration: case management, the approval
  workflow state machine, and action dispatch. Coordinates agent → policy → adapter.
- **Agent runtime (`packages/agent`)** — wraps the Claude API/Agent SDK, exposes
  read-only tools plus a _propose_ tool, and returns structured, validated output. It
  has **no dependency on the Razorpay adapter**.
- **Policy engine (`packages/policy-engine`)** — pure, deterministic authorization.
  The single gate to any financial action. No network, no LLM, no randomness.
- **Razorpay adapter (`packages/razorpay`)** — the only code permitted to call Razorpay
  financial APIs, plus webhook signature verification.
- **Webhook processor** — validates signatures, enforces idempotency, and handles
  out-of-order delivery before persisting events.
- **PostgreSQL (`packages/db`, Prisma)** — the system of record, including the
  append-only audit trail.
- **Worker (`apps/worker`)** — runs long/async work off the request path: risk
  detection, agent runs, and evaluation jobs, driven initially by a Postgres-backed
  queue.
- **Analytics / evaluation** — aggregates outcomes for dashboards and computes recovery
  metrics on synthetic datasets.

---

## 6. Event-Driven Payment Flow

The core pipeline is event-driven and idempotent end to end. **[PLANNED]**

```
 Razorpay event (webhook)
        │
        ▼
 (1) Webhook validation
     - verify HMAC-SHA256 signature over the raw request body
     - reject on mismatch (never parse untrusted bodies as trusted)
        │
        ▼
 (2) Idempotency
     - derive a stable key from the Razorpay event id
     - if already processed → ack 200 and stop (no duplicate side effects)
        │
        ▼
 (3) Event persistence
     - store the raw WebhookEvent (immutable) and normalize into PaymentEvent
     - associate to Payment / Customer / Tenant / Workspace
        │
        ▼
 (4) Revenue-risk analysis  (deterministic rules, in worker)
     - classify whether this event creates or updates at-risk revenue
     - open or update a RecoveryCase; quantify amount at risk
        │
        ▼
 (5) Agent decision  (agent runtime)
     - Claude reads the case via read-only tools
     - emits a structured RecoveryDecision proposal (diagnosis, action, confidence)
     - performs NO financial action
        │
        ▼
 (6) Policy evaluation  (policy engine — deterministic)
     - ALLOW → proceed to action
     - REVIEW → route to human approval queue
     - BLOCK → stop; record reason
        │
        ▼
 (7) Action  (Razorpay adapter, only if ALLOW or approved REVIEW)
     - execute retry / payment link / contact
     - idempotent execution keyed to the action id
        │
        ▼
 (8) Webhook / outcome
     - Razorpay emits follow-up events (paid, failed, link paid, etc.)
     - re-enter at (1); outcome is matched back to the RecoveryAction/Case
        │
        ▼
 (9) Audit trail
     - every step above appends immutable AuditLog + AgentRun/ToolCall records
     - outcome feeds analytics and evaluation
```

Steps (1)–(3) are synchronous within the webhook request (fast, must ack quickly).
Steps (4)–(9) run asynchronously in the worker, so slow AI or network calls never
block webhook acknowledgement.

---

## 7. AI Agent Architecture

The agent is the _analysis and recommendation_ layer. Its authority is deliberately
narrow. **[PLANNED]**

### What the LLM CAN do

- **Read** case context through structured, read-only tools (payment history, failure
  reason, customer recovery history, a _summary_ of the tenant's policy limits).
- **Diagnose** the likely cause of the failure/abandonment in natural language.
- **Propose** exactly one bounded recovery action via a structured `propose_recovery_action`
  tool call — a _recommendation object_, not an executed action.
- **Explain** its reasoning and attach a **confidence** score.

### What the LLM CANNOT do

- **Cannot execute** any financial action. The agent package has **no import** of the
  Razorpay adapter — the restriction is structural, not just prompt-based.
- **Cannot bypass or alter policy.** It can read a policy _summary_ to make better
  recommendations, but it cannot change limits or grant itself authority.
- **Cannot access another tenant's data.** Tools are always scoped to the case's
  tenant/workspace context.
- **Cannot free-form its output.** Output is constrained to a validated schema; a
  malformed response is rejected and treated as an AI failure (see §8 fallback).
- **Cannot set final approval state.** Only the policy engine (and humans, for REVIEW)
  decide execution.

### Tools available to the agent (planned)

| Tool                            | Type         | Purpose                                                       |
| ------------------------------- | ------------ | ------------------------------------------------------------- |
| `get_recovery_case`             | read-only    | Fetch the case, at-risk amount, and linked payment.           |
| `get_payment_history`           | read-only    | Prior payments/failures for the customer.                     |
| `get_customer_recovery_history` | read-only    | Past recovery attempts, outcomes, and contact count.          |
| `get_policy_summary`            | read-only    | Human-readable summary of applicable limits (informational).  |
| `propose_recovery_action`       | write-intent | Record a structured proposal. **Performs no financial call.** |

All tools are tenant-scoped and side-effect-free except `propose_recovery_action`,
which only writes a proposal record.

### Structured output

The agent must return a schema-validated object (validated with Zod at the boundary),
approximately:

```
RecoveryDecision (proposal) {
  caseId
  diagnosis: string                 // human-readable cause analysis
  proposedAction: enum {            // bounded set, not free text
    RETRY_PAYMENT | SEND_PAYMENT_LINK | CONTACT_CUSTOMER | NO_ACTION
  }
  amount?: integer (minor units)    // where relevant, e.g. link/retry amount
  targetCustomerId?: string
  rationale: string                 // why this action
  confidence: number (0..1)
}
```

### Confidence

Confidence is a first-class input to the policy engine, not a display cosmetic. Low
confidence can force a proposal into REVIEW even when amounts are within limits (§8).

### Reasoning / explanation

The diagnosis and rationale are persisted with the `AgentRun` so every recommendation
is explainable after the fact and visible in the trace viewer.

### Policy handoff

The agent's structured proposal is handed to the **policy engine** — never to the
Razorpay adapter. This handoff is the security boundary: everything the LLM produces is
untrusted input to a deterministic gate.

---

## 8. Financial Safety Model

The policy engine is a **pure, deterministic, exhaustively unit-tested** function. Same
inputs ⇒ same decision ⇒ fully auditable and replayable. It consumes an agent proposal
plus the tenant's versioned policy plus historical state, and returns one of three
outcomes. **[PLANNED]**

### Decisions

- **ALLOW** — the action is within all limits and confidence is sufficient. It may be
  executed automatically.
- **REVIEW** — the action is plausible but must be confirmed by a human `approver`
  before execution (queued in the approval workflow).
- **BLOCK** — the action violates a hard constraint or is unsafe. It is never executed;
  the reason is recorded.

Every decision records the **specific rule(s)** that produced it.

### Guardrails evaluated

- **Transaction amount limits.** Per-action ceiling and per-case ceiling. Above the
  auto-execute ceiling → REVIEW; above the absolute ceiling → BLOCK.
- **Retry limits.** Maximum number of retry attempts per payment/case. Exceeding →
  BLOCK. Approaching the limit may force REVIEW.
- **Cooldowns.** Minimum time between recovery attempts on the same payment/customer.
  Action inside the cooldown window → BLOCK (or REVIEW, per policy).
- **Customer contact limits.** Maximum recovery contacts (messages/links) per customer
  per rolling window, to prevent harassment/spam. Exceeding → BLOCK.
- **Suspicious situations.** Heuristics such as unusually large amounts, rapid repeated
  failures, mismatched/duplicate targets, or a proposal that doesn't match the case
  context → REVIEW or BLOCK.
- **AI unavailable fallback.** If the LLM is down, times out, or returns malformed/
  unvalidatable output, the system does **not** guess. It falls back to a conservative
  deterministic default (typically `NO_ACTION` or a low-risk templated action within
  strict limits) and/or routes to REVIEW. AI failure never results in an unbounded or
  unauthorized action.
- **Human approval.** REVIEW outcomes require an `approver` to approve before the
  Razorpay adapter is invoked. Approval and approver identity are audited.

### Rolling caps

Per-tenant and per-workspace rolling caps (e.g. total recovery spend per day) are
enforced in addition to per-action limits, so a stream of individually-valid actions
cannot aggregate into an unacceptable total.

---

## 9. Razorpay Integration

All Razorpay usage in this project is **Test Mode**. The integration is isolated in
`packages/razorpay`, the only code permitted to call Razorpay financial APIs.
**[PLANNED]**

> This section describes only capabilities that exist in Razorpay's public API surface
> (Payment Links, standard payment/webhook events, HMAC webhook signatures). No
> Razorpay capability is invented here. Exact endpoints, event names, and payloads must
> be confirmed against the current Razorpay API documentation at implementation time
> before any code depends on them.

### Test Mode

Development and evaluation run entirely against Razorpay Test Mode credentials. No live
keys, no real settlements. Test-mode keys and webhook secrets are stored server-side,
scoped per tenant/workspace.

### Payment Links

The primary recovery mechanism is the **Payment Link**: for a failed or abandoned
payment, RecoverOS can (after policy/approval) create a payment link for the amount at
risk and deliver it to the customer. Link lifecycle events (created, paid, expired)
flow back via webhooks and are matched to the originating `RecoveryAction`/`RecoveryCase`.

### Webhooks

RecoverOS exposes a webhook endpoint that receives Razorpay events (payment
authorized/failed/captured, payment-link paid/expired, subscription/renewal events as
applicable). These drive both the initial detection pipeline (§6) and outcome
verification.

### Webhook signature validation

Every webhook is verified using Razorpay's HMAC-SHA256 signature scheme over the **raw
request body** with the configured webhook secret. The raw body must be preserved
(not re-serialized) for verification. Requests failing verification are rejected and
recorded; they never reach the trusted pipeline.

### Event idempotency

Each webhook carries a Razorpay event identifier. RecoverOS derives a stable idempotency
key from it and records processed events in `WebhookEvent`. Re-delivered duplicates are
acknowledged but not reprocessed, so no duplicate cases, actions, or side effects occur.

### Out-of-order event handling

Webhooks can arrive out of order (e.g. a "paid" before a "created", or a stale "failed"
after a "paid"). RecoverOS handles this by:

- Treating persisted payment/case state as a **monotonic state machine** (§11) that
  ignores transitions which would move state backwards.
- Using event timestamps/sequence where available to resolve ordering.
- Reconciling on the authoritative terminal state (e.g. a confirmed capture) rather than
  on arrival order.

---

## 10. Database Domain Model

PostgreSQL via Prisma. All business entities are tenant-scoped. Below are the entities
the system is expected to need and their roles. Exact columns/relations are defined in
the Prisma schema when Phase 1 lands. **[PLANNED]**

| Entity               | Purpose / key fields                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Tenant**           | Top-level merchant/organization; isolation boundary.                                                              |
| **User**             | Individual identity; can belong to multiple tenants.                                                              |
| **Membership**       | Links User ↔ Tenant/Workspace with a Role (RBAC).                                                                 |
| **Customer**         | An end customer of a merchant; owns payments and recovery history. Tenant-scoped.                                 |
| **Payment**          | A payment/order intent and its current status; the unit of recovery.                                              |
| **PaymentEvent**     | Normalized payment lifecycle events derived from webhooks.                                                        |
| **RecoveryCase**     | An opened case of at-risk revenue for a payment; quantifies amount at risk; carries lifecycle state (§11).        |
| **RecoveryDecision** | An AI proposal (diagnosis, proposed action, confidence, rationale) for a case.                                    |
| **RecoveryAction**   | An authorized/executed recovery action (retry, link, contact) with status and outcome; idempotency key.           |
| **Policy**           | Versioned per-tenant/workspace safety configuration (limits, retries, cooldowns, contact caps, allowed actions).  |
| **AuditLog**         | Append-only, immutable record of every significant event/decision/action; hash-chained for tamper-evidence.       |
| **WebhookEvent**     | Raw inbound Razorpay webhook + verification status + idempotency key.                                             |
| **AgentRun**         | One execution of the agent for a case: inputs, model, output, confidence, timing, status.                         |
| **AgentToolCall**    | Individual tool invocations within an AgentRun (name, args, result) for trace reconstruction.                     |
| **EvaluationRun**    | One evaluation execution over a dataset (baseline or AI system) with configuration.                               |
| **EvaluationResult** | Per-run metrics (precision, recall, false-positive cost, recovery rate, recovered revenue) and per-case outcomes. |

Relationships (high level): Tenant 1—* Workspace; Tenant 1—* Membership _—1 User;
Tenant 1—_ Customer 1—* Payment 1—* PaymentEvent; Payment 1—* RecoveryCase 1—*
RecoveryDecision and 1—* RecoveryAction; Tenant 1—* Policy (versioned); everything
1—* AuditLog; WebhookEvent _—1 Payment (once matched); RecoveryCase 1—_ AgentRun 1—*
AgentToolCall; EvaluationRun 1—* EvaluationResult.

---

## 11. Recovery Lifecycle

Each `RecoveryCase` moves through a state machine. Transitions are guarded and
monotonic where correctness requires it (supporting out-of-order events, §9).
**[PLANNED]**

```
                         ┌───────────┐
   payment event ───────▶│  DETECTED │  at-risk revenue identified; case opened
                         └─────┬─────┘
                               │ risk analysis complete
                               ▼
                         ┌───────────┐
                         │ ANALYZING │  agent run in progress
                         └─────┬─────┘
                               │ agent proposal produced (or AI-unavailable fallback)
                               ▼
                         ┌───────────┐
                         │ PROPOSED  │  RecoveryDecision recorded
                         └─────┬─────┘
                               │ policy engine evaluates
              ┌────────────────┼─────────────────────────────┐
              │ BLOCK          │ REVIEW                       │ ALLOW
              ▼                ▼                              ▼
        ┌──────────┐   ┌──────────────┐               ┌──────────────┐
        │ BLOCKED  │   │ PENDING_     │  human approver│  AUTHORIZED  │
        │ (terminal│   │ APPROVAL     │───────────────▶│              │
        │  reason) │   └──────┬───────┘   approve      └──────┬───────┘
        └──────────┘          │ reject                        │
                              ▼                               │ execute via
                        ┌──────────┐                          │ Razorpay adapter
                        │ REJECTED │ (terminal)                ▼
                        └──────────┘                    ┌──────────────┐
                                                        │  EXECUTING   │
                                                        └──────┬───────┘
                                                               │ outcome webhook
                                    ┌──────────────────────────┼───────────────┐
                                    ▼                          ▼                ▼
                             ┌──────────────┐          ┌──────────────┐  ┌──────────────┐
                             │  RECOVERED   │          │   FAILED     │  │  EXPIRED     │
                             │ (revenue in) │          │ (retry per   │  │ (link/window │
                             └──────────────┘          │  policy or   │  │  lapsed)     │
                                                        │  terminal)   │  └──────────────┘
                                                        └──────┬───────┘
                                                               │ if retries remain & policy allows
                                                               └──────────▶ back to ANALYZING/PROPOSED
```

Terminal states: `RECOVERED`, `BLOCKED`, `REJECTED`, `EXPIRED`, and `FAILED` (when no
further retries are permitted). A stale backward-moving event (e.g. a late `failed`
after `RECOVERED`) is ignored to preserve the authoritative terminal state.

---

## 12. Evaluation Architecture

RecoverOS must be able to prove whether its recovery decisions are actually good, on
data with known correct answers. **[PLANNED]**

### Synthetic data

Because we cannot use real merchant/customer financial data, the Failure Lab /
simulator (`packages/simulator`) generates **synthetic datasets** of payments, failure
events, abandonment, and subscription failures with controllable distributions of
recoverable vs. genuinely-lost cases.

### Ground truth

Each synthetic case is generated with a known label: whether it was _actually_
recoverable and, ideally, which action would have recovered it. This ground truth is
the reference against which decisions are scored.

### Training / development data (if applicable)

The first phases use **no learned model**, so there is no training set in the ML sense.
A **development split** is still used to tune deterministic detection rules and policy
thresholds. If a learned risk model is added later, this split becomes its training/
validation data — kept strictly separate from the held-out test set.

### Held-out test set

A portion of synthetic data is **held out** and never used for tuning. Reported metrics
come from this held-out set to avoid overfitting thresholds to the data used to design
them.

### Baseline

A **non-AI baseline** (e.g. "always retry once" or a simple deterministic heuristic) is
run over the same data so the AI-assisted system can be compared against a sensible
control rather than reported in isolation.

### AI-assisted system

The full pipeline (agent + policy engine) is run over the same held-out set to produce
its decisions and simulated outcomes.

### Metrics

Per `EvaluationRun`, the `EvaluationResult` captures at minimum:

- **Precision** — of cases we acted on, how many were genuinely recoverable.
- **Recall** — of genuinely recoverable cases, how many we acted on.
- **False-positive cost** — cost/harm of acting on non-recoverable cases (wasted
  contacts, unnecessary retries).
- **Recovery rate** — fraction of at-risk cases actually recovered.
- **Recovered revenue** — total (simulated) revenue recovered.

Baseline vs. AI-assisted results are reported side by side.

---

## 13. Failure Lab

The Failure Lab deliberately injects adverse conditions to prove the system degrades
safely. Each scenario has an expected, safe outcome that becomes a test. **[PLANNED]**

| Scenario                      | Injected condition                                      | Expected safe behavior                                                                  |
| ----------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Duplicate webhook**         | Same Razorpay event delivered twice                     | Idempotency key dedupes; processed once; no duplicate case/action.                      |
| **Invalid signature**         | Tampered/incorrect HMAC                                 | Rejected before trust boundary; recorded; no pipeline effect.                           |
| **Out-of-order event**        | `paid` before `created`, or stale `failed` after `paid` | Monotonic state machine ignores backward transitions; correct terminal state preserved. |
| **Razorpay API failure**      | Adapter call returns 5xx/error                          | Action marked failed; retried per policy or surfaced; no inconsistent state.            |
| **Timeout**                   | Slow Razorpay or AI call                                | Bounded timeout; async retry/fallback; webhook still acked promptly.                    |
| **LLM unavailable**           | Anthropic API down/unreachable                          | Conservative deterministic fallback (§8); no unbounded action.                          |
| **Malformed AI output**       | Non-schema/invalid proposal                             | Rejected at validation; treated as AI failure → fallback/REVIEW.                        |
| **Duplicate recovery action** | Same action attempted twice                             | Action idempotency key prevents double execution (no double link/retry).                |
| **Policy violation**          | Proposal exceeds limits/cooldown/contact cap            | Policy engine returns BLOCK (or REVIEW); action never executes.                         |

---

## 14. Observability

**[PLANNED]**

- **Structured logging.** JSON logs (e.g. `pino`) with correlation IDs propagated from
  webhook receipt through worker processing, tagged with `tenantId`/`workspaceId`/
  `caseId` (never secrets or full card data).
- **Agent traces.** Every `AgentRun` and `AgentToolCall` is persisted and rendered in a
  trace viewer so a human can see exactly what the AI saw, proposed, and why.
- **Decision audit.** Every policy decision records the rule(s) that fired and the
  inputs, so any ALLOW/REVIEW/BLOCK is explainable and replayable.
- **Metrics.** Operational counters (events processed, actions by outcome, recovery
  rate, queue depth, AI latency/failure rate) surfaced to the analytics dashboard.
- **Health/readiness.** API and worker expose health endpoints for deployment probes.

---

## 15. Security

**[PLANNED]**

- **LLM has no financial authority.** Enforced structurally (agent package cannot import
  the Razorpay adapter) and procedurally (policy engine is the sole execution gate).
- **Deterministic authorization.** The policy engine is pure and unit-tested; no
  network, LLM, or randomness in the decision path.
- **Tenant isolation.** Central `tenantId`/`workspaceId` scoping enforced in a data-layer
  extension, not left to individual queries.
- **RBAC.** Role checks enforced server-side; the frontend never enforces authorization.
- **Webhook integrity.** HMAC-SHA256 verification over the raw body; replay protection
  via event idempotency.
- **Idempotency everywhere.** Ingestion and execution keyed so retries never
  double-charge, double-refund, or double-contact.
- **Secrets management.** Razorpay and Anthropic keys/webhook secrets live server-side
  only (`api`/`worker`), validated at boot via a Zod env schema; never exposed to the
  browser.
- **Append-only audit.** Hash-chained `AuditLog` provides tamper-evidence for financial
  decisions.
- **Least sensitive data.** RecoverOS stores payment metadata and status, not raw card
  data; it relies on Razorpay for anything sensitive.

---

## 16. Deployment Architecture

**[PLANNED]**

```
   Developer / CI (GitHub Actions: lint · typecheck · test · migrate-check)
        │
        ├──────────────▶  Vercel        → apps/web (Next.js)
        │
        ├──────────────▶  Render/Railway → apps/api  (Express, webhook endpoint)
        │
        ├──────────────▶  Render/Railway → apps/worker (async jobs)
        │
        └──────────────▶  Managed PostgreSQL (Render/Railway)
```

- **Frontend:** Vercel (Next.js).
- **Backend + worker:** Render or Railway as separate services (so the webhook API and
  async jobs scale independently).
- **Database:** managed PostgreSQL on the same provider as the backend.
- **Local dev:** Docker Compose brings up PostgreSQL (and, if later needed, Redis) so the
  environment matches production topology.
- **Queue:** Postgres-backed job queue initially (no extra infra); a swap-in path to
  BullMQ + Redis exists if throughput demands it.
- **Node runtime:** pinned to Node 22 LTS via `.nvmrc` + `engines` for reproducible
  builds, independent of the developer's locally installed Node.

---

## 17. Development Phases

Ordered so that the **safety gate exists before the AI can propose executable actions**.

- **Phase 0 — Foundation.** Monorepo (pnpm + Turborepo), TS/lint/prettier config, env
  validation, Docker Compose (Postgres), CI stubs, Node pinning. No product code.
- **Phase 1 — Data & tenancy.** Prisma schema for all §10 entities, migrations,
  tenant-scoping data-layer enforcement, seed data.
- **Phase 2 — Auth & RBAC.** Authentication, roles, memberships, protected API + web
  shell.
- **Phase 3 — Ingestion & webhooks.** Razorpay Test-Mode adapter, signed webhook
  endpoint, idempotent normalized event store, out-of-order handling.
- **Phase 4 — Detection.** Deterministic risk rules → `RecoveryCase`; quantify at-risk
  revenue.
- **Phase 5 — Policy engine.** Pure guardrail library with exhaustive unit tests.
  **Built before the agent.**
- **Phase 6 — Agent.** Claude tools (read-only + propose), schema-validated output,
  `AgentRun`/`AgentToolCall` trace recording.
- **Phase 7 — Approval & execution.** Approval queue UI, action state machine, gated
  Razorpay execution, outcome-verification webhooks.
- **Phase 8 — Simulator & Failure Lab.** Synthetic datasets and injectable failure
  modes.
- **Phase 9 — Evaluation engine.** Held-out evaluation with the §12 metrics vs. a
  baseline.
- **Phase 10 — Analytics & polish.** Dashboards, trace viewer, deployment, CI
  hardening.

Each phase should update the status tags in this document as functionality moves from
`[PLANNED]` to `[IMPLEMENTED]`.

---

## 18. Architectural Decisions

For each significant decision: the choice and, importantly, **why**.

1. **LLM recommends; deterministic code authorizes.**
   _Why:_ Financial safety cannot depend on prompt behavior. An LLM is non-deterministic
   and manipulable; a pure policy engine is testable, replayable, and auditable. This is
   the single most important property of the system.

2. **Agent package cannot import the Razorpay adapter.**
   _Why:_ Make the "LLM has no financial authority" rule **structural**, not a
   convention someone can accidentally violate. The compiler enforces it.

3. **Policy engine is pure and built before the agent (Phase 5 before 6).**
   _Why:_ The safety gate must exist and be trusted before any AI output can become an
   executable proposal. Determinism (no network/LLM/randomness) makes it unit-testable
   to exhaustion.

4. **Separate `api` and `worker` apps.**
   _Why:_ Webhook acknowledgement must be fast; AI and network calls are slow. Splitting
   the request path from async processing protects latency and lets the two scale and
   deploy independently.

5. **Multi-tenant with distinct Tenant and Workspace entities from day one.**
   _Why:_ Retrofitting isolation is dangerous and expensive. Modeling both boundaries
   upfront (even when merchants use one workspace) avoids that risk and supports
   per-workspace credentials/policies later.

6. **Central tenant-scoping in the data layer.**
   _Why:_ Relying on every query author to remember a `tenantId` filter is a data-leak
   waiting to happen. Enforcing it centrally makes isolation the default.

7. **Idempotency and out-of-order handling as first-class concerns.**
   _Why:_ Payment webhooks are famously duplicated and reordered. Without idempotency
   keys and a monotonic state machine, the system would double-charge/contact or corrupt
   case state.

8. **Append-only, hash-chained audit log.**
   _Why:_ Financial decisions must be reconstructable and tamper-evident. Append-only
   with hash chaining gives after-the-fact provability of what happened and why.

9. **Confidence is an input to policy, not decoration.**
   _Why:_ Letting low-confidence proposals force human REVIEW turns AI uncertainty into
   safe behavior instead of silent risk.

10. **Conservative fallback when AI is unavailable or malformed.**
    _Why:_ The system must degrade safely. AI failure must never escalate into an
    unbounded or unauthorized action; it defaults to NO_ACTION/REVIEW within strict
    limits.

11. **Razorpay Test Mode only; adapter isolated.**
    _Why:_ No real money for a buildathon project, and isolating the PSP behind one
    package keeps the rest of the system PSP-agnostic and testable.

12. **Postgres-backed queue first, Redis/BullMQ later.**
    _Why:_ Fewer moving parts to run and deploy during the build, with a clean migration
    path if throughput later justifies dedicated queue infrastructure.

13. **pnpm + Turborepo monorepo.**
    _Why:_ Shared contracts (types, Zod schemas, policy engine) belong in one repo with
    cached, dependency-aware builds; pnpm's strictness prevents phantom dependencies.

14. **Node 22 LTS pinned.**
    _Why:_ Reproducible builds and maximum native-dependency compatibility, independent
    of whatever Node version a developer happens to have installed.

15. **Held-out evaluation against a non-AI baseline.**
    _Why:_ "The AI helps" is only credible if measured on data it wasn't tuned on and
    compared against a sensible control. Otherwise reported gains are just overfitting.

16. **Only documented Razorpay capabilities are assumed.**
    _Why:_ Building on invented endpoints guarantees rework. Exact APIs/events are to be
    confirmed against current Razorpay docs at implementation time.

```

```
