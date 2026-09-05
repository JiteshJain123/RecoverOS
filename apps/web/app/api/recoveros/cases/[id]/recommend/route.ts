import { apiRecommend } from "../../../../../../src/lib/server";
import { currentWorkspace, respond } from "../../../../../../src/lib/route-helpers";

export const dynamic = "force-dynamic";

/** Trigger an advisory Gemini recommendation for a case. Never executes anything. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = await currentWorkspace();
  return respond(await apiRecommend(ws, id));
}
