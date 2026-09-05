# RecoverOS

AI Revenue Recovery Control Plane for merchants. Detects revenue at risk from failed
payments, checkout abandonment, and subscription failures; uses AI to diagnose and
propose bounded recovery actions; enforces deterministic financial guardrails; and
executes approved actions through Razorpay (Test Mode).

> **Status:** initial scaffold only. No business logic, AI agents, Razorpay
> integration, authentication, payment processing, or dashboards are implemented yet.
> See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design.

## Tech stack

- **Monorepo:** pnpm workspaces + TypeScript (strict)
- **Frontend:** Next.js (App Router) — `apps/web`
- **Backend:** Express + TypeScript — `apps/api`
- **Database:** PostgreSQL + Prisma — `packages/database`, `prisma/`
- **Tooling:** ESLint (flat config) + Prettier

## Repository layout

```
apps/
  web/          Next.js frontend (minimal, health route)
  api/          Express API (minimal, /health)
packages/
  shared/       Cross-cutting types & utilities
  config/       Validated environment configuration (zod)
  database/     Prisma client boundary (schema at prisma/)
  ai/           Claude agent runtime boundary (Phase 6)
  policy/       Deterministic financial authorization engine (fails closed)
  payments/     Razorpay adapter boundary (Phase 3)
  evaluation/   Offline metrics on synthetic data (Phase 9)
  observability/ Structured logging
prisma/         Prisma schema (no models yet)
simulator/      Synthetic dataset generator (Phase 8)
scripts/        Dev utility scripts
docs/           Architecture documentation
```

## Prerequisites

- **Node.js 22 LTS** (see `.nvmrc`)
- **pnpm** 11+ (`corepack enable` or install globally)
- **Docker** (for local PostgreSQL)

## Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Create your local env file (placeholders only in the example)
cp .env.example .env

# 3. Start local PostgreSQL
docker compose up -d
```

## Common commands

```bash
pnpm typecheck        # Type-check all packages and the API
pnpm lint             # Lint the workspace
pnpm format           # Format with Prettier
pnpm build            # Type-check + build the web app

pnpm dev:api          # Run the API in watch mode (http://localhost:4000)
pnpm dev:web          # Run the web app (http://localhost:3000)

pnpm db:generate      # Generate the Prisma client (once models exist)
```

## Health checks

- API: `GET http://localhost:4000/health`
- Web: `GET http://localhost:3000/api/health`

## Security note

Never commit real API keys or secrets. `.env` is git-ignored; only `.env.example`
(placeholders) is tracked. A core invariant of this system: the LLM can _propose_
recovery actions but the deterministic policy engine (`packages/policy`) is the sole
authority that authorizes any financial action.
