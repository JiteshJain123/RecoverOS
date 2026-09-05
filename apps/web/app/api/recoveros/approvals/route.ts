import { apiGetTenant } from "../../../../src/lib/server";
import { currentWorkspace } from "../../../../src/lib/route-helpers";
import { NextResponse } from "next/server";
import { toApprovalItem } from "../../../../src/lib/approvals";
import type { ApprovalItem, CaseDetailDTO, CaseListDTO } from "../../../../src/lib/types";

export const dynamic = "force-dynamic";

/**
 * Assemble the approval queue: cases in PENDING_APPROVAL, expanded to the action
 * awaiting a human decision plus the Gemini recommendation + policy reason. All
 * tenant-scoped server-side.
 */
export async function GET() {
  const ws = await currentWorkspace();
  const list = await apiGetTenant<CaseListDTO>(ws, "/api/v1/intelligence/cases?status=PENDING_APPROVAL&pageSize=50&sort=priority");
  if (!list.ok || !list.data) {
    return NextResponse.json({ error: list.error }, { status: list.status || 502 });
  }

  const ids = list.data.items.slice(0, 30).map((c) => c.id);
  const details = await Promise.all(
    ids.map((id) => apiGetTenant<CaseDetailDTO>(ws, `/api/v1/intelligence/cases/${encodeURIComponent(id)}`)),
  );

  const items: ApprovalItem[] = [];
  for (const d of details) {
    if (d.ok && d.data) {
      const item = toApprovalItem(d.data);
      if (item) items.push(item);
    }
  }
  return NextResponse.json({ money: list.data.money, items });
}
