import { NextRequest } from "next/server";
import { apiGetTenant } from "../../../../src/lib/server";
import { currentWorkspace, respond } from "../../../../src/lib/route-helpers";
import type { CaseListDTO } from "../../../../src/lib/types";

export const dynamic = "force-dynamic";

/** Allowlisted, forwardable query params (the API also validates them). */
const ALLOWED = new Set(["status", "severity", "rootCause", "minAmountMinor", "minPriority", "from", "to", "page", "pageSize", "sort"]);

export async function GET(req: NextRequest) {
  const ws = await currentWorkspace();
  const usp = new URLSearchParams();
  for (const [k, v] of req.nextUrl.searchParams.entries()) {
    // Never forward tenantId (the API would reject it anyway); only known filters.
    if (ALLOWED.has(k) && v) usp.set(k, v);
  }
  const qs = usp.toString();
  return respond(await apiGetTenant<CaseListDTO>(ws, `/api/v1/intelligence/cases${qs ? `?${qs}` : ""}`));
}
