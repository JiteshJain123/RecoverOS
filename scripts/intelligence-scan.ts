/**
 * Payment-intelligence scan CLI (`pnpm intel:scan [tenantId ...]`).
 *
 * Runs the deterministic engine over each tenant's payments and idempotently
 * creates/updates recovery candidates (with audit records). Safe to re-run: no
 * duplicate cases, no churn when nothing changed.
 *
 * This is the WRITE entry point for Phase 2. It does NOT execute recovery,
 * call Razorpay/Gemini, or message customers. With no args it scans every
 * tenant in the database.
 */
import { connectDatabase, disconnectDatabase, prisma } from "@recoveros/database";
import { createPaymentIntelligenceEngine } from "@recoveros/intelligence";
import { createLogger } from "@recoveros/observability";

async function resolveTenantIds(explicit: string[]): Promise<string[]> {
  if (explicit.length > 0) return explicit;
  const tenants = await prisma.tenant.findMany({ select: { id: true }, orderBy: { slug: "asc" } });
  return tenants.map((t) => t.id);
}

async function main(): Promise<void> {
  const logger = createLogger({ name: "intel-scan" });
  const engine = createPaymentIntelligenceEngine({ logger });

  await connectDatabase();
  const tenantIds = await resolveTenantIds(process.argv.slice(2));

  const results = [];
  for (const tenantId of tenantIds) {
    const result = await engine.scanTenant({ tenantId });
    results.push(result);
  }

  console.log(JSON.stringify({ scan: "intelligence", tenants: results.length, results }, null, 2));
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectDatabase();
  });
