import { apiApproveAction } from "../../../../../../src/lib/server";
import { currentWorkspace, respond } from "../../../../../../src/lib/route-helpers";

export const dynamic = "force-dynamic";

/**
 * Approve an action. Authorization is enforced by the backend (the actor role is
 * injected server-side; the browser cannot set it). The server remains
 * authoritative — this only relays the decision.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ actionId: string }> }) {
  const { actionId } = await params;
  const ws = await currentWorkspace();
  return respond(await apiApproveAction(ws, actionId));
}
