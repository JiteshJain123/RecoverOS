# Razorpay Test Mode Integration

How RecoverOS connects the **Razorpay Test Mode** provider and its webhook
pipeline into the recovery lifecycle, and the safety boundaries that keep the AI
away from money movement.

This supersedes the earlier `docs/RAZORPAY.md` (a pre-webhook phase note). The
provider still drops in behind the existing `PaymentRecoveryProvider` interface,
but the lifecycle now also covers webhook reconciliation, recovery accounting,
stopping rules, a failure harness, and batch evaluation.

## Lifecycle architecture

```
Payment intelligence
        ↓
RecoveryCase
        ↓
Gemini RecoveryPlan            (proposes a strategy only)
        ↓
PolicyEvaluator
        ↓
ALLOW / REVIEW / BLOCK
        ↓
RecoveryAction                 (authorized; REVIEW needs human approval)
        ↓
Execution safeguards           (expiry, stale approval, policy version,
        ↓                        max attempts, already-recovered, duplicate)
Selected provider              (SERVER-SIDE selection — never Gemini)
   ┌────┴─────────────┐
   ↓                  ↓
SIMULATED       RAZORPAY_TEST
   ↓                  ↓
Outcome ←──── Webhook / API ────→
        ↓
Outcome verification           (provider facts must prove the outcome)
        ↓
Recovered revenue              (credited only on proven capture)
        ↓
Audit trail
```

Orchestrated by `RecoveryLifecycle` (`packages/lifecycle/src/lifecycle.ts`):
`strategy → policy → authorize → (approve) → execute → replay webhook →
reconcile → verify → recovered revenue → audit`.

## Two execution modes

Selection is a pure function of **server configuration** and is implemented in
`packages/lifecycle/src/provider-mode.ts`.

| Mode | When used |
|---|---|
| `SIMULATED` | Default. Deterministic simulator (`SimulatedRecoveryProvider`). Always available; used for evaluation and whenever Razorpay is not fully enabled. |
| `RAZORPAY_TEST` | Real Razorpay **Test Mode** adapter (`RazorpayTestProvider`). Effective only when every gate below passes. |

`RAZORPAY_TEST` is honoured **only when all** of these hold, otherwise selection
falls back safely to `SIMULATED` (never an error, never a live call):

1. `EXECUTION_PROVIDER=RAZORPAY_TEST`
2. `RAZORPAY_TEST_ENABLED=true` (explicit dev/test enable flag)
3. Test credentials present (`RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`)
4. A Razorpay adapter instance was actually supplied to `selectExecutionProvider`

Per-action, `RAZORPAY_TEST` still additionally requires: the action is authorized
by policy (`ALLOW`, or `REVIEW` with approval), the action state is `APPROVED`,
and every execution safeguard passes.

The selected mode and the reason (`enabled`, `razorpay_test_not_enabled`,
`missing_credentials`, `razorpay_provider_unavailable`, `configured`) are carried
in the lifecycle trace for observability.

## Credential configuration

```
# .env (local dev / test only)
EXECUTION_PROVIDER=RAZORPAY_TEST        # default SIMULATED
RAZORPAY_TEST_ENABLED=true              # default false
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxx  # rzp_test_* only; rzp_live_* is rejected
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_ACCOUNT_ID=acc_xxxxxxx # maps an account → tenant (see below)
RAZORPAY_WEBHOOK_TENANT_ID=tnt_xxxxxxxx
```

Validated centrally in `packages/config/src/index.ts` (`loadEnv`). Missing
credentials do not crash the system — they simply keep it in `SIMULATED`.

- `RAZORPAY_KEY_SECRET` lives only in the credential source / Basic-auth header.
  It is **never** stored in Postgres, logged, serialized, returned by an API, or
  put in an error. `redact()` defensively scrubs it from strings.
- **Test Mode is enforced**: a `rzp_live_*` key id is rejected by config, so no
  real money can move.

## Provider boundary — why Gemini cannot execute money actions

Gemini (via `@recoveros/ai` / the strategy provider) **only proposes a
`RecoveryPlan`**. It:

- never chooses the execution provider (that is server config only), and
- has no import path to `@recoveros/payments`; it cannot call Razorpay.

