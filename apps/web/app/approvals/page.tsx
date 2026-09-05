"use client";
import React, { useState } from "react";
import Link from "next/link";
import { useApi } from "../../src/lib/use-api";
import { fetchJson } from "../../src/lib/client";
import { AsyncBoundary } from "../../src/components/AsyncBoundary";
import { Card, Badge, SeverityBadge, PolicyBadge, EmptyState } from "../../src/components/primitives";
import { ConfirmDialog } from "../../src/components/Drawer";
import { useToast } from "../../src/components/Toast";
import { formatMoney } from "../../src/lib/money";
import { formatRelative, humanizeToken } from "../../src/lib/format";
import { friendlyError } from "../../src/lib/errors";
import type { ApprovalItem, MoneyMeta } from "../../src/lib/types";

interface ApprovalsResponse {
  money: MoneyMeta;
  items: ApprovalItem[];
}

export default function ApprovalsPage() {
  const { data, error, loading, reload } = useApi<ApprovalsResponse>("/api/recoveros/approvals");
  const toast = useToast();
  const [target, setTarget] = useState<ApprovalItem | null>(null);
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    if (!target) return;
    setBusy(true);
    const { error: apiErr } = await fetchJson(`/api/recoveros/approvals/${encodeURIComponent(target.actionId)}/approve`, {
      method: "POST",
    });
    setBusy(false);
    setTarget(null);
    if (apiErr) {
      toast.error("Approval failed", friendlyError(apiErr));
    } else {
      toast.success("Action approved", "The server authorized execution of this action.");
      reload();
    }
  };

  return (
    <div className="stack gap-16">
      <div className="page-head">
        <h1>Approval Center</h1>
        <p>Actions that policy routed to a human. Approval is enforced server-side — the browser never authorizes.</p>
      </div>

      <AsyncBoundary
        loading={loading}
        error={error}
        data={data}
        onRetry={reload}
        isEmpty={(d) => d.items.length === 0}
        empty={<EmptyState icon="✔" title="No approvals pending" desc="Nothing is waiting for a human decision in this workspace." />}
      >
        {(d) => (
          <div className="stack gap-12">
            {d.items.map((item) => (
              <Card key={item.actionId}>
                <div className="row gap-12" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row gap-8 mb-8">
                      <Badge variant="info">{humanizeToken(item.actionType)}</Badge>
                      <PolicyBadge decision={item.policyDecision} />
                      {item.policyVersion != null && <Badge variant="muted">Policy v{item.policyVersion}</Badge>}
                      <SeverityBadge severity={item.riskLevel} />
                    </div>
                    <div className="kv" style={{ maxWidth: 560 }}>
                      <dt>Customer</dt>
                      <dd>{item.customer ?? "—"}</dd>
                      <dt>Payment ref</dt>
                      <dd className="mono">{item.paymentRef ?? "—"}</dd>
                      <dt>Root cause</dt>
                      <dd>{humanizeToken(item.rootCause)}</dd>
                      <dt>Gemini strategy</dt>
                      <dd>{item.geminiStrategy ? humanizeToken(item.geminiStrategy) : "—"}</dd>
                    </div>
                    {item.geminiRationale && (
                      <p className="muted mt-8" style={{ fontSize: 12.5, maxWidth: 620 }}>
                        “{item.geminiRationale}”
                      </p>
                    )}
                  </div>
                  <div className="stack gap-8" style={{ alignItems: "flex-end", whiteSpace: "nowrap" }}>
                    <div className="tabnum" style={{ fontSize: 20, fontWeight: 720 }}>
                      {formatMoney(item.amountMinor, { currency: item.currency })}
                    </div>
                    <div className="faint" style={{ fontSize: 12 }}>opened {formatRelative(item.openedAt)}</div>
                    <div className="row gap-8">
                      <Link href={`/cases/${item.caseId}`} className="btn btn--sm">
                        Review
                      </Link>
                      <button className="btn btn--success btn--sm" onClick={() => setTarget(item)} type="button">
                        Approve
                      </button>
                    </div>
                    <button className="btn btn--sm" disabled title="Server-side reject is not available in this phase; approvals are server-authoritative." type="button">
                      Reject
                    </button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </AsyncBoundary>

      <ConfirmDialog
        open={target !== null}
        title="Approve this recovery action?"
        description={
          target
            ? `This authorizes the server to execute a ${humanizeToken(target.actionType)} for ${formatMoney(target.amountMinor, { currency: target.currency })}. Execution happens in Test Mode; no real money moves.`
            : ""
        }
        confirmLabel="Approve"
        busy={busy}
        onConfirm={approve}
        onCancel={() => setTarget(null)}
      />
    </div>
  );
}
