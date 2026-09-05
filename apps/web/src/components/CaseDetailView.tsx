/**
 * Pure presentational view of a full recovery case (sections A–G). Fetching and
 * the "generate recommendation" action are owned by the page; this only renders
 * what the application schema actually returned — no hidden chain-of-thought,
 * no fabricated fields (missing data shows "—").
 */
import React from "react";
import type { CaseDetailDTO } from "../lib/types";
import { Card, CaseStatusBadge, SeverityBadge, PolicyBadge, Badge } from "./primitives";
import { Timeline, type TimelineItem } from "./Timeline";
import { LifecycleIndicator } from "./LifecycleIndicator";
import { AiBoundaryStrip } from "./FlowViews";
import { formatMoney } from "../lib/money";
import { formatDateTime, humanizeToken } from "../lib/format";
import { redactedJson } from "../lib/redact";
import { priorityVariant } from "../lib/badges";


export function CaseDetailView({
  detail,
  onGenerate,
  generating,
}: {
  detail: CaseDetailDTO;
  onGenerate?: () => void;
  generating?: boolean;
}) {
  const decision = detail.recoveryDecisions[0] ?? null;
  const action = detail.recoveryActions[0] ?? null;
  const primarySignal = detail.detectedSignals[0] ?? null;
  const recovered = detail.status === "RECOVERED";

  const eventItems: TimelineItem[] = detail.eventTimeline.map((e, i) => ({
    id: `${e.rawType}-${i}`,
    title: humanizeToken(e.eventType),
    meta: `${e.rawType} · ${formatDateTime(e.occurredAt)}`,
  }));

  const auditItems: TimelineItem[] = detail.auditHistory.map((a) => ({
    id: a.id,
    title: `${a.actorType} · ${humanizeToken(a.action)}`,
    meta: formatDateTime(a.createdAt),
    detail: a.summary ? <span className="muted">{a.summary}</span> : undefined,
  }));

  return (
    <div className="stack gap-16">
      {/* Centerpiece: the recovery lifecycle + the money at stake. */}
      <Card>
        <div className="row gap-12" style={{ justifyContent: "space-between", flexWrap: "wrap", alignItems: "flex-start" }}>
          <div>
            <div className="row gap-8" style={{ flexWrap: "wrap" }}>
              <CaseStatusBadge status={detail.status} />
              <SeverityBadge severity={detail.severity} />
              <Badge variant={priorityVariant(detail.priorityScore)}>Priority {detail.priorityScore ?? "—"}</Badge>
            </div>
            <div className="mono faint mt-8" style={{ fontSize: 12 }}>{detail.id}</div>
          </div>
          <div style={{ textAlign: "right", minWidth: 160 }}>
            <div
              style={{
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                fontWeight: 700,
                color: recovered ? "var(--success)" : "var(--danger)",
              }}
            >
              {recovered ? "Verified Recovered" : "Revenue at Risk"}
            </div>
            <div className="tabnum" style={{ fontSize: 26, fontWeight: 760, color: recovered ? "var(--success)" : "var(--text)" }}>
              {formatMoney(detail.amountAtRiskMinor, detail.money)}
            </div>
          </div>
        </div>
        <div className="mt-16">
          <div className="section-title" style={{ marginBottom: 8 }}>Recovery lifecycle</div>
          <LifecycleIndicator status={detail.status} />
        </div>
      </Card>

      <div className="grid grid--2">
        {/* A. Revenue summary */}
        <Card title="A · Revenue summary">
          <dl className="kv">
            <dt>Amount at risk</dt>
            <dd className="tabnum" style={{ fontWeight: 700 }}>{formatMoney(detail.amountAtRiskMinor, detail.money)}</dd>
            <dt>Currency</dt>
            <dd>{detail.currency}</dd>
            <dt>Customer</dt>
            <dd>{detail.customer?.name ?? detail.customer?.email ?? "—"}</dd>
            <dt>Payment</dt>
            <dd className="mono">{detail.payment?.paymentRef ?? detail.payment?.id ?? "—"}</dd>
            <dt>Payment status</dt>
            <dd>{detail.payment ? humanizeToken(detail.payment.status) : "—"}</dd>
            <dt>Current state</dt>
            <dd><CaseStatusBadge status={detail.status} /></dd>
            <dt>Opened</dt>
            <dd>{formatDateTime(detail.openedAt)}</dd>
          </dl>
        </Card>

        {/* C. Intelligence */}
        <Card title="C · Intelligence">
          <dl className="kv">
            <dt>Root cause</dt>
            <dd>{humanizeToken(detail.rootCause)}</dd>
            <dt>Confidence</dt>
            <dd>{primarySignal ? `${Math.round(primarySignal.confidence * 100)}%` : "—"}</dd>
            <dt>Priority score</dt>
            <dd>{detail.priorityScore ?? "—"}</dd>
            <dt>Recovery candidate</dt>
            <dd>{detail.detectedSignals.length > 0 ? "Yes" : "—"}</dd>
            <dt>Detection rule</dt>
            <dd className="mono">{detail.detectionRuleVersion ?? "—"}</dd>
          </dl>
          {primarySignal && (
            <details className="disclose mt-16">
              <summary className="disclose__summary">Detection evidence</summary>
              <pre className="mono" style={{ background: "var(--surface-2)", padding: 12, borderRadius: 8, overflowX: "auto", fontSize: 11.5, marginTop: 8 }}>
                {redactedJson(primarySignal.evidence)}
              </pre>
            </details>
          )}
        </Card>
      </div>

      {/* B. Payment timeline */}
      <Card title="B · Payment timeline">
        <Timeline items={eventItems} />
      </Card>

      {/* AI boundary — Gemini advises, policy decides, execution acts. */}
      <Card title="The AI boundary">
        <AiBoundaryStrip />
      </Card>

      {/* D. Gemini decision */}
      <Card
        title="D · Gemini decision"
        action={
          onGenerate ? (
            <button className="btn btn--sm btn--primary" onClick={onGenerate} disabled={generating} type="button">
              {generating ? "Generating…" : decision ? "Regenerate" : "Generate recommendation"}
            </button>
          ) : null
        }
      >
        {decision ? (
          <dl className="kv">
            <dt>Recommended strategy</dt>
            <dd><Badge variant="info">{humanizeToken(decision.proposedAction)}</Badge></dd>
            <dt>Confidence</dt>
            <dd>{Math.round(decision.confidence * 100)}%</dd>
            <dt>Diagnosis</dt>
            <dd>{decision.diagnosis || "—"}</dd>
            <dt>Rationale</dt>
            <dd>{decision.rationale || "—"}</dd>
            {decision.amountMinor != null && (
              <>
                <dt>Proposed amount</dt>
                <dd className="tabnum">{formatMoney(decision.amountMinor, detail.money)}</dd>
              </>
            )}
            <dt>Generated</dt>
            <dd>{formatDateTime(decision.createdAt)}</dd>
          </dl>
        ) : (
          <div className="faint">
            No AI recommendation recorded yet. Gemini is advisory — it proposes a strategy but never executes.
          </div>
        )}
      </Card>

      <div className="grid grid--2">
        {/* E. Policy decision */}
        <Card title="E · Policy decision">
          {action ? (
            <dl className="kv">
              <dt>Decision</dt>
              <dd><PolicyBadge decision={action.policyDecision} /></dd>
              <dt>Policy version</dt>
              <dd>{action.policyVersion != null ? `v${action.policyVersion}` : "—"}</dd>
              <dt>Risk level</dt>
              <dd><SeverityBadge severity={detail.severity} /></dd>
              <dt>Approval required</dt>
              <dd>{(action.policyDecision ?? "").toUpperCase() === "REVIEW" ? "Yes" : "No"}</dd>
            </dl>
          ) : (
            <div className="faint">No policy decision recorded for this case yet.</div>
          )}
        </Card>

        {/* F. Recovery action */}
        <Card title="F · Recovery action">
          {action ? (
            <dl className="kv">
              <dt>Action type</dt>
              <dd>{humanizeToken(action.type)}</dd>
              <dt>Status</dt>
              <dd>{humanizeToken(action.status)}</dd>
              <dt>Amount</dt>
              <dd className="tabnum">{action.amountMinor != null ? formatMoney(action.amountMinor, { currency: action.currency }) : "—"}</dd>
              <dt>Provider reference</dt>
              <dd className="mono">{action.externalReference ?? "—"}</dd>
              <dt>Idempotency</dt>
              <dd>{action.idempotencyKey ? "Keyed (at-most-once)" : "—"}</dd>
            </dl>
          ) : (
            <div className="faint">No recovery action has been created for this case.</div>
          )}
        </Card>
      </div>

      {/* G. Audit timeline */}
      <Card title="G · Audit timeline">
        <Timeline items={auditItems} />
      </Card>
    </div>
  );
}
