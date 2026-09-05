import { apiLifecycleBatch } from "../../../../src/lib/server";
import { currentWorkspace, respond } from "../../../../src/lib/route-helpers";

export const dynamic = "force-dynamic";

/**
 * Run the deterministic end-to-end lifecycle batch evaluation for the workspace.
 * Runs twice server-side to prove idempotency. Never moves real money.
 */
export async function POST() {
  const ws = await currentWorkspace();
  return respond(await apiLifecycleBatch(ws));
}
