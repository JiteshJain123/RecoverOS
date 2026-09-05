# Razorpay Test Mode Integration (`@recoveros/payments`)

The real Razorpay adapter, running strictly in **TEST MODE**. It replaces the
simulator behind the existing `PaymentRecoveryProvider` interface, so it drops
into the execution layer without any parallel architecture.

```
RecoveryPlan → PolicyEvaluator → ALLOW/REVIEW/BLOCK → RecoveryAction
            → PaymentRecoveryProvider → RazorpayTestProvider → Razorpay (test)
```

The provider is invoked **only** by the `RecoveryActionExecutor`, i.e. after
policy ALLOW (or human-approved REVIEW) and all execution safeguards. It is
never imported by `@recoveros/ai`, so **Gemini can never call Razorpay directly**.

## Test Mode setup

1. Create a Razorpay account and open **Test Mode**.
2. Generate **test** API keys (Settings → API Keys). The key id looks like
   `rzp_test_XXXXXXXX`. A `rzp_live_*` key is **rejected** by config.
3. Put the keys in `.env` (local dev):

```
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=            # reserved; webhooks are NOT in this phase
```

4. Verify the connection (dev only):

```
GET /dev/tenants/:tenantId/razorpay/verify
→ { "mode": "development", "tenantId": "...", "razorpay": { "mode": "test", "ok": true, "latencyMs": 123 } }
```

Missing/blank keys → `503 razorpay_not_configured`. No credentials are ever
returned.

## Environment variables

| Variable | Purpose |
|---|---|
| `RAZORPAY_KEY_ID` | Test key id (`rzp_test_*`). Semi-public; still never returned by APIs. |
| `RAZORPAY_KEY_SECRET` | Test API secret. In-memory only; never stored in Postgres, logged, serialized, or returned. |
| `RAZORPAY_WEBHOOK_SECRET` | Reserved for a later webhook phase (not used here). |

## Razorpay operations implemented

Provider-neutral, no raw passthrough. Each requires a tenant context and
resolves that tenant's credentials through the secure boundary.

| Operation | Razorpay call | Notes |
|---|---|---|
| `fetchPayment` | `GET /payments/:id` | read-only |
| `fetchOrder` | `GET /orders/:id` | read-only |
| `createPaymentLink` | `POST /payment_links` | `reference_id` + idempotency header |
| `fetchPaymentLink` | `GET /payment_links/:id` | read-only |
| `cancelPaymentLink` | `POST /payment_links/:id/cancel` | where supported |
| `capturePayment` | `POST /payments/:id/capture` | **only** via an authorized action |
| `verifyConnection` | `GET /payments?count=1` | harmless auth check (dev endpoint) |

Execution mapping (via `PaymentRecoveryProvider.execute`, reached only after
authorization): `SEND_PAYMENT_LINK` → create payment link (`LINK_CREATED`, no
revenue credited); `RETRY_PAYMENT` → capture the authorized payment referenced in
metadata (`SUCCEEDED` credits revenue only on a real capture); `CONTACT_CUSTOMER`
is not a gateway op (no HTTP call). Capture is **never** attempted just because
Gemini recommends it — it flows through policy → authorization → action state →
safeguards first.

## Provider architecture

- **`RazorpayCredentialSource`** — secure config boundary. `EnvRazorpayCredentialSource`
  (dev) reads env; a production per-tenant secret store (resolving
  `Tenant.secretsRef`) can replace it without changing callers. **The secret is
  never stored in Postgres.**
- **`RazorpayClient`** — the only place with HTTP details: builds the base URL
  from one config constant, HTTP Basic auth from `key_id:key_secret`, a bounded
  timeout (AbortController), error classification, JSON parsing, and secret-free
  observability metadata.
- **Typed schemas** (`zod`) validate the subset of payment / order / payment-link
  responses we consume; anything unexpected → `RazorpayMalformedResponseError`.
- **`RazorpayTestProvider`** — implements both `PaymentRecoveryProvider` (for the
  executor) and `PaymentGatewayOperations` (the bounded operation set).

## Security model

- **Test mode enforced**: `rzp_live_*` rejected; key must be `rzp_test_*`; no real
  money can move.
- **Secrets contained**: the API secret lives only in the credential source /
  Basic-auth header. It is never logged, serialized, put in DB rows, returned by
  endpoints, or included in errors. `redact()` defensively scrubs key ids, Basic
  headers, and `key_secret` from any string; `maskKeyId()` shows only the mode.
- **Tenant isolation**: every operation takes a tenant context and uses that
  tenant's credentials; there is no cross-tenant bleed.
- **Cannot be bypassed**: Razorpay is reachable only through the executor, which
  runs only ALLOW/approved actions; a BLOCKed action and an unapproved REVIEW
  action make no HTTP call. Gemini has no import path to this package.
- **Idempotency**: mutating calls send `x-razorpay-idempotency-key` (and
  `reference_id` for links) so repeats do not double-create.

## Failure handling

The client classifies failures into a typed taxonomy with a `category` and
`retryable` flag: `config`, `auth` (401/403), `timeout`, `rate_limit` (429),
`client_error` (other 4xx), `server_error` (5xx), `malformed`, `network`.

- Direct operations (`fetchPayment`, `verifyConnection`, …) **throw** the typed
  error for callers to handle. The verify endpoint maps them to safe envelopes:
  `503 razorpay_not_configured`, `504 razorpay_timeout`, `502 razorpay_unreachable`.
- `execute()` **catches** gateway errors and returns a terminal
  `FAILED`/`TIMEOUT` recovery result (with a safe `razorpay_<category>` detail),
  so the RecoveryAction state machine stays consistent and no secret leaks.

## Not implemented (by design)

No webhooks (reserved for a later phase), no live credentials, no real money
movement, no raw Razorpay passthrough, no production secret store (env for now,
pluggable interface provided). The recovery **batch** evaluation continues to use
the deterministic simulator (`pnpm recovery:batch`); the Razorpay provider is
wired for real single-action execution behind the policy gate.
