/**
 * @recoveros/database
 *
 * Data-access boundary for RecoverOS. Owns the Prisma client lifecycle and is
 * the single place the rest of the app imports database access from. The
 * generated Prisma client lives inside this package
 * (packages/database/generated/client) rather than a root-level location.
 *
 * Multi-tenant query scoping (a Prisma extension constraining queries by
 * tenantId — see docs/ARCHITECTURE.md §4) will be layered on top of this
 * client in a later phase.
 *
 * Usage:
 *   import { prisma, connectDatabase, disconnectDatabase, Prisma } from "@recoveros/database";
 *
 * Requires `pnpm db:generate` to have been run (the generated client is
 * git-ignored).
 */
export { prisma, connectDatabase, disconnectDatabase } from "./client";

// Re-export the Prisma namespace (enums, input types, error classes) and the
// PrismaClient type so consumers depend only on @recoveros/database.
export { Prisma } from "../generated/client";
export type { PrismaClient } from "../generated/client";
