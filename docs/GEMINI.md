# Gemini Recovery Provider (`@recoveros/ai`)

Google Gemini is the RecoverOS AI provider. It produces **advisory** recovery
recommendations that conform to the Phase 3 `RecoveryPlan` contract. It never
executes anything.

## Architecture

```
payment context (tenant-scoped, normalized)
      ↓  minimal whitelisted prompt
Gemini (structured output, fixed enums)
      ↓  GeminiOutput (strategy + reasoning only)
enrichment (amounts/idempotency/capabilities from TRUSTED context, not the model)
      ↓
strict RecoveryPlan validation  (@recoveros/strategy)
      ↓
deterministic Policy Engine  (@recoveros/policy — authorizes; later phase)
      ↓
possible execution  (payments adapter — later phase; NOT implemented)
```

Gemini plugs into the existing `RecoveryStrategyProvider` interface, so callers
are identical to the deterministic provider. Its output is a recommendation,
gated by policy; only an approved action could ever be executed.

## Environment variables

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Gemini API key. Kept in memory only; never logged/serialized. Blank ⇒ Gemini disabled (dev endpoint returns `503 gemini_not_configured`). |
| `GEMINI_MODEL` | Model id used everywhere (default `gemini-3.5-flash`). Never hardcoded. |

No Anthropic SDK, no `ANTHROPIC_API_KEY`. The REST client uses global `fetch`
(no SDK dependency); the key travels in the `x-goog-api-key` header, never in a
URL or log.

## Structured output schema

Gemini returns a single JSON object (enforced via `responseMimeType:
application/json` + `responseSchema`, validated again with zod on return):

```jsonc
{
  "recommendation": "RETRY_PAYMENT",        // enum: NO_ACTION | RETRY_PAYMENT | SEND_PAYMENT_LINK | CHECKOUT_RECOVERY | CUSTOMER_REMINDER | HUMAN_REVIEW
  "rationale": "Transient bank timeout; a bounded retry is warranted.",
  "evidenceRefs": ["signal:BANK_TIMEOUT", "retryCount:1"],  // references to provided evidence, not new facts
  "confidence": 0.8,                         // [0,1]
  "riskLevel": "LOW",                        // enum LOW|MEDIUM|HIGH|CRITICAL
  "expectedOutcome": { "successProbability": 0.6, "description": "…" },
  "proposedActionKinds": ["RETRY_PAYMENT"],  // advisory; concrete actions are built deterministically
  "stoppingConditions": [{ "type": "PAYMENT_RECOVERED", "description": "…" }]
}
```

**Auditability, not hidden chain-of-thought:** the model returns a concise
rationale, evidence references, confidence, risk level, expected outcome, and
stopping conditions — never step-by-step private reasoning. Only these concise
fields are stored.

**The model never emits money or identifiers.** Amounts, currency, capabilities,
idempotency keys, and per-action stopping conditions are filled deterministically
from the trusted context, so Gemini cannot invent payment amounts, customer
information, or payment status. The enriched plan is then validated against the
strict `RecoveryPlan` schema; anything inconsistent is rejected.

## Safety boundaries

The system instruction tells Gemini explicitly that it:
- is a recommendation engine and **cannot authorize/execute money movement**;
- **cannot exceed policy limits** (provided as constraints);
- must return **NO_ACTION** when evidence is insufficient;
- must prefer **HUMAN_REVIEW** for ambiguous/high-risk cases;
- may only reference provided evidence (no invented facts).

Provider-side guardrails enforce these regardless of the model:
- **low-confidence actionable** recommendations (confidence < 0.4) are downgraded
  to `HUMAN_REVIEW`;
- output is schema-validated twice (model JSON, then the enriched `RecoveryPlan`);
- **fixed temperature 0** by default for reproducibility.

The prompt is built from a whitelist (normalized payment info, failure history,
customer *aggregate* recovery history, revenue-at-risk, deterministic signals,
compact policy constraints). It never contains API keys, database URLs, secrets,
credentials, or raw PII (email/phone/name).

## AgentRun / AgentToolCall behavior

`GeminiRecoveryService` wraps each call in an agent trace (tenant-scoped):

- **AgentRun** — created `RUNNING`; completed as `SUCCEEDED`, `TIMEOUT`
  (timeouts), `INVALID_OUTPUT` (malformed/unsafe output), or `FAILED` (config/
  network/HTTP). Records `model`, latency, and token counts. `error` holds a
  concise `category: message` label — never secrets or raw payloads.
- **AgentToolCall** — one row (`gemini.generateContent`) with structured input
  metadata (provider, model, caseId, rootCause, severity, amount-at-risk,
  currency, retryCount, signalCount) and structured output (strategy, confidence,
  riskLevel, requestId, attempts, coercion flag, action kinds). The raw prompt is
  **not** stored. `isError` flags failures.
- **RecoveryDecision** — upserted per AgentRun on success (strategy mapped to the
  bounded `RecoveryActionType`; amount only for actionable strategies).
- **AuditLog** — `recovery.strategy.gemini.generated` / `.failed`
  (`actorType: AGENT`), metadata limited to ids/strategy/confidence/evidence refs.

### Retries

Only **safe transport/timeout** failures are retried (bounded, default 3
attempts): `GeminiTimeoutError` and retryable HTTP (5xx/429) / network errors.
Malformed output and config errors are **never** retried. Nothing financial is
ever retried — Gemini calls are advisory only.

## Development-only endpoint

```
POST /dev/tenants/:tenantId/recovery-cases/:caseId/recommend
```

Registered only when `NODE_ENV !== "production"` (re-checked at request time). It
requires tenant context, verifies the case belongs to the tenant (`404`
otherwise), creates an AgentRun, calls Gemini, validates the output, upserts a
RecoveryDecision, writes an audit event, and returns the structured decision with
`"executed": false`. It does **not** execute the proposed action, call Razorpay,
or message anyone.

Error envelope: `404 not_found`, `503 gemini_not_configured`, `504 gemini_timeout`,
`502 gemini_invalid_output`, `502 gemini_request_failed`.

## Testing

Tests use a scripted **mock Gemini client** (`MockGeminiClient`) and the
in-memory store — **no real API key or network required**. Coverage: valid
structured response, malformed response, timeout, API failure, missing API key,
low-confidence downgrade, HUMAN_REVIEW, NO_ACTION, tenant isolation, and that no
secret ever appears in the prompt or any serialized record.

## Not implemented (by design)

No Razorpay execution, no customer messaging, no policy authorization wiring
(the policy engine remains the later gate). Gemini is strictly advisory.
