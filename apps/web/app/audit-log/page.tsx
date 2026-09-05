"use client";
import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useApi } from "../../src/lib/use-api";
import { AsyncBoundary } from "../../src/components/AsyncBoundary";
import { Card, Badge, EmptyState } from "../../src/components/primitives";
import { formatDateTime, humanizeToken } from "../../src/lib/format";
import { redactedJson } from "../../src/lib/redact";

interface AuditRow {
  id: string;
  caseId: string;
  actorType: string;
  action: string;
  summary: string | null;
  metadata: unknown;
  createdAt: string;
}

export default function AuditLogPage() {
  const { data, error, loading, reload } = useApi<{ items: AuditRow[] }>("/api/recoveros/audit");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const rows = data?.items ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.action, r.actorType, r.summary ?? "", r.caseId].join(" ").toLowerCase().includes(q),
    );
  }, [data, query]);

  return (
    <div className="stack gap-16">
      <div className="page-head">
        <h1>Audit Log</h1>
        <p>Every important state transition and decision for this workspace. Secrets are redacted before display.</p>
      </div>

      <Card
        title="Audit trail"
        action={
          <input
            className="input"
            style={{ width: 260 }}
            placeholder="Search action, actor, case…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        }
      >
        <AsyncBoundary
          loading={loading}
          error={error}
          data={data}
          onRetry={reload}
          isEmpty={(d) => d.items.length === 0}
          empty={<EmptyState icon="❐" title="No audit entries" desc="No audit history exists for this workspace yet." />}
        >
          {() =>
            filtered.length === 0 ? (
              <div className="faint" style={{ padding: 16, textAlign: "center" }}>
                No entries match “{query}”.
              </div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Time (UTC)</th>
                      <th>Actor</th>
                      <th>Action</th>
                      <th>Case</th>
                      <th>Summary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <React.Fragment key={r.id}>
                        <tr onClick={() => setExpanded((e) => (e === r.id ? null : r.id))}>
                          <td className="nowrap">{formatDateTime(r.createdAt)}</td>
                          <td>
                            <Badge variant={r.actorType === "SYSTEM" ? "muted" : "info"}>{humanizeToken(r.actorType)}</Badge>
                          </td>
                          <td className="mono">{r.action}</td>
                          <td>
                            <Link href={`/cases/${r.caseId}`} className="link mono" onClick={(e) => e.stopPropagation()}>
                              {r.caseId.slice(0, 10)}…
                            </Link>
                          </td>
                          <td className="muted">{r.summary ?? "—"}</td>
                        </tr>
                        {expanded === r.id && (
                          <tr style={{ cursor: "default" }}>
                            <td colSpan={5} style={{ background: "var(--surface-2)" }}>
                              <pre className="mono" style={{ margin: 0, fontSize: 11.5, overflowX: "auto" }}>
                                {redactedJson(r.metadata)}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </AsyncBoundary>
      </Card>
    </div>
  );
}
