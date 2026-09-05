# Recovery Policy Gate & Safe Execution Layer

Enforces the invariant that a recommendation can never move money on its own:

```
Gemini/strategy recommendation
      ↓
RecoveryPlan validation (@recoveros/strategy)
      ↓
Policy Engine (@recoveros/policy)  → ALLOW / REVIEW / BLOCK
      ↓
(human approval if REVIEW)
      ↓
Execution only if authorized (@recoveros/execution)
      ↓
Outcome verification
```

A strategy provider only PROPOSES; only the deterministic `PolicyEvaluator`
authorizes, and only the `RecoveryActionExecutor` runs an authorized action
through a provider — which, this phase, is a money-safe simulator.

## Policy rules (`@recoveros/policy`)

`PolicyEvaluator.evaluate()` is pure and returns an explainable `PolicyDecision`
(`decision, reason, violatedRules[], requiredApproval, maxAllowedAmountMinor,
allowedActionTypes[], evaluatedAt, policyVersion`). **BLOCK dominates REVIEW
dominates ALLOW**; every triggered rule is listed in `violatedRules`.

Thresholds are resolved from the tenant's active **`Policy.limits`** (data-driven),
falling back to conservative defaults (`resolvePolicyConfig`).

| Rule | Level | Source |
|---|---|---|
| unknown strategy | BLOCK | plan |
| already-recovered payment | BLOCK | payment context |
| stopped/terminal case | BLOCK | case status |
| expired case (explicit or age > `maxCaseAgeHours`) | BLOCK | case |
| duplicate idempotency key | BLOCK | used keys |
| action type not in `allowedActions` | BLOCK | Policy.limits |
| amount > `maxRetryAmountMinor` (hard ceiling) | BLOCK | Policy.limits |
| retryCount ≥ `maxRetriesPerCase` (retry strategy) | BLOCK | Policy.limits |
| missing evidence | BLOCK | plan |
| strategy = HUMAN_REVIEW | REVIEW | plan |
| confidence < `minConfidence` | REVIEW | Policy.limits |
| risk level HIGH/CRITICAL | REVIEW | plan |
| amount in `[reviewAmountMinor, maxAllowedAmountMinor]` | REVIEW | Policy.limits |

## RecoveryAction state machine (`@recoveros/execution`)

```
PROPOSED ─┬─▶ APPROVAL_REQUIRED ─┬─▶ APPROVED ─▶ EXECUTING ─┬─▶ SUCCEEDED
          ├─▶ APPROVED           │                          └─▶ FAILED
          ├─▶ CANCELLED          ├─▶ CANCELLED
          └─▶ EXPIRED            └─▶ EXPIRED
APPROVED also ─▶ CANCELLED | EXPIRED
SUCCEEDED / FAILED / CANCELLED / EXPIRED are terminal.
```

Any transition outside this map throws `InvalidActionTransitionError`. ALLOW
auto-approves (PROPOSED→APPROVED); REVIEW creates an APPROVAL_REQUIRED action.

## Human approval

`ApprovalService.approve()` requires a privileged role — `OWNER`, `ADMIN`, or
`APPROVER`. `ANALYST`/`VIEWER` are rejected with `UnauthorizedApprovalError`. It
transitions APPROVAL_REQUIRED→APPROVED, records the approver, and writes a
`USER`-actor audit event. Dev endpoint:

```
POST /dev/tenants/:tenantId/recovery-actions/:actionId/approve
  headers: x-user-role, x-user-id     body: { "approve": true }
```

## Execution safeguards

Before running an action the executor verifies, in order (any failure ⇒ do not
execute, record the reason, audit, return without money movement):

1. not already executed (terminal/in-flight) — idempotent no-op on repeat;
2. action is `APPROVED`;
3. authorized (policy `ALLOW`, or a human approved a `REVIEW`);
4. action has not expired (`expiresAt`);
5. approval is not stale (`approvalTtlMs`);
6. policy version unchanged since approval;
7. the case still qualifies (not stopped, not already recovered);
8. no stopping condition is met (payment recovered / attempts exhausted).

## Idempotency

Every executable action carries an idempotency key (from the RecoveryPlan). A
repeat `authorize` with the same key returns the existing action (`duplicate`)
— no duplicate rows. A repeat `execute` on a terminal action is a no-op that
returns the recorded outcome — the provider is never called twice.

## Outcome verification

After a simulated execution the executor updates the action (SUCCEEDED/FAILED),
and **only when the provider explicitly reports `SUCCEEDED` with a positive
amount** does it credit recovered revenue and mark the case `RECOVERED`. A
`LINK_CREATED`, `LINK_EXPIRED`, `FAILED`, or `TIMEOUT` never credits revenue.

## Simulated provider

`SimulatedRecoveryProvider` NEVER moves money. Outcomes are deterministic from
the request (idempotency key + action type + metadata), so evaluation is
reproducible. `metadata.simScenario` (`retry_success | retry_fail | link_created
| link_expired | timeout`) forces an outcome; otherwise the root cause + a stable
hash decide. External references are always `sim_…`.

## Batch evaluation

`BatchRecoveryEvaluator` runs detection → strategy → policy → simulated
execution over every case from a `RecoveryCaseSource` (no cherry-picking) and
returns: cases processed/allowed/reviewed/blocked, actions executed, successful
& failed recoveries, `recoveredRevenueMinor`, `revenueStillAtRiskMinor`,
`recoveryRate`, and errors. It is idempotent.

Runnable (no DB): `pnpm recovery:batch` (deterministic synthetic dataset, runs
twice and asserts identical metrics + no new actions). Dev endpoint over the
seeded DB: `POST /dev/tenants/:tenantId/recovery/batch`.

## Audit trail

Every important transition is audited with actor, tenant, action, policy version,
decision, timestamps, and failure reason where applicable:
`recovery.action.proposed`, `.approval_required`, `.approved`, `.executing`,
`.succeeded`, `.failed`, `.blocked`, `.safeguard_blocked`, `.cancelled`.

## Not implemented (by design)

No Razorpay execution, no customer messaging, no real money movement, no
production auth. The provider is a simulator; the Prisma execution store /
case source back the dev endpoints only.
