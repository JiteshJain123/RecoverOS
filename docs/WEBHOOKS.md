# Razorpay Webhook Ingestion (`@recoveros/webhooks`)

A financial-integrity pipeline that turns **signed** Razorpay webhook events into
canonical facts (`Payment` + `PaymentEvent`) and lets the recovery engine decide
what happens next. It **never** executes recovery, sends messages, or calls the
Razorpay API from the handler.

```
Razorpay webhook (raw body)
   → HMAC-SHA256 signature verification (raw bytes)
   → event-id idempotency
   → provider payload validation (typed adapter)
   → tenant/provider mapping (verified account_id → tenant)
   → canonical PaymentEvent
   → payment state reconciliation (out-of-order safe)
   → case reconciliation (facts only)
   → audit trail
```

## Webhook endpoint

```
POST /webhooks/razorpay
Headers: X-Razorpay-Signature, X-Razorpay-Event-Id
Body: raw JSON (bytes)
```

Mounted **before** the JSON body parser and using its own `express.raw` parser,
so the handler receives the exact raw bytes Razorpay signed. Responses are a safe
envelope only: `{ status, code?, webhookId? }` — never credentials or raw
payloads.

HTTP mapping: `200` processed / duplicate / acknowledged-unsupported; `401`
invalid signature; `400` invalid payload / unmapped account; `500` processing
failed (provider re-delivers → idempotent retry); `503` secret not configured.

## Signature verification strategy

HMAC-SHA256 over the **raw request body** using `RAZORPAY_WEBHOOK_SECRET`,
compared to `X-Razorpay-Signature` in **constant time** (`timingSafeEqual`). The
body is **never** parsed/re-stringified before verification (any re-serialize
changes the bytes and breaks the HMAC). An invalid signature is rejected and **no
trusted event is persisted**; no recovery is triggered. The secret is used only
for verification — never stored, logged, or returned.

## Idempotency strategy

The idempotency key is the Razorpay **`X-Razorpay-Event-Id`** header, scoped per
tenant via `@@unique([tenantId, providerEventId])` on `WebhookEvent` (falling
back to a deterministic composite if the header is absent). On re-delivery:

- already `PROCESSED` → audited `webhook.duplicate`, returns `200` (safe success);
  no duplicate `PaymentEvent`, no duplicate case, no duplicate action.
- previously `FAILED` (partial) → the **same** row is reused and reprocessed;
  `PaymentEvent` creation is guarded per `(webhook, type)` so nothing duplicates.

Replaying the same event any number of times yields exactly one webhook row and
one payment event.

## Tenant mapping

A webhook **never trusts a client-supplied tenantId**. The tenant is derived from
the **verified** provider `account_id` in the signed payload via an explicit,
configured mapping (`ProviderAccountResolver`). For Test Mode this is a single
`RAZORPAY_WEBHOOK_ACCOUNT_ID → RAZORPAY_WEBHOOK_TENANT_ID` pair from env; an
**unmapped account is rejected** (`unmapped_account`), never guessed. Production
can swap in a table-backed resolver without changing the processor.

## Event types supported

`payment.authorized`, `payment.captured`, `payment.failed`, `payment.refunded`,
`payment.partially_refunded`, `order.paid`. Each is parsed through a typed
adapter (`zod`) that validates the envelope and the entities we read and tolerates
extra provider fields; a malformed body is rejected (`invalid_payload`) — shapes
are never guessed. Unknown events are acknowledged (`200`) without changing
canonical state.

**Out-of-order safe reconciliation:** canonical statuses are ranked
(`CREATED<AUTHORIZED<FAILED<CAPTURED<PARTIALLY_REFUNDED<REFUNDED`) and the payment
status only ever **advances** — a late `payment.authorized` can never downgrade a
`payment.captured`.

## Payload storage

The original provider payload is stored on `WebhookEvent.payload` wrapped with an
explicit marker `{ provider: "RAZORPAY", testMode: true, storedAt, payload }`.
**No API/webhook secrets are ever stored or logged** (they live only in headers /
the secret source, never in the body).

## Retry behavior

Processing is inline and idempotent; there is **no Redis**. Safe retry is
Postgres-backed: a failure after a valid event marks the `WebhookEvent` `FAILED`
and returns `500`, so Razorpay re-delivers; the retry reuses the same row and
skips already-created facts. (Heavier async processing could be moved to a
Postgres-backed worker later behind the same store.)

## Failure behavior summary

- **Invalid signature** → reject, persist nothing trusted, no recovery.
- **Invalid payload** → reject `400`, audit `webhook.processing_failed`, create no
  financial actions.
- **Processing failure after a valid event** → mark `FAILED`, preserve
  idempotency, return `500` for a safe retry.

## Audit trail

`webhook.received`, `webhook.signature_verified`, `webhook.duplicate`,
`webhook.rejected`, `webhook.processed`, `webhook.processing_failed`,
`payment.state_changed`. Metadata is secret-free.

## Development harness

`buildWebhookFixture(eventType, secret, opts)` generates a realistic, **signed**
Razorpay payload for local replay/tests — no Razorpay call, no third-party
service, all synthetic ids. Tests use a known deterministic secret.

## Environment variables

| Variable | Purpose |
|---|---|
| `RAZORPAY_WEBHOOK_SECRET` | HMAC secret for signature verification (in-memory only). |
| `RAZORPAY_WEBHOOK_ACCOUNT_ID` | The Test Mode provider account id that is trusted. |
| `RAZORPAY_WEBHOOK_TENANT_ID` | The RecoverOS tenant that account maps to. |

## Not implemented (by design)

No recovery execution from the handler (the engine decides), no customer
messaging, no Razorpay API calls, no third-party webhook services, no Redis, no
live credentials.
