/**
 * Lightweight SVG trend chart (pure, no chart library). Renders daily at-risk vs
 * recovered amounts (minor units) as grouped bars. Uses real seeded data only.
 */
import React from "react";
import type { FunnelTrendPoint, MoneyMeta } from "../lib/types";
import { formatMoneyCompact } from "../lib/money";
import { formatDay } from "../lib/format";

export function TrendChart({ trend, money }: { trend: FunnelTrendPoint[]; money: MoneyMeta }) {
  if (!trend || trend.length === 0) {
    return <div className="chart-empty">No trend data for this workspace yet.</div>;
  }
  const points = trend.slice(-14); // most recent 14 buckets
  const W = 640;
  const H = 180;
  const padL = 8;
  const padR = 8;
  const padB = 26;
  const padT = 10;
  const innerW = W - padL - padR;
  const innerH = H - padB - padT;
  const max = Math.max(1, ...points.map((p) => Math.max(p.atRiskMinor, p.recoveredMinor)));
  const slot = innerW / points.length;
  const barW = Math.min(14, slot / 3);

  const y = (v: number) => padT + innerH - (v / max) * innerH;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Recovery trend">
        <line x1={padL} y1={padT + innerH} x2={W - padR} y2={padT + innerH} stroke="var(--border)" />
        {points.map((p, i) => {
          const cx = padL + slot * i + slot / 2;
          return (
            <g key={p.date}>
              <rect
                x={cx - barW - 1}
                y={y(p.atRiskMinor)}
                width={barW}
                height={padT + innerH - y(p.atRiskMinor)}
                rx={2}
                fill="var(--brand)"
                opacity={0.85}
              >
                <title>{`${p.date}: ${formatMoneyCompact(p.atRiskMinor, money)} at risk`}</title>
              </rect>
              <rect
                x={cx + 1}
                y={y(p.recoveredMinor)}
                width={barW}
                height={padT + innerH - y(p.recoveredMinor)}
                rx={2}
                fill="var(--success)"
              >
                <title>{`${p.date}: ${formatMoneyCompact(p.recoveredMinor, money)} recovered`}</title>
              </rect>
              {(i === 0 || i === points.length - 1 || i === Math.floor(points.length / 2)) && (
                <text x={cx} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--text-faint)">
                  {formatDay(p.date + "T00:00:00.000Z")}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="pill-row mt-8" style={{ fontSize: 12 }}>
        <span className="row gap-4">
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--brand)", display: "inline-block" }} /> At risk
        </span>
        <span className="row gap-4">
          <span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--success)", display: "inline-block" }} /> Recovered
        </span>
      </div>
    </div>
  );
}
