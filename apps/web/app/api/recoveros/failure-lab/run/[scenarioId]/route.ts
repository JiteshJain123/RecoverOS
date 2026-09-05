import { apiRunFailureScenario } from "../../../../../../src/lib/server";
import { currentWorkspace, respond } from "../../../../../../src/lib/route-helpers";
import type { FailureLabRunDTO } from "../../../../../../src/lib/types";

export const dynamic = "force-dynamic";

/**
 * Run one Failure Lab scenario. The tenant is injected server-side from the
 * active workspace; the browser only names a scenario. Development-only
 * simulation — never Live Mode, never real money.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ scenarioId: string }> }) {
  const { scenarioId } = await params;
  const ws = await currentWorkspace();
  return respond(await apiRunFailureScenario<FailureLabRunDTO>(ws, scenarioId));
}
