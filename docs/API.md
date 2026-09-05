# RecoverOS Dashboard API (`/api/v1/intelligence`)

Read-only, tenant-scoped endpoints that answer a merchant's payment-recovery
questions. Every response is derived from the deterministic Phase 2 intelligence
engine and the persisted recovery cases. **Nothing here executes recovery, calls
Razorpay/Gemini, or messages customers.**

## Conventions

### Tenant context (security)
- Tenant identity comes **only** from the `x-tenant-id` request header, which
  stands in for the authenticated principal until production auth is implemented.
- Handlers never read a `tenantId` from the path, query, or body.
- Supplying `tenantId` in the query/body is rejected with `tenant_override_forbidden`
  — a client can never override the context.
- Every query is scoped to the resolved tenant. A resource id that belongs to a
  different tenant (or does not exist) returns **404** — existence is never
  leaked across tenants.

### Money
- All monetary fields are integers in **minor** currency units (e.g. paise) and
  are suffixed `Minor`.
- Every money-bearing response carries a `money` descriptor:
  `{ "unit": "minor", "exponent": 2, "currency": "INR" }`.

### Error envelope
All errors share one shape:
```json
{ "error": { "code": "validation_error", "message": "…", "details": [ … ] } }
```
| HTTP | code | when |
|------|------|------|
| 400 | `validation_error` | invalid query/path params (`details` lists the issues) |
| 400 | `tenant_override_forbidden` | client supplied `tenantId` in query/body |
| 401 | `tenant_context_required` | missing `x-tenant-id` header |
| 404 | `not_found` | case/payment not found in the tenant scope |
| 500 | `internal_error` | unexpected server error (no internals leaked) |

Secrets, DB credentials, and connection strings are never returned by any endpoint.

---

## `GET /api/v1/intelligence/summary`
Portfolio-level revenue-at-risk answer.

**Response**
```json
{
  "tenantId": "seed_tenant_1",
  "generatedAt": "2026-08-01T09:00:00.000Z",
  "money": { "unit": "minor", "exponent": 2, "currency": "INR" },
  "revenueAtRiskMinor": 34116900,
  "affectedPayments": 26,
  "affectedCustomers": 18,
  "highPriorityCases": 8,
  "reviewRequiredCases": 9,
  "recoveredRevenueMinor": 2272900,
  "recoverySuccessRate": 0.5,
  "byRootCause": [ { "rootCause": "BANK_DECLINE", "cases": 8, "amountAtRiskMinor": 11385900 } ],
  "bySeverity": [ { "severity": "CRITICAL", "cases": 9, "amountAtRiskMinor": 18556000 } ]
}
```
- **at risk** = cases in an open status (`DETECTED, ANALYZING, PROPOSED, PENDING_APPROVAL, AUTHORIZED, EXECUTING`).
- **reviewRequired** = open cases with status `PENDING_APPROVAL` **or** severity `CRITICAL`.
- **recoverySuccessRate** = `RECOVERED / (RECOVERED + FAILED)`, or `null` when no resolved cases exist.

---

## `GET /api/v1/intelligence/cases`
Filterable, paginated case list.

**Query parameters** (all optional)
| param | type | notes |
|-------|------|-------|
| `status` | enum | `DETECTED … EXPIRED` |
| `severity` | enum | `LOW\|MEDIUM\|HIGH\|CRITICAL` |
| `rootCause` | enum | `BANK_DECLINE … UNKNOWN` |
| `minAmountMinor` | int ≥ 0 | minimum amount at risk (minor units) |
| `minPriority` | int 0–100 | minimum priority score |
| `from`, `to` | ISO date/time | filter on `openedAt` (inclusive); `from ≤ to` |
| `page` | int ≥ 1 | default `1` |
| `pageSize` | int 1–100 | default `20` |
| `sort` | `priority\|amount\|recent` | default `priority` |

Sorting is **stable**: the chosen key, then `openedAt desc`, then `id asc` as a tiebreaker.

