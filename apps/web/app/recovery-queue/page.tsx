"use client";
import React, { useState } from "react";
import Link from "next/link";
import { useApi } from "../../src/lib/use-api";
import { AsyncBoundary } from "../../src/components/AsyncBoundary";
import { Card, CaseStatusBadge, SeverityBadge, Badge, EmptyState } from "../../src/components/primitives";
import { LifecycleIndicator } from "../../src/components/LifecycleIndicator";
import { formatMoney } from "../../src/lib/money";
import { formatRelative, humanizeToken } from "../../src/lib/format";
import { priorityVariant } from "../../src/lib/badges";
import type { CaseListDTO, CaseListItemDTO } from "../../src/lib/types";

const OPEN_ONLY = new Set(["DETECTED", "ANALYZING", "PROPOSED", "PENDING_APPROVAL", "AUTHORIZED", "EXECUTING"]);

export default function RecoveryQueuePage() {
  const [showResolved, setShowResolved] = useState(false);
  const { data, error, loading, reload } = useApi<CaseListDTO>("/api/recoveros/cases?pageSize=100&sort=priority");

  return (
    <div className="stack gap-16">
      <div className="page-head">
        <h1>Recovery Queue</h1>
        <p>An operator&apos;s worklist: what happened, why money is at risk, and what to do next.</p>
      </div>

      <div className="row gap-8">
        <button className={`btn btn--sm${!showResolved ? " btn--primary" : ""}`} onClick={() => setShowResolved(false)} type="button">
          Open work
        </button>
        <button className={`btn btn--sm${showResolved ? " btn--primary" : ""}`} onClick={() => setShowResolved(true)} type="button">
          All cases
        </button>
      </div>

      <AsyncBoundary
        loading={loading}
        error={error}
        data={data}
        onRetry={reload}
        isEmpty={(d) => d.items.length === 0}
        empty={<EmptyState icon="✅" title="Queue is empty" desc="No recovery cases for this workspace yet. Run the intelligence batch to populate seeded cases." />}
      >
        {(d) => {
          const items = showResolved ? d.items : d.items.filter((c) => OPEN_ONLY.has(c.status));
          if (items.length === 0) {
            return <EmptyState icon="✅" title="All caught up" desc="There is no open recovery work in this workspace right now." />;
          }
          return (
            <div className="stack gap-12">
              {items.map((c) => (
                <QueueCard key={c.id} c={c} />
              ))}
            </div>
          );
        }}
      </AsyncBoundary>
    </div>
  );
}

function QueueCard({ c }: { c: CaseListItemDTO }) {
  return (
    <Card>
      <div className="row gap-12" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div className="row gap-8 mb-8">
            <CaseStatusBadge status={c.status} />
            <SeverityBadge severity={c.severity} />
            <Badge variant={priorityVariant(c.priorityScore)}>Priority {c.priorityScore ?? "—"}</Badge>
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 12, maxWidth: 720 }}>
            <QA q="What happened?" a={humanizeToken(c.reason)} />
            <QA q="Why at risk?" a={`${formatMoney(c.amountAtRiskMinor, { currency: c.currency })} unpaid`} />
            <QA q="Root cause" a={humanizeToken(c.rootCause)} />
          </div>
          <div className="mt-16">
            <div className="section-title" style={{ marginBottom: 6 }}>Recovery lifecycle</div>
            <LifecycleIndicator status={c.status} />
          </div>
        </div>
        <div className="stack gap-8" style={{ alignItems: "flex-end", whiteSpace: "nowrap" }}>
          <div className="tabnum" style={{ fontSize: 18, fontWeight: 700 }}>
            {formatMoney(c.amountAtRiskMinor, { currency: c.currency })}
          </div>
          <div className="faint" style={{ fontSize: 12 }}>{formatRelative(c.lastDetectedAt ?? c.openedAt)}</div>
          <Link href={`/cases/${c.id}`} className="btn btn--primary btn--sm">
            Open case →
          </Link>
          <div className="faint" style={{ fontSize: 11 }}>AI strategy & policy inside</div>
        </div>
      </div>
    </Card>
  );
}

function QA({ q, a }: { q: string; a: string }) {
  return (
    <div>
      <div className="faint" style={{ fontSize: 11.5, fontWeight: 600 }}>{q}</div>
      <div style={{ fontWeight: 600, marginTop: 2 }}>{a}</div>
    </div>
  );
}
