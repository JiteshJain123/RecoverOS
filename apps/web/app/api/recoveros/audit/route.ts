import { NextResponse } from "next/server";
import { apiGetTenant } from "../../../../src/lib/server";
import { currentWorkspace } from "../../../../src/lib/route-helpers";
import { redactValue } from "../../../../src/lib/redact";
import type { CaseDetailDTO, CaseListDTO } from "../../../../src/lib/types";

export const dynamic = "force-dynamic";

/**
 * Aggregate a workspace audit log from per-case audit history (bounded). Every
 * metadata value is redacted server-side before it leaves the process.
 */
export async function GET() {
  const ws = await currentWorkspace();
  const list = await apiGetTenant<CaseListDTO>(ws, "/api/v1/intelligence/cases?pageSize=25&sort=recent");
  if (!list.ok || !list.data) {
    return NextResponse.json({ error: list.error }, { status: list.status || 502 });
  }
  const details = await Promise.all(
    list.data.items.map((c) => apiGetTenant<CaseDetailDTO>(ws, `/api/v1/intelligence/cases/${encodeURIComponent(c.id)}`)),
  );

  const items = details
    .flatMap((d) =>
      d.ok && d.data
        ? d.data.auditHistory.map((a) => ({
            id: a.id,
            caseId: d.data!.id,
            actorType: a.actorType,
            action: a.action,
            summary: a.summary,
            metadata: redactValue(a.metadata),
            createdAt: a.createdAt,
          }))
        : [],
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 300);

  return NextResponse.json({ items });
}