**Response**
```json
{
  "tenantId": "seed_tenant_1",
  "page": 1, "pageSize": 20, "total": 26, "totalPages": 2,
  "sort": "priority",
  "filters": { "severity": "CRITICAL" },
  "money": { "unit": "minor", "exponent": 2, "currency": "INR" },
  "items": [
    {
      "id": "cmtj…", "status": "DETECTED", "reason": "FAILED_PAYMENT",
      "rootCause": "GATEWAY_ERROR", "severity": "CRITICAL", "priorityScore": 67,
      "amountAtRiskMinor": 2445500, "currency": "INR",
      "paymentId": "seed_payment_1_059", "customerId": "seed_customer_1_015",
      "openedAt": "2026-…", "lastDetectedAt": "2026-…"
    }
  ]
}
```

---

## `GET /api/v1/intelligence/cases/:id`
Full case detail (the "why" view). Returns **404** if the case is not in the tenant scope.

**Response (abridged)**
```json
{
  "id": "cmtj…", "tenantId": "seed_tenant_1", "status": "DETECTED",
  "reason": "FAILED_PAYMENT", "rootCause": "GATEWAY_ERROR", "severity": "CRITICAL",
  "priorityScore": 67, "amountAtRiskMinor": 2445500, "currency": "INR",
  "money": { "unit": "minor", "exponent": 2, "currency": "INR" },
  "openedAt": "…", "resolvedAt": null, "lastDetectedAt": "…", "detectionRuleVersion": "detect-v1",

  "customer": { "id": "…", "name": "…", "email": "…", "phone": "…" },
  "payment":  { "id": "…", "status": "FAILED", "amountMinor": 2445500, "currency": "INR",
                "failureCode": "gateway_error", "paymentRef": "seed_rzp_payment_…", "orderRef": "seed_rzp_order_…" },
  "paymentHistory": [ { "id": "…", "status": "…", "amountMinor": 0, "createdAt": "…" } ],
  "eventTimeline": [ { "eventType": "PAYMENT_CREATED", "rawType": "payment.created", "occurredAt": "…" } ],

  "detectedSignals": [ { "type": "FAILED_PAYMENT", "severity": "CRITICAL", "confidence": 0.99, "rootCause": "GATEWAY_ERROR", "evidence": { … } } ],
  "scoreComponents": { "score": 67, "formulaVersion": "priority-v1", "components": [ { "key": "amount", "value": 1, "weight": 0.35, "contribution": 35 } ] },
  "evidence": { "paymentRef": "…", "failureHistory": { … }, "timestamps": { … }, "scoring": { … }, "ruleVersions": { "detection": "detect-v1", "scoring": "priority-v1" }, "recommendedNextState": "PROPOSED", "batchRunId": "batch_…" },

  "recoveryDecisions": [ … ],
  "recoveryActions":   [ … ],
  "auditHistory":      [ { "actorType": "SYSTEM", "action": "intelligence.batch.case.created", "summary": "…", "metadata": { … }, "createdAt": "…" } ]
}
```

---

## `GET /api/v1/intelligence/payments/:id/timeline`
Normalized event timeline for one payment. Returns **404** if the payment is not in the tenant scope.

**Response**
```json
{
  "tenantId": "seed_tenant_1",
  "paymentId": "seed_payment_1_059",
  "paymentRef": "seed_rzp_payment_1_059",
  "status": "FAILED",
  "amountMinor": 2445500, "currency": "INR",
  "money": { "unit": "minor", "exponent": 2, "currency": "INR" },
  "events": [
    { "eventType": "PAYMENT_CREATED", "rawType": "payment.created", "occurredAt": "…" },
    { "eventType": "PAYMENT_FAILED",  "rawType": "payment.failed",  "occurredAt": "…" }
  ]
}
```

---

## Notes
- **Auth is not implemented** (per phase scope). `x-tenant-id` is a development
  stand-in for the authenticated tenant; wiring it to a real principal is a
  drop-in change in `resolveTenant` (`apps/api/src/api-v1-routes.ts`).
- Cases are populated by the deterministic engine/batch (`pnpm intel:batch`);
  these read endpoints never mutate data.
- A separate **development-only** write endpoint,
  `POST /dev/tenants/:tenantId/intelligence/batch`, triggers a batch run and is
  registered only when `NODE_ENV !== "production"`.
