import { apiListFailureScenarios } from "../../../../../src/lib/server";
import { respond } from "../../../../../src/lib/route-helpers";
import type { FailureScenarioListDTO } from "../../../../../src/lib/types";

export const dynamic = "force-dynamic";

/** List the development-only Failure Lab scenarios (catalogue metadata). */
export async function GET() {
  return respond(await apiListFailureScenarios<FailureScenarioListDTO>());
}
