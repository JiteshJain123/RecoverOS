import { apiGetTenant } from "../../../../../../src/lib/server";
import { currentWorkspace, respond } from "../../../../../../src/lib/route-helpers";
import type { PaymentTimelineDTO } from "../../../../../../src/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = await currentWorkspace();
  return respond(await apiGetTenant<PaymentTimelineDTO>(ws, `/api/v1/intelligence/payments/${encodeURIComponent(id)}/timeline`));
}
