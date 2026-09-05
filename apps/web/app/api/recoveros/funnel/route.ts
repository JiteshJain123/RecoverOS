import { apiGetTenant } from "../../../../src/lib/server";
import { currentWorkspace, respond } from "../../../../src/lib/route-helpers";
import type { FunnelDTO } from "../../../../src/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const ws = await currentWorkspace();
  return respond(await apiGetTenant<FunnelDTO>(ws, "/api/v1/intelligence/funnel"));
}