The Razorpay adapter is reachable **only** through `RecoveryActionExecutor`,
which runs only for an action that is `ALLOW` (or approved `REVIEW`) **and**
passes every safeguard. This is proven by tests (see Security invariants).

## Razorpay operations implemented

Provider-neutral (minor units, no secrets, no raw passthrough). Each requires a
tenant context resolved through the secure credential boundary.

| Operation | Razorpay call | Notes |
|---|---|---|
| `fetchPayment` | `GET /payments/:id` | read-only |
| `fetchOrder` | `GET /orders/:id` | read-only |
| `createPaymentLink` | `POST /payment_links` | `reference_id` + idempotency key |
| `fetchPaymentLink` | `GET /payment_links/:id` | read-only |
| `cancelPaymentLink` | `POST /payment_links/:id/cancel` | where supported |
| `capturePayment` | `POST /payments/:id/capture` | **only** for an `authorized` payment |
| `verifyConnection` | `GET /payments?count=1` | harmless auth check (dev endpoint) |

Execution mapping (`PaymentRecoveryProvider.execute`, reached only after
authorization):

- `SEND_PAYMENT_LINK` → create a Test Mode payment link → `LINK_CREATED`
  (**no revenue credited**). Amount/currency come from the verified case/payment;
  `reference_id` = the deterministic idempotency key; a bounded expiry and a safe
  internal reference are set; only provider references are stored; an audit event
  is written.
- `RETRY_PAYMENT` → **capture an authorized payment** referenced in metadata.
  This is never a blind re-charge: the provider first `fetchPayment`s and only
  captures when `status === "authorized"`. Any other state returns a classified
  capability error (`capability:not_capturable:<status>` /
  `capability:no_payment_reference`) — it does **not** fake success.
- `CONTACT_CUSTOMER` → not a gateway/money operation; no HTTP call.

### Idempotency

Payment-link creation is idempotent. The approved action carries a unique
deterministic idempotency key, sent as both `reference_id` and the
`x-razorpay-idempotency-key` header. On a retried execution the action is already
terminal, so the executor returns the **existing** provider reference instead of
creating a second link — verified by the "duplicate action → no duplicate
provider call" test and by the batch idempotency run (0 provider calls on the
second pass).

## Webhook verification & reconciliation

```
Razorpay webhook
      ↓ signature verification (HMAC-SHA256 over the raw body, X-Razorpay-Signature)
      ↓ idempotency (dedupe by event id; duplicate = safe success, no re-apply)
PaymentEvent (trusted, persisted)
      ↓
Payment state reconciliation (monotonic; out-of-order never downgrades)
      ↓
RecoveryCase
      ↓
RecoveryAction outcome
      ↓
recoveredRevenueMinor (credited only on a verified capture)
```

Implemented in `packages/webhooks` (`signature.ts`, `processor.ts`,
`reconcile.ts`, `tenant-map.ts`) with reconciliation into the action store via
`packages/lifecycle/src/reconciler.ts`.

- **Signature**: a wrong signature, wrong secret, or tampered body is rejected
  and persists no trusted event.
- **Idempotency**: a duplicate delivery is acknowledged as a safe success and
  never double-applies; replays are idempotent.
- **Out-of-order**: `captured` then a late `authorized` never downgrades or
  re-credits.
- **200 ≠ success**: an action is marked `SUCCEEDED` (and revenue credited) only
  when provider facts prove the expected outcome — a signature-verified
  `payment.captured` (or an immediate real capture). An HTTP 200 alone is never
  treated as success.

### Webhook events handled

