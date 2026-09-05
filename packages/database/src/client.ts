/**
 * Prisma client singleton for RecoverOS.
 *
 * A single PrismaClient instance is reused across the process (and preserved
 * across hot-reloads in development via a global) so we never exhaust database
 * connections by instantiating multiple clients.
 *
 * The generated client is emitted INSIDE this package
 * (packages/database/generated/client) — see prisma/schema.prisma `output`.
 */
import { PrismaClient, Prisma } from "../generated/client";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Safe development logging: verbose in dev, quiet in production. Prisma's log
 * events do NOT contain the connection string, so credentials in DATABASE_URL
 * are never emitted here.
 */
const logLevels: Prisma.LogLevel[] = isProduction ? ["warn", "error"] : ["query", "warn", "error"];

function createPrismaClient(): PrismaClient {
  return new PrismaClient({ log: logLevels });
}

// Preserve a single instance across dev hot-reloads without leaking in prod.
const globalForPrisma = globalThis as unknown as {
  __recoverosPrisma?: PrismaClient;
};

export const prisma: PrismaClient = globalForPrisma.__recoverosPrisma ?? createPrismaClient();

if (!isProduction) {
  globalForPrisma.__recoverosPrisma = prisma;
}

/**
 * Establish the database connection. Validates that DATABASE_URL is present
 * WITHOUT ever logging its value (which contains credentials).
 */
export async function connectDatabase(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and configure it " +
        "(see docker-compose.yml for local PostgreSQL).",
    );
  }
  await prisma.$connect();
}

/** Gracefully close the database connection (e.g. on process shutdown). */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
