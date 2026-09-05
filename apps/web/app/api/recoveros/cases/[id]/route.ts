import { apiGetTenant } from "../../../../../src/lib/server";
import { currentWorkspace, respond } from "../../../../../src/lib/route-helpers";
import type { CaseDetailDTO } from "../../../../../src/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = await currentWorkspace();
  return respond(await apiGetTenant<CaseDetailDTO>(ws, `/api/v1/intelligence/cases/${encodeURIComponent(id)}`));
}
