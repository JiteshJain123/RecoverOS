/**
 * Pure presentational views for the Evaluations page. No hooks, no next/* — safe
 * to unit-test. Everything rendered here is DERIVED from the server's
 * authoritative deterministic evaluation (batch metrics + safety report); nothing
 * is computed or invented client-side.
 */
import React from "react";
import { Badge } from "./primitives";
import { formatMoney } from "../lib/money";
import type { SafetyEvidenceRow } from "../lib/types";

/** Section 2 — safety guarantees, each backed by an actual failure-lab run. */
export function SafetyEvidenceList({ evidence }: { evidence: SafetyEvidenceRow[] }) {
  return (
    <div>
      {evidence.map((e) => (
        <div className="inv-row" key={e.id}>
          <span className="inv-row__mark" style={{ color: e.holds ? "var(--success)" : "var(--danger)" }}>
            {e.holds ? "✓" : "✕"}
          </span>
          <span style={{ flex: 1 }}>
            {e.statement}
            <span className="faint" style={{ display: "block", fontSize: 11.5 }}>
              {e.evidence} · <span className="mono">{e.scenarioId}</span>
            </span>
          </span>
          <Badge variant={e.holds ? "success" : "danger"}>{e.holds ? "verified" : "FAILED"}</Badge>
        </div>
      ))}
    </div>
  );
}

/**
 * Section 4 — distinguish revenue at risk vs verified recovered vs still at risk.
 * The bar segments are display-only proportions of the (server-computed) totals.
 */
export function RevenueBreakdown({
  atRiskMinor,
  recoveredMinor,
  stillAtRiskMinor,
  currency,
}: {
  atRiskMinor: number;
  recoveredMinor: number;
  stillAtRiskMinor: number;
  currency: string;
}) {
  const total = Math.max(1, atRiskMinor);
  const recoveredPct = Math.round((recoveredMinor / total) * 100);
  const money = { currency };
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <span className="faint" style={{ fontSize: 12 }}>
          Total revenue at risk: <strong className="tabnum">{formatMoney(atRiskMinor, money)}</strong>
        </span>
        <span className="faint" style={{ fontSize: 12 }}>
          {recoveredPct}% verified recovered
        </span>
      </div>
      <div className="rev-bar" role="img" aria-label="Revenue recovered vs still at risk">
        <div
          className="rev-bar__seg rev-bar__seg--recovered"
          style={{ width: `${recoveredMinor > 0 ? Math.max(recoveredPct, 2) : 0}%` }}
          title={`Verified recovered: ${formatMoney(recoveredMinor, money)}`}
        />
        <div className="rev-bar__seg rev-bar__seg--risk" style={{ flex: 1 }} title={`Still at risk: ${formatMoney(stillAtRiskMinor, money)}`} />
      </div>
      <div className="row gap-16 mt-8" style={{ fontSize: 12 }}>
        <span className="row gap-4">
          <span className="rev-dot rev-dot--recovered" /> Verified recovered{" "}
          <strong className="tabnum">{formatMoney(recoveredMinor, money)}</strong>
        </span>
        <span className="row gap-4">
          <span className="rev-dot rev-dot--risk" /> Still at risk{" "}
          <strong className="tabnum">{formatMoney(stillAtRiskMinor, money)}</strong>
        </span>
      </div>
    </div>
  );
}
