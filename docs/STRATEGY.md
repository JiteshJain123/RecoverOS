# Recovery Strategy Engine (`@recoveros/strategy`)

Phase 3 of RecoverOS. Given a recovery case plus normalized context, the engine
determines the **best bounded recovery intervention** and expresses it as a
strict, provider-neutral **`RecoveryPlan`**.

## Architecture invariant (Track 3)

```
intelligence ──▶ strategy provider ──▶ RecoveryPlan ──▶ policy engine ──▶ (approved) ──▶ payments adapter
 (Phase 2)       (deterministic today,   validated       (deterministic       future           future
                  Gemini later)          here            authorization)       phase            phase
```

- A strategy provider may only **propose**. It never executes a financial
  action, never messages a customer, never calls a PSP, never calls Gemini.
- Gemini produces a **structured recommendation only**. The deterministic policy
  engine decides whether a recommendation is allowed. Only an approved action can
  eventually reach a payment-provider adapter.
- This deterministic strategy layer itself makes **no Gemini/AI calls, no Razorpay
  calls, no messaging, and no retries** — it only proposes plans; those concerns
  live in the AI, policy, execution, and payments layers.

## Strategies

| Strategy | Meaning | Defining action | Executable via a PSP? |
|---|---|---|---|
| `NO_ACTION` | Nothing to do / not allowed | — (none) | n/a |
| `RETRY_PAYMENT` | Re-attempt the charge | `RETRY_PAYMENT` | needs `payment.retry` |
| `SEND_PAYMENT_LINK` | Offer an alternate method | `CREATE_PAYMENT_LINK` | needs `payment_link.create` |
| `CHECKOUT_RECOVERY` | Recover an abandoned/expired checkout | `CREATE_PAYMENT_LINK` (+ optional message) | needs `payment_link.create` |
| `CUSTOMER_REMINDER` | Nudge the customer to pay | `SEND_CUSTOMER_MESSAGE` (+ link) | needs `customer.notify` |
| `HUMAN_REVIEW` | Defer to a human | `FLAG_FOR_HUMAN_REVIEW` | internal only |

A **strategy is an intent, not a guarantee of executability.** Each proposed
action declares the `requiredCapability` it needs; a later payments adapter
advertises the capabilities it actually supports, and policy authorizes. Nothing
here assumes any given PSP can fulfil a strategy.

## RecoveryPlan schema

```jsonc
{
  "caseId": "case_1",
  "strategy": "RETRY_PAYMENT",
  "rationale": "TIMEOUT is typically transient; a bounded retry has a good chance of success.",
  "confidence": 0.85,                       // engine confidence in the STRATEGY CHOICE, [0,1]
  "expectedOutcome": {
    "successProbability": 0.6,              // deterministic heuristic, NOT a model probability
    "description": "Transient failures frequently succeed on a prompt retry.",
    "revenueRecoverableMinor": 500000       // integer, minor currency units
  },
  "riskLevel": "LOW",                       // risk of the intervention itself
  "proposedActions": [
    {
      "actionKind": "RETRY_PAYMENT",
      "purpose": "Re-attempt the charge; timeout/gateway errors are typically transient.",
      "amountMinor": 500000,                // required for money-bearing actions
      "currency": "INR",                    // ISO-4217 alpha-3
      "requiredCapability": "payment.retry",
      "riskLevel": "LOW",
      "ttlSeconds": 86400,                  // expiration/TTL where appropriate
      "idempotencyKey": "rk_case_1_RETRY_PAYMENT_1a2b3c4d",
      "stoppingCondition": { "type": "MAX_ATTEMPTS", "description": "Stop after 3 total attempts.", "limit": 3 }
    }
  ],
  "stoppingConditions": [
    { "type": "PAYMENT_RECOVERED", "description": "Stop once the payment succeeds." },
    { "type": "MAX_ATTEMPTS", "description": "Stop at the retry cap.", "limit": 3 },
    { "type": "TTL_EXPIRED", "description": "Stop if the retry window elapses." }
  ],
  "evidence": [
    { "label": "rootCause", "detail": "TIMEOUT", "source": "intelligence" },
    { "label": "severity", "detail": "MEDIUM", "source": "intelligence" }
  ],
  "modelMetadata": {
    "provider": "deterministic",            // NEVER pretends to be AI
    "strategyEngine": "deterministic-rules",
    "version": "strategy-rules-v1",
    "deterministic": true,
    "ruleId": "transient_retry"
  },
  "generatedAt": "2026-09-03T10:00:00.000Z"
}
```

**Money**: every amount is an integer in **minor** units and suffixed `Minor`;
currencies are ISO-4217 alpha-3 codes.

### Stopping-condition types

`PAYMENT_RECOVERED`, `MAX_ATTEMPTS`, `TTL_EXPIRED`, `POLICY_BLOCK`,
`HUMAN_DECISION_REQUIRED`, `CUSTOMER_OPT_OUT`, `AMOUNT_CEILING`.

## Deterministic decision rules

The `DeterministicRecoveryStrategyProvider` gives a **safe baseline without any
AI**. First match wins (safest/most conclusive checks first):

