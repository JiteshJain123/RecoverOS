# RecoverOS

### AI Revenue Recovery Operating System

**Detect revenue at risk → let Gemini recommend a bounded recovery strategy → enforce deterministic financial policy → execute only permitted actions → verify the outcome through authenticated payment events → credit recovered revenue *only when recovery is proven*.**

![Track](https://img.shields.io/badge/Buildathon-Track%2003%20%E2%80%94%20AI%20Revenue%20Recovery-4f46e5)
![Razorpay](https://img.shields.io/badge/Razorpay-Test%20Mode%20only-0b4a2e)
![Tests](https://img.shields.io/badge/tests-310%20passing-067647)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![AI](https://img.shields.io/badge/AI-Google%20Gemini-175cd3)

> **Track 03 — AI Revenue Recovery.**
> **No real money is moved.** Razorpay runs in **Test Mode only** (`rzp_live_*` keys are rejected in code), execution can run against a deterministic **simulator**, and the demo dataset is **synthetic/seeded**. RecoverOS is a control plane that *decides and verifies*; it never processes live funds in this submission.

**Core architecture principle:**

> **AI proposes. Policy decides. Execution is bounded. Webhooks verify. Accounting proves.**

---

## 1. Why this problem matters

A large share of merchant revenue never gets lost to fraud or refunds — it simply **slips away** at the payment layer and is never recovered:

- **Failed payments** — bank declines, insufficient funds, gateway errors, and network timeouts leave a completed intent with no captured money.
- **Checkout abandonment / payment degradation** — a customer starts paying and drops off, or a session expires before capture.
- **Subscription / retry failures** — a renewal or retry fails and the revenue quietly ages out.

**Detecting a failed payment is the easy part.** The hard — and valuable — part is everything *after* detection:

- deciding **whether** an intervention is even safe and allowed,
- choosing the **right** bounded action (retry a capture vs. send a fresh payment link vs. escalate to a human),
- **not** re-charging or double-acting,
- and — most importantly — **knowing whether the money actually came back.**

A naive "recovery" system that fires retries and counts HTTP 200s as revenue is worse than nothing: it fabricates recovered-revenue numbers and can double-charge customers. RecoverOS is built to be the opposite of that.

---

## 2. What RecoverOS solves

RecoverOS is a **closed-loop revenue recovery control plane**. It runs the full lifecycle and refuses to overstate results at every step:

```
detect → diagnose → recommend → policy → approval → bounded execution → verification → accounting
```

- **Detect** revenue at risk from payment signals (classify, score, prioritize).
- **Diagnose** the root cause and whether the case is a genuine *recovery candidate*.
- **Recommend** a bounded strategy using **Google Gemini** (advisory only).
- **Policy** — a deterministic engine returns **ALLOW / REVIEW / BLOCK**.
- **Approval** — REVIEW actions require an authorized human decision before anything executes.
- **Bounded execution** — only permitted, idempotent actions run, behind hard safeguards.
- **Verification** — provider outcomes are confirmed via authenticated Razorpay webhooks.
- **Accounting** — revenue is credited **only** on a proven capture, and every step is audited.

---

## 3. What makes RecoverOS different

| Principle | How it's enforced |
|-----------|-------------------|
| **Gemini is not the financial authority** | Gemini only returns a schema-validated *recommendation*. It never authorizes money. |
| **AI cannot directly execute payment actions** | The Gemini strategy provider exposes **no `execute()` surface**; the Razorpay adapter is only ever reached by the execution service after policy + approval. |
| **Deterministic policy decides** | `packages/policy` returns **ALLOW / REVIEW / BLOCK** from explicit rules; it fails closed. |
| **Approvals are enforced** | A REVIEW action makes **zero** provider calls until an authorized approval is recorded server-side. |
| **Execution is bounded** | Idempotency keys, execution TTL, stale-approval and policy-version guards gate every attempt. |
| **Outcomes must be verified** | An HTTP 200 or a created payment link is **not** success — only a verified capture is. |
| **Webhooks are authenticated + idempotent** | HMAC-SHA256 signature verification; duplicate and out-of-order events cannot corrupt state. |
| **Attempted ≠ recovered** | Attempted recovery is tracked separately and is **never** auto-counted as recovered revenue. |
| **Only verified outcomes count** | Recovered revenue is credited **only** from authoritative, reconciled payment events. |

---

## 4. Architecture

```
                         Revenue signals (failed / abandoned / expired payments)
                                            │
                                            ▼
                          Revenue-at-risk detection  (classify · score · prioritize)
                                            │
                                            ▼
                       Gemini recovery recommendation  (advisory, schema-validated)
                                            │
                                            ▼
                            Deterministic policy engine
                                            │
                         ┌──────────────────┼──────────────────┐
                         ▼                  ▼                  ▼
                      ALLOW              REVIEW              BLOCK
                         │                  │                  │
                         │        approval controls           │  (0 provider calls)
                         │        (human, server-side)         │
                         └──────────────────┼──────────────────┘
                                            ▼
                              Bounded execution service
                              (idempotency · TTL · safeguards)
                                            │
                                            ▼
                               Razorpay  (TEST MODE only)
                              retry-capture · payment link
                                            │
                                            ▼
                     HMAC webhook verification + idempotency + reconciliation
                                            │
                                            ▼
                       Verified recovery  (proven capture only)
                                            │
                                            ▼
                     Revenue accounting  +  deterministic evaluation / Failure Lab
```

**Monorepo layers (ports & adapters).** Domain packages are pure and independently tested; adapters (Prisma, Razorpay, Gemini REST) sit at the edges; the Express API and the Next.js Control Room compose them. The browser talks only to a same-origin BFF, which injects tenant context server-side — the client never sees a tenant id or a secret.

---

## 5. The AI boundary (Gemini)

Gemini is the *intelligence*, never the *authority*.

**Gemini can:**
- read a **whitelisted, non-secret** summary of a case (root cause, amount at risk, severity, retry count, contactability — no raw PII, no credentials);
- return a **structured, schema-constrained** recommendation: a strategy, a confidence, a concise rationale, evidence references, an expected outcome, and stopping conditions.

**Gemini cannot:**
- authorize or move money;
- call Razorpay, send a customer message, or take any action;
- choose the execution provider;
- invent amounts, currencies, customer data, or payment status (those are filled deterministically from trusted data);
- exceed policy limits.

**Why a separate deterministic policy exists:** LLM output is probabilistic and can drift or be malformed. Financial authorization must be reproducible and auditable, so a deterministic engine — not the model — decides ALLOW / REVIEW / BLOCK.

**Malformed / unavailable AI output is fail-closed:** the model's JSON is validated against a strict schema (and then the enriched plan is validated again). If validation fails, the case **stops** — no action executes and nothing is credited. Rate-limit/timeout/transport errors surface as safe, non-crediting failures.

---

## 6. Revenue recovery lifecycle

A representative case, and the distinctions RecoverOS keeps rigorously separate:

| Stage | Meaning | Counts as recovered revenue? |
|-------|---------|:---:|
| **Revenue at risk** | A failed/abandoned payment detected and quantified | ❌ |
| **Recovery candidate** | Intelligence says a safe intervention may exist | ❌ |
| **Policy-approved** | Deterministic policy returned ALLOW (or a REVIEW was approved) | ❌ |
| **Attempted recovery** | A bounded action executed (e.g. a payment link was created) | ❌ |
| **Verified recovery** | A signature-verified capture was reconciled to the case | ✅ |

Example: a ₹5,000 card payment fails (BANK_DECLINE). Intelligence flags it as a candidate → Gemini recommends `SEND_PAYMENT_LINK` (confidence 0.85) → policy returns ALLOW → the execution service creates a **Test Mode** payment link (attempted, ₹0 recovered) → the customer pays → Razorpay emits a signed `payment.captured` webhook → it is verified, deduplicated, and reconciled → **now** ₹5,000 is credited as verified recovered revenue and the audit trail records every transition.

---

## 7. Razorpay integration (Test Mode)

Implemented against Razorpay **Test Mode** (`packages/payments`). Anything not backed by a live gateway in this submission is clearly labeled *simulated/deterministic*.

- **Provider adapter** — `RazorpayTestProvider` implements the execution port and provider-neutral gateway operations. Config **rejects `rzp_live_*` keys** (`REJECTED_LIVE`); Test Mode only.
- **Supported operations** — fetch payment/order, create payment link, capture an *authorized* payment, cancel link, connectivity check. Secrets are never logged or returned.
- **Payment-link behavior** — a link can be *created* as a bounded recovery action; **creation alone credits ₹0**. Recovery is realized only when a subsequent verified capture arrives.
- **Capture restrictions** — "retry" means **capturing an already-authorized payment**, never a blind re-charge. If the payment isn't in a capturable state, a **classified capability error** is returned and **no fake success** is recorded.
- **Webhook signature verification** — HMAC-SHA256 over the raw body; unmapped provider accounts are rejected (a webhook can never guess a tenant).
- **Event idempotency** — a duplicate event id is ignored; revenue is credited **once**.
- **Out-of-order handling** — a late `authorized` after a `captured` does not regress state or re-credit.
- **Reconciliation** — a verified capture transitions the case to RECOVERED and credits the action exactly once.
- **Why a payment link ≠ recovered revenue** — a created link (or an HTTP 200) is only an *attempt*; without a reconciled `payment.captured`, the customer has not paid, so crediting it would be a false success claim. RecoverOS refuses to do that.

---

## 8. Safety & financial controls

Every guarantee below is enforced in code and covered by automated tests.

| Guarantee | Result |
|-----------|--------|
| Policy **BLOCK** | **0** provider calls, ₹0 recovered |
| **REVIEW** without approval | **0** provider calls |
| **Expired** action (TTL passed) | no execution |
| **Stale approval** (older than freshness window) | no execution |
| **Policy version changed** after authorization | execution cancelled (re-evaluation forced) |
| **Duplicate execution** | idempotency key → no duplicate provider call |
| **Duplicate webhook** | ignored; credited once |
| **Out-of-order webhook** | no state regression, no re-credit |
| **Provider timeout / unverified result** | ₹0 recovered |
| **Already recovered / already captured** | blocked / classified; no re-charge, no fake credit |
| **Capability error** (not capturable) | classified failure; ₹0 recovered |
| **Malformed AI output** | rejected pre-execution; ₹0 recovered |
| **Tenant isolation** | server-side `x-tenant-id`; cross-tenant read → 404; client `tenantId` override → 400 |
| **Server-side enforcement** | approvals and tenant context cannot be set by the browser |

---

## 9. Failure Lab

A **development-only** deterministic demonstration + evaluation surface that runs the *real* lifecycle against a controlled failure harness (mock gateway transport + signed mock webhooks). It proves RecoverOS **fails safely** and never claims a recovery it cannot prove. It is production-guarded (the endpoints return 404 when `NODE_ENV=production`) and uses no real credentials, network, or money.

**17 implemented scenarios:**

`successful_recovery` · `provider_timeout` · `provider_500` · `duplicate_execution` · `duplicate_webhook` · `out_of_order_webhook` · `delayed_webhook` · `failed_payment` · `payment_already_recovered` · `payment_already_captured` · `expired_action` · `stale_approval` · `policy_version_changed` · `capability_error` · `malformed_ai_output` · `blocked_policy` · `review_without_approval`

For each scenario the UI shows a connected 11-stage timeline (payment detected → recovery candidate → Gemini recommendation → policy → approval → execution safeguard → provider → webhook → reconciliation → verification → accounting), the exact **stopping point**, the safety result, and per-run statistics — all derived from the actual trace, never hardcoded.

---

## 10. Evaluation

A **deterministic evaluation** runs the whole seeded dataset through the connected lifecycle **twice** (to prove idempotency) and reports authoritative metrics; a **safety report** proves each guarantee from an actual controlled run.

- **What is measured:** cases evaluated, total revenue at risk, recovery attempts, **verified** recoveries, recovered revenue, recovery rate, actions prevented (BLOCK + unapproved REVIEW), and **false-success claims prevented** (provider "success" we refused to credit).
- **"Verified recovered revenue"** = revenue credited **only** on a proven capture (immediate authorized-capture, or a signature-verified `payment.captured` webhook reconciled to the case). A payment link, an HTTP 200, or an unverified outcome credits **₹0**.
- **Idempotency proof:** the second pass makes **zero** new provider calls and yields identical financials.

**Repository-verified status (latest run):**

| Check | Result |
|-------|--------|
| Automated tests (`node:test`) | **310 passing / 0 failing** |
| Typecheck (`tsc`) | **PASS** |
| Lint (ESLint) | **PASS** |
| Production build (`next build`) | **PASS** (12/12 pages) |
| Safety guarantees in `runSafetyReport` | **all hold** |
| Failure Lab scenarios | **17** |

> No baseline/uplift benchmark is claimed — the project deliberately does not fabricate an A/B "revenue lifted" number (see *Limitations*). The safety report is the headline proof: RecoverOS recovers revenue **only when it can prove it**.

---

## 11. Product — the Control Room

A responsive, desktop-first operations UI (`apps/web`). Implemented routes:

| Route | Purpose |
|-------|---------|
| `/` **Overview** | Executive KPIs: revenue at risk vs **verified recovered**, recovery funnel + trend, needs-attention |
| `/revenue-at-risk` **Revenue at Risk** | Filterable table of recovery cases with intelligence |
| `/recovery-queue` **Recovery Queue** | Operator worklist (what happened, why, what to do) |
| `/cases/[id]` **Recovery Case** | Full investigation: lifecycle, intelligence, Gemini decision, policy, action, audit |
| `/approvals` **Approvals** | Server-authoritative approval of REVIEW actions |
| `/evaluations` **Evaluations** | Deterministic batch + safety guarantees + idempotency proof |
| `/failure-lab` **Failure Lab** | Deterministic safe-failure demonstrations |
| `/audit-log` **Audit Log** | Searchable state transitions (secrets redacted) |
| `/integration` **Integration** | Gemini / Razorpay / webhook config + connectivity status (never secrets) |
| `/settings` **Settings** | Workspace, tenant-isolation, safety, and RBAC information |

DEMO / SIMULATED-TEST indicators are always visible so it can never look like live money is moving.

---

## 12. Tech stack

| Layer | Technology |
|-------|-----------|
| Monorepo | pnpm workspaces + TypeScript (strict), Node 22 |
| Frontend | Next.js 15 (App Router) + React 19 (`apps/web`) |
| Backend | Express 4 + TypeScript (`apps/api`) |
| Database | PostgreSQL + Prisma 6 (`prisma/`, `packages/database`) |
| AI | **Google Gemini** via REST `generativelanguage v1beta` (`packages/ai`) |
| Payments | Razorpay **Test Mode** adapter (`packages/payments`) |
| Validation | zod |
| Tests | `node:test` + `tsx` |
| Tooling | ESLint (flat config) + Prettier |

*(No Turborepo — plain pnpm workspaces. No CI service configured for this submission; checks are run locally.)*

---

## 13. Local setup

**Prerequisites:** Node **22** (see `.nvmrc`), pnpm **11+** (`corepack enable`), Docker (for local PostgreSQL).

```bash
# 1. Install
pnpm install

# 2. Env (placeholders only in the example — fill in locally)
cp .env.example .env

# 3. PostgreSQL
docker compose up -d

# 4. Database: generate client, apply schema, seed deterministic demo data
pnpm db:generate
pnpm db:migrate       # or: pnpm db:reset  (drops, re-migrates, reseeds)
pnpm db:seed

# 5. Run
pnpm dev:api          # Express API  → http://localhost:4000
pnpm dev:web          # Control Room → http://localhost:3000
```

**Quality gates:**

```bash
pnpm test        # node:test suite (310 tests)
pnpm typecheck   # tsc --noEmit across the workspace
pnpm lint        # eslint
pnpm build       # typecheck + next build
```

To enable live Gemini recommendations, set `GEMINI_API_KEY` (Google AI Studio) and `GEMINI_MODEL`. To enable the real Razorpay **Test Mode** adapter, set `RAZORPAY_KEY_ID` (`rzp_test_*`), `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET`. With these unset, RecoverOS falls back to the deterministic simulator — never a live call.

---

## 14. Environment variables

Defined in `.env.example` (placeholders only):

| Variable | Purpose |
|----------|---------|
| `NODE_ENV` | Runtime mode; dev-only endpoints (Failure Lab, batch, recommend) are disabled when `production`. |
| `LOG_LEVEL` | Structured-logger verbosity. |
| `API_PORT` / `WEB_PORT` | API (4000) and web (3000) ports. |
| `DATABASE_URL` | PostgreSQL connection string (local placeholder in the example). |
| `GEMINI_API_KEY` | Google Gemini key. Blank ⇒ recommendations disabled (endpoint returns a safe 503). |
| `GEMINI_MODEL` | Gemini model id, e.g. `gemini-3.5-flash` (model is read from env, never hardcoded). |
| `RAZORPAY_KEY_ID` | Razorpay **Test Mode** key id (`rzp_test_*`; `rzp_live_*` is rejected). |
| `RAZORPAY_KEY_SECRET` | Razorpay Test Mode secret. |
| `RAZORPAY_WEBHOOK_SECRET` | HMAC secret for webhook signature verification. |

*(Provider selection can also be influenced by `EXECUTION_PROVIDER` / `RAZORPAY_TEST_ENABLED`, which default safely to the simulator.)*

---

## 15. Security & secret handling

- `.env` is **git-ignored**; only `.env.example` (placeholders) is tracked. No real credentials belong in Git — history has been scanned and contains none.
- Secrets are read **server-side only**; the browser talks to a same-origin BFF and never receives a tenant id, API key, or webhook secret. Audit metadata is defensively redacted before display.
- **Razorpay is Test Mode** for this submission; `rzp_live_*` keys are rejected in code. No real money can move.
- **Google Gemini** is the application's AI (advisory intelligence only).
- **Development note:** the codebase was written with the help of an AI coding assistant (Anthropic's Claude Code CLI). This was a *development tool only* — the application's runtime AI is **Gemini**, and Claude is not part of RecoverOS's product or runtime.

---

## 16. 5-minute demo

| Time | Screen | What to show |
|------|--------|--------------|
| 0:00–0:40 | **Overview** | The one-liner + legend: only a *verified* payment counts as recovered. Contrast the red **Revenue at Risk** vs green **Verified Recovered** panels. Point at the "Gemini → Policy → Execution" boundary. |
| 0:40–1:30 | **Revenue at Risk → a Case** | Open a real case; show amount, failure reason, customer/payment context, and the recovery lifecycle. |
| 1:30–2:20 | **Gemini + AI boundary** | Show the schema-validated recommendation (strategy, confidence, rationale) and the explicit "Gemini never executes Razorpay" boundary. |
| 2:20–3:00 | **Policy → Approval → Execution → Verification** | Walk ALLOW/REVIEW/BLOCK, approval gating, bounded execution, and the webhook-verified outcome. |
| 3:00–4:15 | **Failure Lab** | Run `blocked_policy` (0 provider calls), `provider_timeout` (₹0, claim prevented), `duplicate_webhook` (credited once). Show the "Stopped here" marker. |
| 4:15–5:00 | **Evaluations** | Verified recovered revenue, actions prevented, false-success claims prevented, all safety guarantees green, idempotency proof. |

Keep the **DEMO / SIMULATED-TEST** header pills visible throughout.

---

## 17. Challenge alignment — Track 03: "Find revenue that's slipping away and win it back."

| Track requirement | How RecoverOS delivers |
|-------------------|------------------------|
| **Detect revenue at risk** | Classify/score/prioritize failed & abandoned payments into recovery cases. |
| **Determine interventions** | Gemini recommends a bounded strategy; deterministic policy decides if/how it may run. |
| **Execute bounded recovery workflows** | Idempotent, TTL-bounded execution via the Razorpay Test Mode adapter (or simulator). |
| **Measure verified money recovered across a batch** | Deterministic evaluation credits revenue only on proven captures; reports verified recovered revenue and recovery rate. |
| **Stopping rules** | Expired/stale/policy-changed/already-recovered/attempts-exhausted all halt safely. |
| **Compliant escalation / approval** | REVIEW routes to a human; zero provider calls until approved (server-side). |
| **Audit trail** | Every decision and state transition is recorded and viewable in the Audit Log. |

---

## 18. What broke, and how we got out (honest retrospective)

- **PostgreSQL on port 5432 / non-interactive migrations.** A native PostgreSQL service collided with the Docker instance on 5432, and `prisma migrate dev` aborts without a TTY. Resolved by aligning on one instance and using `migrate diff` + a hand-written migration folder + `migrate deploy` for non-interactive environments.
- **Gemini "thinking-model" token budget.** With `maxOutputTokens = 1024`, the model spent its budget on internal reasoning and truncated the structured JSON (`finishReason: MAX_TOKENS`), so recommendations failed. Fixed by raising the output budget to 8192 and hardening the client to surface empty/blocked responses as clear errors.
- **Gemini free-tier quota (HTTP 429).** The free tier caps requests per model per day; exhaustion surfaces honestly as a rate-limit message rather than a fake success.
- **Recovery Case "Not Found."** Case primary keys were non-deterministic `cuid`s from an older seed, so a list rendered before a re-seed referenced ids that no longer existed → correct tenant-scoped 404. Fixed by reseeding with the current seed, which pins deterministic `seed_case_*` ids that are stable across reseeds. (Tenant isolation, the BFF boundary, and the API were verified correct throughout.)
- **Browser hydration warning.** Attributes like `data-new-gr-c-s-check-loaded` / `cz-shortcut-listen` are injected into `<body>` by **browser extensions** (Grammarly, etc.), not by RecoverOS — an environment/browser artifact, intentionally left unmodified.

---

## 19. Limitations & future work

These are explicit boundaries, not defects:

- **Razorpay Test Mode**, not production payments — no live funds move.
- **Synthetic/seeded demo data** and a deterministic simulator drive the demo; the Razorpay integration itself is real Test Mode.
- **Development approval actor** — approvals are enforced server-side, but a dev operator (role `APPROVER`) stands in until real authentication lands.
- **Gemini free-tier limits** can rate-limit live recommendations; the deterministic strategy provider and simulator keep the system fully demoable regardless.
- **No baseline/uplift benchmark** — the repository intentionally does not claim an A/B "revenue lifted" figure; the honest, verifiable claim is *verified* recovered revenue and the safety guarantees.
- **`packages/evaluation` is an interface stub** — the working deterministic evaluation lives in `packages/lifecycle` and is surfaced on `/evaluations`.

---

## 20. Repository structure

```
apps/
  web/          Next.js Control Room UI + same-origin BFF (/api/recoveros/*)
  api/          Express API: /api/v1/intelligence/* + dev-only endpoints
packages/
  shared/       Cross-cutting types
  config/        Validated environment configuration (zod)
  observability/ Structured logging
  database/     Prisma client boundary (schema at prisma/)
  intelligence/ Failure classification, scoring, revenue-at-risk detection + read model
  strategy/     Deterministic recovery strategy + schema-validated plans
  ai/           Google Gemini client, prompt, structured output, provider (advisory)
  policy/       Deterministic ALLOW/REVIEW/BLOCK engine (fails closed)
  payments/     Razorpay Test Mode adapter + gateway operations
  execution/    Bounded action executor, approvals, safeguards, simulator
  webhooks/     HMAC verification, idempotency, reconciliation
  lifecycle/    End-to-end lifecycle, batch evaluation, safety report, Failure Lab
  evaluation/   Offline metrics package (interface stub — see Limitations)
prisma/         Prisma schema, migrations, deterministic seed
simulator/      Synthetic dataset generator
scripts/        Operational/dev scripts
docs/           Architecture and integration documentation
```

Deeper design docs live in [`docs/`](docs/): `ARCHITECTURE.md`, `GEMINI.md`, `RAZORPAY_INTEGRATION.md`, `POLICY_EXECUTION.md`, `WEBHOOKS.md`, `STRATEGY.md`, `API.md`.

---

## 21. Verification

Latest local run of the full pipeline:

```
pnpm test        → 310 passing / 0 failing
pnpm typecheck   → clean (0 errors)
pnpm lint        → clean (0 warnings/errors)
pnpm build       → compiled successfully (12/12 pages)
```

Health checks: API `GET http://localhost:4000/health` · Web `GET http://localhost:3000/api/health`.

---

## 22. License

No `LICENSE` file is currently present in this repository. A license should be added before wider public reuse; until then, all rights are reserved by the author.

---

*RecoverOS — AI proposes. Policy decides. Execution is bounded. Webhooks verify. Accounting proves.*
