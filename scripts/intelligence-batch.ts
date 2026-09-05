/**
 * Payment-intelligence BATCH processor CLI (`pnpm intel:batch [tenantId ...]`).
 *
 * Runs the deterministic BatchProcessor over each tenant's seeded payments and
 * idempotently creates/updates recovery candidates with full evidence + audit
 * records, honouring stopping conditions (recovered/closed/in-flight cases are
 * not re-escalated). Safe to re-run: no duplicate cases, no financial decisions.
 *
 * Does NOT call Razorpay/Gemini, move money, or message customers. With no args
 * it processes every tenant in the database.
 */
import { connectDatabase, disconnectDatabase, prisma } from "@recoveros/database";
import { createBatchProcessor } from "@recoveros/intelligence";
import { createLogger } from "@recoveros/observability";

async function resolveTenantIds(explicit: string[]): Promise<string[]> {
  if (explicit.length > 0) return explicit;
  const tenants = await prisma.tenant.findMany({ select: { id: true }, orderBy: { slug: "asc" } });
  return tenants.map((t) => t.id);
}

async function main(): Promise<void> {
  const logger = createLogger({ name: "intel-batch" });
  const processor = createBatchProcessor({ logger });

  await connectDatabase();
  const tenantIds = await resolveTenantIds(process.argv.slice(2));

  const results = [];
  for (const tenantId of tenantIds) {
    results.push(await processor.processTenant({ tenantId }));
  }

  console.log(JSON.stringify({ batch: "intelligence", tenants: results.length, results }, null, 2));
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectDatabase();
  });
