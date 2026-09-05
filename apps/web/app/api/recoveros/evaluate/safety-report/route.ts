import { apiEvaluationSafetyReport } from "../../../../../src/lib/server";
import { currentWorkspace, respond } from "../../../../../src/lib/route-helpers";
import type { SafetyReportDTO } from "../../../../../src/lib/types";

export const dynamic = "force-dynamic";

/**
 * Deterministic safety report for the Evaluations page. Each guarantee is backed
 * by an actual failure-lab run (development-only simulation; never real money).
 */
export async function GET() {
  const ws = await currentWorkspace();
  return respond(await apiEvaluationSafetyReport<SafetyReportDTO>(ws));
}
