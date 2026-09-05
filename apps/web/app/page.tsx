"use client";
import React from "react";
import Link from "next/link";
import { useApi } from "../src/lib/use-api";
import { AsyncBoundary } from "../src/components/AsyncBoundary";
import { MetricCard } from "../src/components/MetricCard";
import { FunnelChart } from "../src/components/FunnelChart";
import { TrendChart } from "../src/components/TrendChart";
import { Card, CaseStatusBadge, Badge } from "../src/components/primitives";
import { AiBoundaryStrip, VerifiedRecoveryLegend } from "../src/components/FlowViews";
import { formatMoney, formatMoneyCompact, formatRate } from "../src/lib/money";
import { formatRelative } from "../src/lib/format";
import { groupAttention } from "../src/lib/attention";
import type { CaseListDTO, CaseListItemDTO, FunnelDTO, IntelligenceSummaryDTO } from "../src/lib/types";

export default function OverviewPage() {
  const summary = useApi<IntelligenceSummaryDTO>("/api/recoveros/summary");
  const funnel = useApi<FunnelDTO>("/api/recoveros/funnel");
  const cases = useApi<CaseListDTO>("/api/recoveros/cases?pageSize=100&sort=priority");

  return (
    <div className="stack gap-16">
      <div className="hero">
        <h2>RecoverOS finds revenue at risk and safely recovers it.</h2>
        <p>
          Detect revenue at risk → Gemini recommends recovery → deterministic policy decides → only permitted actions
          execute → the outcome is verified → revenue is credited <strong>only when recovery is proven</strong>.
        </p>
        <div className="hero__legend">
          <VerifiedRecoveryLegend />
        </div>
      </div>

      <AsyncBoundary
        loading={summary.loading}
        error={summary.error}
        data={summary.data}
        onRetry={summary.reload}
        loadingRows={3}
      >
        {(s) => <OverviewMetrics summary={s} />}
      </AsyncBoundary>

      <Card title="How every recovery is decided">
        <AiBoundaryStrip />
      </Card>

      <div className="grid grid--2">
        <Card title="Revenue Recovery Funnel">
          <AsyncBoundary loading={funnel.loading} error={funnel.error} data={funnel.data} onRetry={funnel.reload}>
            {(f) => <FunnelChart stages={f.stages} money={f.money} />}
          </AsyncBoundary>
        </Card>
        <Card title="Recovery Trend (daily)">
          <AsyncBoundary loading={funnel.loading} error={funnel.error} data={funnel.data} onRetry={funnel.reload}>
            {(f) => <TrendChart trend={f.trend} money={f.money} />}
          </AsyncBoundary>
        </Card>
      </div>

      <Card title="Needs Attention">
        <AsyncBoundary loading={cases.loading} error={cases.error} data={cases.data} onRetry={cases.reload}>
          {(list) => <NeedsAttention list={list} />}
        </AsyncBoundary>
      </Card>
    </div>
  );
}

function OverviewMetrics({ summary: s }: { summary: IntelligenceSummaryDTO }) {
  return (
    <div className="stack gap-16">
      {/* The two figures a judge must contrast instantly: money still at risk
          vs money we have PROVABLY recovered. */}
      <div className="kpi-hero">
        <div className="kpi-panel kpi-panel--risk">
          <div className="kpi-panel__label">⚠ Revenue at Risk</div>
          <div className="kpi-panel__value">{formatMoney(s.revenueAtRiskMinor, s.money)}</div>
          <div className="kpi-panel__sub">Detected failed &amp; abandoned payments that have not yet been recovered.</div>
          <div className="kpi-panel__foot">
            <span className="muted">
              <b>{s.affectedPayments}</b> payments
            </span>
            <span className="muted">
              <b>{s.affectedCustomers}</b> customers
            </span>
          </div>
        </div>
        <div className="kpi-panel kpi-panel--recovered">
          <div className="kpi-panel__label">✔ Verified Recovered Revenue</div>
          <div className="kpi-panel__value">{formatMoney(s.recoveredRevenueMinor, s.money)}</div>
          <div className="kpi-panel__sub">Credited only on a proven capture — never a payment link or an HTTP 200.</div>
          <div className="kpi-panel__foot">
            <span className="muted">
              Verified recovery rate <b>{formatRate(s.recoverySuccessRate)}</b>
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid--metrics">
        <MetricCard
          label="Verified Recovery Rate"
          icon="↺"
          accent="info"
          value={formatRate(s.recoverySuccessRate)}
          sub="Recovered ÷ (recovered + failed)"
        />
        <MetricCard label="High-priority Cases" icon="▲" accent="warning" value={s.highPriorityCases} sub="Open, priority ≥ 70" />
        <MetricCard label="Awaiting Approval / Review" icon="⧖" accent="warning" value={s.reviewRequiredCases} sub="Held for a human decision" />
      </div>
    </div>
  );
}

function NeedsAttention({ list }: { list: CaseListDTO }) {
  const buckets = groupAttention(list.items);
  const groups: Array<{ title: string; items: CaseListItemDTO[]; tone: "danger" | "warning" | "info" }> = [
    { title: "High priority", items: buckets.highPriority, tone: "warning" },
    { title: "Pending approvals", items: buckets.pendingApprovals, tone: "info" },
    { title: "Failed recoveries", items: buckets.failedRecoveries, tone: "danger" },
    { title: "Policy blocks", items: buckets.policyBlocks, tone: "danger" },
  ];
  const anything = groups.some((g) => g.items.length > 0);
  if (!anything) {
    return <div className="faint">Nothing needs attention right now — all clear.</div>;
  }
  return (
    <div className="grid grid--2">
      {groups.map((g) => (
        <div key={g.title}>
          <div className="row gap-8 mb-8">
            <Badge variant={g.tone}>{g.items.length}</Badge>
            <span className="section-title" style={{ margin: 0 }}>
              {g.title}
            </span>
          </div>
          {g.items.length === 0 ? (
            <div className="faint" style={{ fontSize: 12.5 }}>
              None.
            </div>
          ) : (
            g.items.map((c) => (
              <Link key={c.id} href={`/cases/${c.id}`} className="attention-item">
                <CaseStatusBadge status={c.status} />
                <span className="tabnum" style={{ fontWeight: 600 }}>
                  {formatMoneyCompact(c.amountAtRiskMinor, { currency: c.currency })}
                </span>
                <span className="faint" style={{ marginLeft: "auto", fontSize: 12 }}>
                  {formatRelative(c.lastDetectedAt ?? c.openedAt)}
                </span>
              </Link>
            ))
          )}
        </div>
      ))}
    </div>
  );
}
