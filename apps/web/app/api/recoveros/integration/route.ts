import { NextRequest } from "next/server";
import { apiGet } from "../../../../src/lib/server";
import { respond } from "../../../../src/lib/route-helpers";
import type { IntegrationStatusDTO } from "../../../../src/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const probe = req.nextUrl.searchParams.get("probe") === "1";
  return respond(await apiGet<IntegrationStatusDTO>(`/dev/integration/status${probe ? "?probe=1" : ""}`));
}