| # | Condition | Strategy | Rule id |
|---|---|---|---|
| 0 | payment `CAPTURED` or case `RECOVERED` | `NO_ACTION` | `already_recovered` |
| 1 | `policyState = BLOCKED` or case `BLOCKED` | `NO_ACTION` | `policy_blocked` |
| 2 | case terminal (`REJECTED`/`EXPIRED`/`FAILED`) | `NO_ACTION` | `case_terminal` |
| 3 | root cause `UNKNOWN`/unclassified | `HUMAN_REVIEW` | `unknown_root_cause` |
| 4 | severity `CRITICAL` (high value/risk) | `HUMAN_REVIEW` | `critical_severity` |
| 5 | `BANK_DECLINE`, repeated (≥2), policy `REVIEW` | `HUMAN_REVIEW` | `repeated_bank_decline_review` |
| 5 | `BANK_DECLINE`, repeated (≥2), policy `OK` | `NO_ACTION` | `repeated_bank_decline_no_action` |
| 6 | `BANK_DECLINE`, single | `SEND_PAYMENT_LINK` | `single_bank_decline_link` |
| 7 | `INSUFFICIENT_FUNDS` | `CUSTOMER_REMINDER` | `insufficient_funds_reminder` |
| 8 | `TIMEOUT`/`GATEWAY_ERROR`, retries left | `RETRY_PAYMENT` | `transient_retry` |
| 8 | `TIMEOUT`/`GATEWAY_ERROR`, retry cap hit (≥3) | `HUMAN_REVIEW` | `retry_cap_reached` |
| 9 | `CUSTOMER_ABANDONMENT`/`EXPIRED_CHECKOUT`/expired link | `CHECKOUT_RECOVERY` | `checkout_recovery` |
| 10 | fallback | `HUMAN_REVIEW` | `fallback_human_review` |

Every decision carries a `rationale` and an `evidence[]` bundle, so the engine
always explains **why** it chose a strategy. The provider is pure: identical
input always yields an identical plan, and `modelMetadata.provider` is
`"deterministic"` — it never masquerades as a model.

## Provider interface (Gemini boundary)

```ts
interface RecoveryStrategyProvider {
  readonly name: string;
  generatePlan(ctx: RecoveryStrategyContext): Promise<RecoveryPlan>;
}
```

- `DeterministicRecoveryStrategyProvider` — implemented now.
- A future `GeminiRecoveryStrategyProvider` implements the **same** interface and
  emits the **same** validated schema. Callers do not change. Its output remains
  a recommendation gated by policy.

## Idempotency

`generateIdempotencyKey()` is a pure function of stable case state
(`tenantId, caseId, actionKind, rootCause, amountMinor, retryCount` + ruleset
version), rendered `rk_<caseId>_<ACTION>_<fnv1a-hex>`. It is:

- **deterministic** — re-planning an unchanged case yields the same key, so an
  action is never made executable-again by accident; and
- **attempt-sensitive** — a new failed attempt (higher `retryCount`) yields a new
  key, so a genuinely new retry is permitted.

## Validation

`validateRecoveryPlan()` (zod, strict) is the gate before the execution layer.
Beyond field/enum/type checks it enforces:

- `confidence`/`successProbability` ∈ [0,1]; amounts are non-negative integers;
  currencies match `^[A-Z]{3}$`.
- `NO_ACTION` carries **no** proposed actions.
- `HUMAN_REVIEW` carries **no** financial action (`RETRY_PAYMENT`/`CREATE_PAYMENT_LINK`).
- Each non-trivial strategy contains its **defining** action kind.
- Money-bearing actions carry a positive `amountMinor` **and** a `currency`.
- Idempotency keys are unique within a plan.
- Unknown/extra keys are rejected (`.strict()`); `evidence` and
  `stoppingConditions` are non-empty.

`assertValidRecoveryPlan()` throws `RecoveryPlanValidationError` (carrying the
issue list) for callers that want fail-fast at the boundary.

## Audit events

`RecoveryStrategyService` emits append-only audit events through a
`StrategyAuditSink` port (in-memory for tests, `PrismaStrategyAuditSink` writes
to `AuditLog`):

- `recovery.strategy.generated` — a valid plan was produced.
- `recovery.strategy.rejected` — a produced plan failed validation (with the
  issues); the invalid plan is **not** returned.
- `recovery.strategy.changed` — the chosen strategy differs from the case's
  previously recorded strategy.

Audit metadata contains only ids, strategy/rule names, confidences, capabilities
and validation issues — **never** secrets or provider credentials.

## Usage

```ts
import {
  RecoveryStrategyService,
  DeterministicRecoveryStrategyProvider,
  InMemoryStrategyAuditSink,
  createDeterministicStrategyService, // production: Prisma-backed audit
} from "@recoveros/strategy";

const service = new RecoveryStrategyService({
  provider: new DeterministicRecoveryStrategyProvider(),
  audit: new InMemoryStrategyAuditSink(),
});
const plan = await service.generate(ctx); // validated RecoveryPlan or throws
```

## What is intentionally NOT here

No Gemini/AI call, no Razorpay/PSP call, no customer messaging, no actual payment
retry, no authorization (that is the policy engine), no execution. This package
produces and validates a recommendation and records that it did so.
