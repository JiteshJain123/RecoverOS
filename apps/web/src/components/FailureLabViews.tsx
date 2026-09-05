/**
 * Pure presentational views for the Failure Lab. No hooks, no next/* — safe to
 * unit-test. Everything rendered here is DERIVED from the server's authoritative
 * run (stages, safety, invariants, stats); nothing is invented client-side.
 */
import React from "react";
import type { BadgeVariant } from "../lib/badges";
import { Badge } from "./primitives";
import { MetricCard } from "./MetricCard";
import { formatMoney } from "../lib/money";
import { humanizeToken } from "../lib/format";
import type { FailureLabStage, InvariantResult, FailureLabStats, SafetyResult, StageStatus } from "../lib/types";

const STAGE_MARK: Record<StageStatus, string> = {
  ok: "✓",
  info: "•",
  blocked: "■",
  failed: "✕",
  skipped: "–",
  pending: "⧖",
};

/** C. Live execution trace — the 11 canonical stages as a connected timeline. */
export function StageTrace({ stages }: { stages: FailureLabStage[] }) {
  // The stopping point is the first stage that blocked or failed — the moment the
  // scenario stopped safely. Highlight it so a judge sees exactly where it halted.
  const stopIndex = stages.findIndex((s) => s.status === "blocked" || s.status === "failed");
  return (
    <div className="stage-trace">
      {stages.map((s, i) => (
        <div className={`stage-item${i === stopIndex ? " stage-item--stop" : ""}`} key={s.key}>
          <div className="stage-item__rail">
            <span className={`stage-item__node st--${s.status}`} title={s.status}>
              {STAGE_MARK[s.status]}
            </span>
            {i < stages.length - 1 && <span className="stage-item__line" />}
          </div>
          <div className="stage-item__body">
            <div className="stage-item__head">
              <span className="stage-item__label">
                {s.order}. {s.label}
              </span>
              <Badge variant={stageVariant(s.status)}>{s.status}</Badge>
              {i === stopIndex && <Badge variant="danger">Stopped here</Badge>}
            </div>
            <div className="stage-row__detail">{s.detail}</div>
            {s.meta && Object.keys(s.meta).length > 0 && (
              <div className="stage-row__meta">
                {Object.entries(s.meta)
                  .filter(([, v]) => v !== null && v !== undefined && v !== "")
                  .map(([k, v]) => (
                    <span className="stage-chip" key={k}>
                      {humanizeToken(k)}: {String(v)}
                    </span>
                  ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function stageVariant(status: StageStatus): BadgeVariant {
  switch (status) {
    case "ok":
      return "success";
    case "info":
      return "info";
    case "blocked":
    case "failed":
      return "danger";
    case "pending":
      return "warning";
    default:
      return "muted";
  }
}

/** D. Safety result — the headline behavior, in plain language. */
export function SafetyCard({ safety }: { safety: SafetyResult }) {
  return (
    <div className={`safety-card safety-card--${safety.tone}`} role="status">
      <div className="safety-card__headline">{safety.headline}</div>
      <div className="safety-card__result">
        Result: {safety.result}
        {"  "}
        <Badge variant={safety.credited ? "success" : "muted"}>
          {safety.credited ? "Revenue credited" : "No revenue credited"}
        </Badge>
      </div>
      <div className="safety-card__reason">Reason: {safety.reason}</div>
    </div>
  );
}

/** E. Security invariants — computed from the actual run, not hardcoded. */
export function InvariantList({ invariants }: { invariants: InvariantResult[] }) {
  return (
    <div>
      {invariants.map((inv) => (
        <div className={`inv-row${inv.applicable ? "" : " inv-row--na"}`} key={inv.id}>
          <span
            className="inv-row__mark"
            style={{ color: !inv.applicable ? "var(--text-faint)" : inv.holds ? "var(--success)" : "var(--danger)" }}
          >
            {!inv.applicable ? "–" : inv.holds ? "✓" : "✕"}
          </span>
          <span style={{ flex: 1 }}>{inv.statement}</span>
          <span className="faint" style={{ fontSize: 12 }}>
            {inv.applicable ? inv.detail : "not exercised"}
          </span>
        </div>
      ))}
    </div>
  );
}

/** F. Failure statistics for the current run. */
export function StatsGrid({ stats }: { stats: FailureLabStats }) {
  const money = { currency: stats.currency };
  return (
    <div className="grid grid--metrics">
      <MetricCard label="Provider calls" value={stats.providerCalls} accent="info" icon="↔" />
      <MetricCard label="Webhook events" value={stats.webhookEvents} accent="neutral" icon="✉" />
      <MetricCard label="Duplicate events ignored" value={stats.duplicateEventsIgnored} accent="info" icon="⧉" />
      <MetricCard label="Actions prevented" value={stats.actionsPrevented} accent="warning" icon="⛔" />
      <MetricCard label="Invalid success claims prevented" value={stats.invalidSuccessClaimsPrevented} accent="warning" icon="🛡" />
      <MetricCard
        label="Revenue credited"
        value={formatMoney(stats.revenueCreditedMinor, money)}
        accent={stats.revenueCreditedMinor > 0 ? "success" : "muted"}
        icon="✔"
      />
      <MetricCard label="Revenue left at risk" value={formatMoney(stats.revenueLeftAtRiskMinor, money)} accent="danger" icon="⚠" />
    </div>
  );
}