`payment.captured` (→ recovered), `payment.authorized` (advances state, not
recovered), `payment.failed` (→ FAILED), `payment.refunded` (→ REFUNDED),
`order.paid` (captures the order's payment). Unknown events are acknowledged
without changing canonical state.

## Tenant mapping

A webhook is trusted only if its provider `account_id` matches
`RAZORPAY_WEBHOOK_ACCOUNT_ID`; it is then mapped to `RAZORPAY_WEBHOOK_TENANT_ID`
(`StaticProviderAccountResolver`). An **unmapped account is rejected** — the
tenant is never guessed. Every gateway operation also takes an explicit tenant
context and uses that tenant's credentials, so there is no cross-tenant bleed.

## Action lifecycle & stopping rules

Bounded stopping rules enforced by the executor / safeguards (
`packages/execution`):

- payment already captured → stop
- payment already recovered → stop / `BLOCK` with zero provider calls
- action expired → stop (zero provider calls)
- stale approval → stop (zero provider calls)
- maximum attempts reached → stop
- policy version changed after authorization → re-evaluate / stop
- provider reports permanent failure → stop
- duplicate action → return existing reference, no duplicate provider call

## Recovery accounting rules

Single source of truth: `packages/lifecycle/src/accounting.ts`. Revenue is
credited **only** on a genuine capture.

| Event | Recovered? |
|---|---|
| capture succeeded | ✅ yes |
| webhook `payment.captured` (verified) | ✅ yes |
| payment link created | ❌ no |
| payment link expired / failed | ❌ no |
| provider timeout | ❌ no |
| duplicate execution / webhook | ❌ no (never double-credited) |
| provider capability error | ❌ no |

`recoveredRevenueMinor` is credited from the action's captured amount; provider
evidence (the external reference) is stored for every successful recovery.
`revenueStillAtRiskMinor` is the complement over the dataset.

## Failure handling & the development failure harness

The client classifies failures into a typed taxonomy (`config`, `auth`,
`timeout`, `rate_limit`, `client_error`, `server_error`, `malformed`, `network`).
`execute()` catches gateway errors and returns a terminal `FAILED`/`TIMEOUT`
recovery result (safe `razorpay_<category>` detail) so the state machine stays
consistent and no secret leaks.

A **controlled, development-only** failure harness
(`packages/lifecycle/src/failure-harness.ts`) builds deterministic mock
transports and signed webhook fixtures — never production failure mechanisms,
real credentials, or real money. It can reproduce: provider timeout, provider
500, webhook delayed, duplicate webhook, out-of-order webhook, successful
payment, and failed payment.

## Development endpoints (non-production only)

Registered only when `NODE_ENV !== "production"`
(`apps/api/src/lifecycle-routes.ts`):

- `POST /dev/tenants/:tenantId/recovery/lifecycle/:caseId` — run one seeded case
  end-to-end and return a complete trace: case, strategy, policy decision,
  action, provider + mode + reason, provider reference, webhook events, final
  outcome, recovered revenue, and audit events.
- `POST /dev/tenants/:tenantId/recovery/lifecycle-batch` — batch evaluation over
  the seeded dataset, plus an idempotency re-run.

CLI equivalents: `pnpm recovery:lifecycle` (lifecycle batch, both runs) and
`pnpm recovery:batch` (simulator batch).

## Batch metrics

`LifecycleBatchEvaluator` reports: cases processed, strategies generated, ALLOW /
REVIEW / BLOCK, actions attempted, provider calls, successful recoveries, failed
recoveries, provider failures, duplicate executions prevented,
`recoveredRevenueMinor`, `revenueStillAtRiskMinor`, `recoveryRate`, and
invalid/false success claims prevented. A second run makes **0 provider calls**
and prevents all duplicates while reporting identical financial metrics.

## Security invariants (proven by tests)

- Gemini cannot directly execute Razorpay (no execute surface / no import path).
- `BLOCK` → zero Razorpay calls.
- `REVIEW` without approval → zero Razorpay calls.
- expired action → zero Razorpay calls.
- stale approval → zero Razorpay calls.
- duplicate action → zero duplicate Razorpay calls.
- secrets never appear in audits, traces, results, or stored payloads.
- tenant isolation: no cross-tenant bleed.

## Not in scope / limitations

- **Test Mode only.** Live Mode is never enabled; `rzp_live_*` is rejected.
- No real customer messages are sent; `CONTACT_CUSTOMER` performs no gateway call.
- The webhook account→tenant map is static (env). A production build can swap in
  a per-tenant secret store resolving `Tenant.secretsRef` without changing
  callers.
- If real Razorpay credentials are absent, everything still runs (and all tests
  pass) via the simulator and deterministic mocks.
